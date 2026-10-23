import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  InvalidPackageMetadataError,
  InvalidLockfileError,
  LockfileJsonParseError,
  LockfilePathTooDeepError,
  LockfileTooLargeError,
  LockfileTooManyPackagesError,
  UnsupportedLockfileVersionError,
} from './errors.js';
import { LOCKFILE_LIMITS, parseLockfile, toLockfileGraph } from './parse.js';

function fixture(name: string): string {
  return readFileSync(resolve(process.cwd(), 'fixtures/lockfiles/phase-2', name), 'utf8');
}

describe('parseLockfile', () => {
  it('parses a simple dependency tree and resolves nested dependencies', () => {
    const result = parseLockfile(fixture('simple-tree.json'));
    expect(result.edges).toEqual([
      { parentLockPath: null, childLockPath: 'node_modules/app', depType: 'prod' },
      { parentLockPath: 'node_modules/app', childLockPath: 'node_modules/leaf', depType: 'prod' },
    ]);
    expect(toLockfileGraph(result).packages).toHaveLength(2);
    expect(parseLockfile(fixture('simple-tree.json').replace('"lockfileVersion": 3', '"lockfileVersion": 2'))
      .lockfileVersion).toBe(2);
  });

  it('keeps both paths through a diamond and prevents cycle expansion', () => {
    const diamond = parseLockfile(fixture('diamond.json'));
    expect(diamond.edges.filter((edge) => edge.childLockPath === 'node_modules/shared')).toHaveLength(2);

    const cycle = parseLockfile(fixture('cycle.json'));
    expect(cycle.edges).toHaveLength(3);
    expect(cycle.edges.find((edge) => edge.parentLockPath === 'node_modules/b')).toEqual({
      parentLockPath: 'node_modules/b',
      childLockPath: 'node_modules/a',
      depType: 'prod',
    });
  });

  it('preserves dev-only chains and separate prod and dev paths to a shared package', () => {
    const devChain = parseLockfile(fixture('dev-only-chain.json'));
    expect(devChain.edges.map((edge) => edge.depType)).toEqual(['dev', 'prod']);
    expect(devChain.instances.find((item) => item.name === 'util')?.isDev).toBe(true);

    const mixed = parseLockfile(fixture('prod-dev-mix.json'));
    expect(mixed.edges.filter((edge) => edge.childLockPath === 'node_modules/shared')).toEqual([
      { parentLockPath: 'node_modules/prod-parent', childLockPath: 'node_modules/shared', depType: 'prod' },
      { parentLockPath: 'node_modules/dev-parent', childLockPath: 'node_modules/shared', depType: 'prod' },
    ]);
    expect(mixed.edges.filter((edge) => edge.parentLockPath === null).map((edge) => edge.depType).sort())
      .toEqual(['dev', 'prod']);
  });

  it('preserves package flags and classifies dependency edges by declaring field', () => {
    const result = parseLockfile(JSON.stringify({
      lockfileVersion: 3,
      packages: {
        '': {
          dependencies: { regular: '1' },
          devDependencies: { tool: '1' },
          optionalDependencies: { optional: '1' },
          peerDependencies: { peer: '1' },
        },
        'node_modules/regular': { version: '1' },
        'node_modules/tool': { version: '1', dev: true },
        'node_modules/optional': { version: '1', optional: true },
        'node_modules/peer': { version: '1', peer: true },
      },
    }));

    expect(result.instances.find((item) => item.name === 'tool')?.isDev).toBe(true);
    expect(result.instances.find((item) => item.name === 'optional')?.isOptional).toBe(true);
    expect(result.instances.find((item) => item.name === 'peer')?.isPeer).toBe(true);
    expect(result.edges.map((edge) => edge.depType)).toEqual(['prod', 'dev', 'optional', 'peer']);
  });

  it('resolves the nearest nested installation when package versions differ', () => {
    const result = parseLockfile(fixture('nested-copies.json'));
    expect(result.edges).toContainEqual({
      parentLockPath: 'node_modules/host',
      childLockPath: 'node_modules/host/node_modules/duplicate',
      depType: 'prod',
    });
    expect(result.edges).toContainEqual({
      parentLockPath: null,
      childLockPath: 'node_modules/duplicate',
      depType: 'prod',
    });
    expect(result.instances.filter((item) => item.name === 'duplicate').map((item) => item.version).sort())
      .toEqual(['1.0.0', '2.0.0']);
  });

  it('follows workspace links and skips missing optional and peer dependencies', () => {
    const workspace = parseLockfile(fixture('workspace-link.json'));
    expect(workspace.instances.find((item) => item.name === 'workspace-lib')).toMatchObject({
      lockPath: 'node_modules/workspace-lib',
      effectiveLockPath: 'packages/workspace-lib',
      isLink: true,
    });
    expect(workspace.edges).toContainEqual({
      parentLockPath: 'node_modules/workspace-lib',
      childLockPath: 'node_modules/helper',
      depType: 'prod',
    });

    const missing = parseLockfile(fixture('missing-optional.json'));
    expect(missing.warnings.filter((warning) => warning.code === 'MISSING_REQUIRED_DEPENDENCY'))
      .toMatchObject([{ dependencyName: 'required-missing' }]);
    expect(missing.edges).toHaveLength(0);
  });

  it('keeps __proto__ package-map keys as ordinary map keys', () => {
    const result = parseLockfile(fixture('proto-key.json'));
    expect(result.instances.map((item) => item.name)).toContain('safe-proto-package');
    expect(({} as { polluted?: unknown }).polluted).toBeUndefined();
  });

  it('parses the public fixture and its dev-only package metadata', () => {
    const result = parseLockfile(fixture('public-deconf.json'));
    expect(result.lockfileVersion).toBe(3);
    expect(result.instances).toMatchObject([{ name: 'prettier', version: '3.6.2', isDev: true }]);
    expect(result.edges).toEqual([
      { parentLockPath: null, childLockPath: 'node_modules/prettier', depType: 'dev' },
    ]);
  });

  it('rejects a file larger than the byte limit before parsing', () => {
    const input = ' '.repeat(LOCKFILE_LIMITS.maxBytes + 1);
    expect(() => parseLockfile(input)).toThrow(LockfileTooLargeError);
  });

  it('rejects more than 20,000 package entries', () => {
    const packages = Object.create(null) as Record<string, unknown>;
    packages[''] = {};
    for (let index = 0; index <= LOCKFILE_LIMITS.maxPackages; index += 1) {
      packages[`node_modules/package-${index}`] = { version: '1.0.0' };
    }
    expect(() => parseLockfile(JSON.stringify({ lockfileVersion: 3, packages })))
      .toThrow(LockfileTooManyPackagesError);
  });

  it('rejects package paths deeper than 50 node_modules segments', () => {
    const deepPath = `${Array.from({ length: 51 }, () => 'node_modules/pkg').join('/')}`;
    const input = JSON.stringify({ lockfileVersion: 3, packages: { [deepPath]: { version: '1.0.0' } } });
    expect(() => parseLockfile(input)).toThrow(LockfilePathTooDeepError);
  });

  it('converts malformed or excessively nested JSON to a typed parse error', () => {
    expect(() => parseLockfile('{')).toThrow(LockfileJsonParseError);
    const deeplyNested = `${'['.repeat(100_000)}0${']'.repeat(100_000)}`;
    expect(() => parseLockfile(deeplyNested)).toThrow(InvalidLockfileError);
  });

  it('wraps a RangeError thrown while parsing deeply nested JSON', () => {
    const parseSpy = vi.spyOn(JSON, 'parse').mockImplementation(() => {
      throw new RangeError('Maximum call stack size exceeded');
    });
    try {
      expect(() => parseLockfile('{}')).toThrow(LockfileJsonParseError);
    } finally {
      parseSpy.mockRestore();
    }
  });

  it('rejects lockfile v1 and unsafe name or version metadata', () => {
    expect(() => parseLockfile('{"lockfileVersion":1,"dependencies":{}}'))
      .toThrow(UnsupportedLockfileVersionError);
    expect(() => parseLockfile(JSON.stringify({
      lockfileVersion: 3,
      packages: { 'node_modules/pkg': { name: `bad\u0000name`, version: '1.0.0' } },
    }))).toThrow(InvalidPackageMetadataError);
    expect(() => parseLockfile(JSON.stringify({
      lockfileVersion: 3,
      packages: { 'node_modules/pkg': { name: 'n'.repeat(215), version: '1.0.0' } },
    }))).toThrow(InvalidPackageMetadataError);
    expect(() => parseLockfile(JSON.stringify({
      lockfileVersion: 3,
      packages: { 'node_modules/pkg': { name: 'pkg', version: 'v'.repeat(257) } },
    }))).toThrow(InvalidPackageMetadataError);
  });

  it('skips incomplete package entries with a warning', () => {
    const result = parseLockfile(JSON.stringify({
      lockfileVersion: 3,
      packages: { '': {}, 'node_modules/incomplete': {} },
    }));
    expect(result.instances).toHaveLength(0);
    expect(result.warnings).toMatchObject([{ code: 'INCOMPLETE_PACKAGE' }]);
  });
});
