import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { parseLockfile, toLockfileGraph } from '@npm-alert-triage/core/lockfile';
import { ingestOsvPath, matchScanAlerts } from './index.js';
import { MAX_OSV_DETAILS_LENGTH } from './osv/schema.js';
import { query } from '@npm-alert-triage/storage/db';
import { persistLockfileGraph } from '@npm-alert-triage/storage/dependency-graph';

interface ScanHandle {
  readonly userId: string;
  readonly scanId: string;
}

interface AlertRow {
  readonly advisory_id: string;
  readonly lock_path: string;
  readonly match_kind: string;
  readonly matched_detail: { reason?: string };
}

interface AffectedRow {
  readonly package_name: string;
  readonly ranges: unknown[];
  readonly versions: string[];
}

const scans: ScanHandle[] = [];
const advisoryIds = [
  'TEST-MERGE-SAME-PACKAGE',
  'TEST-NESTED-COPY',
  'TEST-INTRODUCED-FIXED',
  'TEST-UNSUPPORTED-RANGE',
  'TEST-LIMIT-EVENT',
  'TEST-UNKNOWN-EVENT',
  'TEST-EMPTY-AFFECTED-ENTRY',
  'TEST-WITHDRAWN',
  'TEST-TRUNCATED-DETAILS',
];

async function clearTestData(): Promise<void> {
  for (const scan of scans) await query('DELETE FROM users WHERE id = $1', [scan.userId]);
  scans.length = 0;
  await query('DELETE FROM advisories WHERE id = ANY($1::text[])', [advisoryIds]);
}

function fixturePath(name: string): string {
  return resolve(process.cwd(), 'fixtures/advisories', name);
}

async function createScan(lockfileText: string): Promise<ScanHandle> {
  const userId = randomUUID();
  const scanId = randomUUID();
  const handle = { userId, scanId };
  scans.push(handle);
  await query('INSERT INTO users (id, email) VALUES ($1, $2)', [userId, `${userId}@example.test`]);
  await query("INSERT INTO scans (id, user_id, status, source) VALUES ($1, $2, 'completed', 'lockfile')", [
    scanId,
    userId,
  ]);
  await persistLockfileGraph(scanId, toLockfileGraph(parseLockfile(lockfileText)));
  return handle;
}

function testLockfile(name: string, version: string): string {
  return JSON.stringify({
    lockfileVersion: 3,
    packages: {
      '': { dependencies: { [name]: version } },
      [`node_modules/${name}`]: { version },
    },
  });
}

async function alertRows(scanId: string): Promise<AlertRow[]> {
  const result = await query<AlertRow>(
    `SELECT alert.advisory_id, instance.lock_path, alert.match_kind, alert.matched_detail
     FROM scan_alerts alert
     JOIN scan_package_instances instance ON instance.id = alert.instance_id
     WHERE alert.scan_id = $1
     ORDER BY alert.advisory_id, instance.lock_path`,
    [scanId],
  );
  return result.rows;
}

describe('OSV ingestion and scan alert matching (PostgreSQL integration)', () => {
  beforeEach(async () => {
    await clearTestData();
  });

  afterAll(async () => {
    await clearTestData();
  });

  it('ingests idempotently, merges duplicate package entries, and normalizes stored names', async () => {
    expect(process.env.DATABASE_URL, 'DATABASE_URL must be set for integration tests').toBeTruthy();
    const first = await ingestOsvPath(fixturePath('merge-same-package.json'));
    const second = await ingestOsvPath(fixturePath('merge-same-package.json'));
    expect(first).toMatchObject({ inserted: 1, updated: 0, skipped: 0 });
    expect(second).toMatchObject({ inserted: 0, updated: 1, skipped: 0 });

    const stored = await query<AffectedRow>(
      `SELECT package_name, ranges, versions FROM advisory_affected_packages
       WHERE advisory_id = $1`,
      ['TEST-MERGE-SAME-PACKAGE'],
    );
    expect(stored.rows).toEqual([{
      package_name: 'target-pkg',
      ranges: [
        { type: 'SEMVER', events: [{ introduced: '1.0.0' }, { fixed: '1.1.0' }] },
        { type: 'ECOSYSTEM', events: [{ introduced: '2.0.0' }, { fixed: '2.1.0' }] },
      ],
      versions: ['1.0.1', '1.0.2', '2.0.1'],
    }]);

    const scan = await createScan(testLockfile('TARGET-PKG', '1.0.2'));
    await matchScanAlerts(scan.scanId);
    expect(await alertRows(scan.scanId)).toMatchObject([
      { advisory_id: 'TEST-MERGE-SAME-PACKAGE', match_kind: 'range', lock_path: 'node_modules/TARGET-PKG' },
    ]);
    await matchScanAlerts(scan.scanId);
    expect(await alertRows(scan.scanId)).toHaveLength(1);
  });

  it('matches only the vulnerable nested copy of a package', async () => {
    const nestedFixture = await readFile(resolve(process.cwd(), 'fixtures/lockfiles/phase-2/nested-copies.json'), 'utf8');
    const scan = await createScan(nestedFixture);
    const advisory = await mkdtemp(join(tmpdir(), 'depwise-advisory-'));
    const advisoryRecord = {
      id: 'TEST-NESTED-COPY',
      summary: 'Nested package test',
      details: 'Only the 1.x nested copy is in the affected range.',
      affected: [{
        package: { ecosystem: 'npm', name: 'duplicate' },
        ranges: [{ type: 'SEMVER', events: [{ introduced: '0' }, { fixed: '2.0.0' }] }],
      }],
    };
    try {
      await writeFile(join(advisory, 'nested.json'), JSON.stringify(advisoryRecord), 'utf8');
      await ingestOsvPath(advisory);
    } finally {
      await rm(advisory, { recursive: true, force: true });
    }
    await matchScanAlerts(scan.scanId);
    expect(await alertRows(scan.scanId)).toEqual([{
      advisory_id: 'TEST-NESTED-COPY',
      lock_path: 'node_modules/host/node_modules/duplicate',
      match_kind: 'range',
      matched_detail: expect.objectContaining({}),
    }]);
  });

  it('keeps unevaluable advisory/instance pairs as uncertain and drops only evaluated non-matches', async () => {
    const uncertainFixtures = [
      { file: 'introduced-fixed.json', version: 'not-semver', id: 'TEST-INTRODUCED-FIXED' },
      { file: 'unsupported-range.json', version: '1.0.0', id: 'TEST-UNSUPPORTED-RANGE' },
      { file: 'limit-event.json', version: '1.0.0', id: 'TEST-LIMIT-EVENT' },
      { file: 'unknown-event.json', version: '1.0.0', id: 'TEST-UNKNOWN-EVENT' },
      { file: 'empty-affected-entry.json', version: '1.0.0', id: 'TEST-EMPTY-AFFECTED-ENTRY' },
    ];
    for (const item of uncertainFixtures) {
      await clearTestData();
      await ingestOsvPath(fixturePath(item.file));
      const scan = await createScan(testLockfile('target-pkg', item.version));
      await matchScanAlerts(scan.scanId);
      const rows = await alertRows(scan.scanId);
      expect(rows, `${item.file} must be retained`).toHaveLength(1);
      expect(rows[0]).toMatchObject({ advisory_id: item.id, match_kind: 'uncertain' });
      expect(rows[0]?.matched_detail.reason).toBeTruthy();
    }

    await clearTestData();
    await ingestOsvPath(fixturePath('introduced-fixed.json'));
    const evaluatedNonMatch = await createScan(testLockfile('target-pkg', '1.2.3'));
    await matchScanAlerts(evaluatedNonMatch.scanId);
    expect(await alertRows(evaluatedNonMatch.scanId)).toEqual([]);
  });

  it('excludes withdrawn advisories and reports details truncated during ingestion', async () => {
    const withdrawnIngest = await ingestOsvPath(fixturePath('withdrawn.json'));
    expect(withdrawnIngest.inserted + withdrawnIngest.updated).toBe(1);
    const withdrawnScan = await createScan(testLockfile('target-pkg', '1.0.0'));
    await matchScanAlerts(withdrawnScan.scanId);
    expect(await alertRows(withdrawnScan.scanId)).toEqual([]);

    const directory = await mkdtemp(join(tmpdir(), 'depwise-truncated-'));
    try {
      const source = JSON.parse(await readFile(fixturePath('introduced-fixed.json'), 'utf8')) as Record<string, unknown>;
      source.id = 'TEST-TRUNCATED-DETAILS';
      source.details = 'x'.repeat(MAX_OSV_DETAILS_LENGTH + 7);
      const file = join(directory, 'truncated.json');
      await writeFile(file, JSON.stringify(source), 'utf8');
      const report = await ingestOsvPath(directory);
      expect(report.truncatedDetails).toEqual([{
        source: file,
        id: 'TEST-TRUNCATED-DETAILS',
        originalLength: MAX_OSV_DETAILS_LENGTH + 7,
        storedLength: MAX_OSV_DETAILS_LENGTH,
      }]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
