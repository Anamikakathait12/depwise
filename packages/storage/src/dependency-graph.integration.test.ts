import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  LockfileGraphIntegrityError,
  parseLockfile,
  toLockfileGraph,
} from '@npm-alert-triage/core/lockfile';
import { close, query } from './db.js';
import { getPathsToPackage, isReachableViaProd, persistLockfileGraph } from './dependency-graph.js';

interface ScanHandle {
  readonly scanId: string;
  readonly userId: string;
}

interface IdRow {
  readonly id: string;
}

const createdScans: ScanHandle[] = [];

function readFixture(name: string): string {
  return readFileSync(resolve(process.cwd(), 'fixtures/lockfiles/phase-2', name), 'utf8');
}

async function persistFixture(input: string): Promise<ScanHandle> {
  const userId = randomUUID();
  const scanId = randomUUID();
  const handle = { userId, scanId };
  createdScans.push(handle);
  await query('INSERT INTO users (id, email) VALUES ($1, $2)', [userId, `${userId}@example.test`]);
  await query("INSERT INTO scans (id, user_id, status, source) VALUES ($1, $2, 'completed', 'lockfile')", [
    scanId,
    userId,
  ]);
  const graph = toLockfileGraph(parseLockfile(input));
  await persistLockfileGraph(scanId, graph);
  return handle;
}

async function packageId(scanId: string, name: string, version = '1.0.0'): Promise<string> {
  const result = await query<IdRow>(
    `SELECT instance.package_id AS id
     FROM scan_package_instances instance
     JOIN packages package ON package.id = instance.package_id
     WHERE instance.scan_id = $1 AND package.name = $2 AND package.version = $3
     LIMIT 1`,
    [scanId, name, version],
  );
  const id = result.rows[0]?.id;
  expect(id, `No installed package ${name}@${version} in scan ${scanId}`).toBeTruthy();
  return id ?? '';
}

describe('dependency graph storage and PostgreSQL traversal', () => {
  afterAll(async () => {
    for (const scan of createdScans) {
      await query('DELETE FROM users WHERE id = $1', [scan.userId]);
    }
    await close();
  });

  it('returns simple, diamond, cycle, dev-only, and mixed production/development paths', async () => {
    expect(process.env.DATABASE_URL, 'DATABASE_URL must be set for integration tests').toBeTruthy();

    const simple = await persistFixture(readFixture('simple-tree.json'));
    const leafId = await packageId(simple.scanId, 'leaf');
    expect((await getPathsToPackage(simple.scanId, leafId)).paths).toEqual([
      {
        lockPaths: ['node_modules/app', 'node_modules/leaf'],
        devOnly: false,
        lockfileIsDev: false,
      },
    ]);

    const diamond = await persistFixture(readFixture('diamond.json'));
    const sharedId = await packageId(diamond.scanId, 'shared');
    const diamondPaths = await getPathsToPackage(diamond.scanId, sharedId);
    expect(diamondPaths.paths).toHaveLength(2);
    expect(diamondPaths.paths.map((path) => path.lockPaths[0])).toEqual([
      'node_modules/left',
      'node_modules/right',
    ]);

    const cycle = await persistFixture(readFixture('cycle.json'));
    const aId = await packageId(cycle.scanId, 'a');
    expect((await getPathsToPackage(cycle.scanId, aId)).paths).toHaveLength(1);
    expect(await isReachableViaProd(cycle.scanId, aId)).toBe(true);

    const devOnly = await persistFixture(readFixture('dev-only-chain.json'));
    const utilId = await packageId(devOnly.scanId, 'util');
    expect((await getPathsToPackage(devOnly.scanId, utilId)).paths).toEqual([
      {
        lockPaths: ['node_modules/cli', 'node_modules/util'],
        devOnly: true,
        lockfileIsDev: true,
      },
    ]);
    expect(await isReachableViaProd(devOnly.scanId, utilId)).toBe(false);

    const mix = await persistFixture(readFixture('prod-dev-mix.json'));
    const mixSharedId = await packageId(mix.scanId, 'shared');
    const mixPaths = await getPathsToPackage(mix.scanId, mixSharedId);
    expect(mixPaths.paths.map((path) => path.devOnly).sort()).toEqual([false, true]);
    expect(await isReachableViaProd(mix.scanId, mixSharedId)).toBe(true);
  });

  it('stores nested instances independently and follows workspace links', async () => {
    const nested = await persistFixture(readFixture('nested-copies.json'));
    const duplicateInstances = await query<{ lock_path: string; version: string }>(
      `SELECT instance.lock_path, package.version
       FROM scan_package_instances instance
       JOIN packages package ON package.id = instance.package_id
       WHERE instance.scan_id = $1 AND package.name = 'duplicate'
       ORDER BY package.version`,
      [nested.scanId],
    );
    expect(duplicateInstances.rows).toEqual([
      { lock_path: 'node_modules/host/node_modules/duplicate', version: '1.0.0' },
      { lock_path: 'node_modules/duplicate', version: '2.0.0' },
    ]);

    const workspace = await persistFixture(readFixture('workspace-link.json'));
    const workspaceId = await packageId(workspace.scanId, 'workspace-lib', '1.2.0');
    expect((await getPathsToPackage(workspace.scanId, workspaceId)).paths).toEqual([
      {
        lockPaths: ['node_modules/workspace-lib'],
        devOnly: true,
        lockfileIsDev: true,
      },
    ]);
  });

  it('rolls back all graph writes when a graph edge is inconsistent', async () => {
    const userId = randomUUID();
    const scanId = randomUUID();
    createdScans.push({ userId, scanId });
    await query('INSERT INTO users (id, email) VALUES ($1, $2)', [userId, `${userId}@example.test`]);
    await query("INSERT INTO scans (id, user_id, status, source) VALUES ($1, $2, 'completed', 'lockfile')", [
      scanId,
      userId,
    ]);

    const base = toLockfileGraph(parseLockfile(readFixture('simple-tree.json')));
    const rollbackName = `rollback-probe-${scanId}`;
    const graph = {
      ...base,
      packages: [{ name: rollbackName, version: '1.0.0' }],
      instances: base.instances.map((instance) => ({ ...instance, name: rollbackName })),
      edges: [{ parentLockPath: null, childLockPath: 'missing/instance', depType: 'prod' as const }],
    };

    await expect(persistLockfileGraph(scanId, graph)).rejects.toBeInstanceOf(LockfileGraphIntegrityError);
    expect((await query<{ count: string }>(
      'SELECT count(*)::text AS count FROM scan_package_instances WHERE scan_id = $1',
      [scanId],
    )).rows[0]?.count).toBe('0');
    expect((await query<{ count: string }>(
      'SELECT count(*)::text AS count FROM packages WHERE name = $1',
      [rollbackName],
    )).rows[0]?.count).toBe('0');
  });

  it('returns a truncated result at the depth cap and at 100 paths', async () => {
    const simple = await persistFixture(readFixture('simple-tree.json'));
    const leafId = await packageId(simple.scanId, 'leaf');
    const appId = await packageId(simple.scanId, 'app');
    const depthResult = await getPathsToPackage(simple.scanId, leafId, 1);
    expect(depthResult.paths).toEqual([]);
    expect(depthResult.truncated).toBe(true);
    const rootAtCap = await getPathsToPackage(simple.scanId, appId, 1);
    expect(rootAtCap.paths).toHaveLength(1);
    expect(rootAtCap.truncated).toBe(false);

    const pathOrder = await persistFixture(JSON.stringify({
      lockfileVersion: 3,
      packages: {
        '': { dependencies: { direct: '1.0.0', parent: '1.0.0' } },
        'node_modules/direct': { version: '1.0.0' },
        'node_modules/parent': { version: '1.0.0', dependencies: { direct: '1.0.0' } },
      },
    }));
    const directId = await packageId(pathOrder.scanId, 'direct');
    const orderedPaths = await getPathsToPackage(pathOrder.scanId, directId);
    expect(orderedPaths.paths.map((path) => path.lockPaths)).toEqual([
      ['node_modules/direct'],
      ['node_modules/parent', 'node_modules/direct'],
    ]);

    const packages: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    const dependencies: Record<string, string> = Object.create(null) as Record<string, string>;
    for (let index = 0; index < 101; index += 1) {
      const parent = `parent-${index}`;
      dependencies[parent] = '1.0.0';
      packages[`node_modules/${parent}`] = {
        version: '1.0.0',
        dependencies: { target: '1.0.0' },
      };
    }
    packages[''] = { dependencies };
    packages['node_modules/target'] = { version: '1.0.0' };
    const manyPaths = await persistFixture(JSON.stringify({ lockfileVersion: 3, packages }));
    const targetId = await packageId(manyPaths.scanId, 'target');
    const capped = await getPathsToPackage(manyPaths.scanId, targetId);
    expect(capped.paths).toHaveLength(100);
    expect(capped.truncated).toBe(true);
  });

  it('matches lockfile dev flags on the public fixture', async () => {
    const parsed = parseLockfile(readFixture('public-deconf.json'));
    const scan = await persistFixture(readFixture('public-deconf.json'));
    const mismatches: {
      readonly lockPath: string;
      readonly lockfileIsDev: boolean;
      readonly pathDevOnly: boolean | undefined;
    }[] = [];
    for (const instance of parsed.instances) {
      const id = await packageId(scan.scanId, instance.name, instance.version);
      const paths = await getPathsToPackage(scan.scanId, id);
      const instancePaths = paths.paths.filter((path) => path.lockPaths.at(-1) === instance.lockPath);
      if (instancePaths.length === 0) {
        mismatches.push({
          lockPath: instance.lockPath,
          lockfileIsDev: instance.isDev,
          pathDevOnly: undefined,
        });
        continue;
      }
      for (const path of instancePaths) {
        if (path.devOnly !== instance.isDev || path.lockfileIsDev !== instance.isDev) {
          mismatches.push({
            lockPath: instance.lockPath,
            lockfileIsDev: instance.isDev,
            pathDevOnly: path.devOnly,
          });
        }
      }
    }
    expect(mismatches, JSON.stringify(mismatches, null, 2)).toEqual([]);
  });
});
