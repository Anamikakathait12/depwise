import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import semver from 'semver';
import { describe, expect, it } from 'vitest';
import { evaluateCandidate } from './matcher.js';
import { parseOsvText } from './osv/parse.js';
import type { ScanAdvisoryCandidate } from '@npm-alert-triage/storage/advisories';

function fixture(name: string): string {
  return readFileSync(resolve(process.cwd(), 'fixtures/advisories', name), 'utf8');
}

function candidateFromFixture(name: string, version: string, packageName = 'target-pkg'): ScanAdvisoryCandidate {
  const parsed = parseOsvText(fixture(name));
  if (parsed.status !== 'parsed') throw new Error(`Expected a valid npm advisory fixture: ${name}`);
  const affected = parsed.value.advisory.affectedPackages.find((item) => item.packageName === packageName.toLowerCase());
  if (!affected) throw new Error(`Fixture ${name} does not affect ${packageName}`);
  return {
    advisoryId: parsed.value.advisory.id,
    instanceId: '00000000-0000-4000-8000-000000000001',
    packageId: '00000000-0000-4000-8000-000000000002',
    packageName,
    packageVersion: version,
    ranges: affected.ranges,
    versions: affected.versions,
    affectedRanges: parsed.value.advisory.affectedRanges,
  };
}

function isFullyEvaluable(candidate: ScanAdvisoryCandidate): boolean {
  if (!semver.valid(candidate.packageVersion)) return false;
  if (!Array.isArray(candidate.ranges) || !Array.isArray(candidate.versions)) return false;
  const ranges = candidate.ranges as { type?: unknown; events?: unknown }[];
  const versions = candidate.versions as unknown[];
  const entries = candidate.affectedRanges as {
    package?: { ecosystem?: unknown; name?: string };
    ranges?: unknown[];
    versions?: unknown[];
  }[];
  const packageEntries = entries.filter(
    (entry) => entry.package?.ecosystem === 'npm'
      && entry.package.name?.toLowerCase() === candidate.packageName.toLowerCase(),
  );
  if (packageEntries.length === 0) return false;
  if (packageEntries.some((entry) => (entry.ranges?.length ?? 0) === 0 && (entry.versions?.length ?? 0) === 0)) {
    return false;
  }
  if (ranges.length === 0 && versions.length === 0) return false;
  return ranges.every((range) => {
    if (range.type !== 'SEMVER' && range.type !== 'ECOSYSTEM') return false;
    if (!Array.isArray(range.events) || range.events.length === 0) return false;
    return (range.events as Record<string, string>[]).every((event) => {
      const keys = Object.keys(event);
      if (keys.length !== 1 || keys[0] === 'limit') return false;
      const eventType = keys[0];
      if (eventType !== 'introduced' && eventType !== 'fixed' && eventType !== 'last_affected') return false;
      return eventType === 'introduced' && event.introduced === '0'
        ? true
        : semver.valid(event[eventType] ?? '') !== null;
    });
  });
}

describe('evaluateCandidate', () => {
  it('evaluates ECOSYSTEM ranges with semver ordering', () => {
    const outcome = evaluateCandidate(candidateFromFixture('mid-range.json', '1.3.0'));
    expect(outcome?.matchKind).toBe('range');
  });

  it('compares prereleases explicitly against fixed boundaries', () => {
    expect(evaluateCandidate(candidateFromFixture('introduced-fixed.json', '1.2.3-beta.1'))?.matchKind)
      .toBe('range');
    expect(evaluateCandidate(candidateFromFixture('introduced-fixed.json', '1.2.3'))).toBeNull();
    expect(evaluateCandidate(candidateFromFixture('version-list.json', '1.2.3-beta.1'))?.matchKind)
      .toBe('version_list');
  });

  it('evaluates introduced, fixed, last_affected, multiple ranges, and exact versions', () => {
    expect(evaluateCandidate(candidateFromFixture('introduced-fixed.json', '1.0.0'))?.matchKind).toBe('range');
    expect(evaluateCandidate(candidateFromFixture('last-affected.json', '1.2.3'))?.matchKind).toBe('range');
    expect(evaluateCandidate(candidateFromFixture('multiple-ranges.json', '2.0.5'))?.matchKind).toBe('range');
    expect(evaluateCandidate(candidateFromFixture('version-list.json', '1.0.1'))).toBeNull();
  });

  it('matches package names after lowercase normalization', () => {
    const outcome = evaluateCandidate(candidateFromFixture('merge-same-package.json', '1.0.2', 'TARGET-PKG'));
    expect(outcome?.matchKind).toBe('range');
    expect(outcome?.matchedDetail.packageName).toBe('target-pkg');
  });

  it('treats limits, unknown events, unsupported ranges, and absent version data as uncertain', () => {
    for (const fixtureName of [
      'limit-event.json',
      'unknown-event.json',
      'unsupported-range.json',
      'empty-affected-entry.json',
    ]) {
      expect(evaluateCandidate(candidateFromFixture(fixtureName, '1.0.0'))?.matchKind, fixtureName)
        .toBe('uncertain');
    }
    expect(evaluateCandidate(candidateFromFixture('introduced-fixed.json', 'not-semver'))?.matchKind)
      .toBe('uncertain');
    const uncertainWithListedVersion = candidateFromFixture('limit-event.json', '1.0.0');
    expect(evaluateCandidate({ ...uncertainWithListedVersion, versions: ['1.0.0'] })?.matchKind)
      .toBe('uncertain');
  });

  it('keeps an uncertain alert for every unevaluable advisory/instance fixture pair', () => {
    const pairs = [
      { fixtureName: 'introduced-fixed.json', version: 'not-semver' },
      { fixtureName: 'unsupported-range.json', version: '1.0.0' },
      { fixtureName: 'limit-event.json', version: '1.0.0' },
      { fixtureName: 'unknown-event.json', version: '1.0.0' },
      { fixtureName: 'empty-affected-entry.json', version: '1.0.0' },
      { fixtureName: 'introduced-fixed.json', version: '1.2.3' },
      { fixtureName: 'mid-range.json', version: '1.0.0' },
      { fixtureName: 'last-affected.json', version: '1.2.3' },
      { fixtureName: 'multiple-ranges.json', version: '2.0.5' },
      { fixtureName: 'version-list.json', version: '1.0.0' },
      { fixtureName: 'GHSA-h755-8qp9-cq85.json', version: '6.11.3', packageName: 'protobufjs' },
      { fixtureName: 'GHSA-pfq8-rq6v-vf5m.json', version: '4.0.0', packageName: 'html-minifier' },
    ];

    for (const pair of pairs) {
      const candidate = candidateFromFixture(pair.fixtureName, pair.version, pair.packageName);
      const outcome = evaluateCandidate(candidate);
      if (!isFullyEvaluable(candidate)) {
        expect(outcome?.matchKind, `${pair.fixtureName}@${pair.version} must be retained as uncertain`).toBe('uncertain');
      } else if (outcome === null) {
        expect(isFullyEvaluable(candidate), `${pair.fixtureName}@${pair.version} may be dropped only after evaluation`)
          .toBe(true);
      }
    }
  });
});
