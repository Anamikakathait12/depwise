import { Buffer } from 'node:buffer';
import { posix } from 'node:path';
import {
  InvalidLockfileError,
  InvalidPackageMetadataError,
  LockfileJsonParseError,
  LockfilePathTooDeepError,
  LockfileTooLargeError,
  LockfileTooManyPackagesError,
  UnsupportedLockfileVersionError,
} from './errors.js';
import { LockfileHeaderSchema, LockfilePackageEntrySchema, type LockfilePackageEntry } from './schema.js';
import type {
  DependencyType,
  LockfileGraph,
  LockfileWarning,
  PackageInstance,
  PackageRow,
  ParsedLockfile,
} from './types.js';

export const LOCKFILE_LIMITS = {
  maxBytes: 10 * 1024 * 1024,
  maxPackages: 20_000,
  maxNodeModulesDepth: 50,
  maxNameLength: 214,
  maxVersionLength: 256,
} as const;

const DECLARATION_FIELDS: readonly [keyof LockfilePackageEntry, DependencyType][] = [
  ['dependencies', 'prod'],
  ['devDependencies', 'dev'],
  ['optionalDependencies', 'optional'],
  ['peerDependencies', 'peer'],
];

interface NormalizedEntry {
  readonly lockPath: string;
  readonly raw: LockfilePackageEntry;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function checkPackageName(name: string): void {
  if (name.trim().length === 0 || name.length > LOCKFILE_LIMITS.maxNameLength || hasControlCharacters(name)) {
    throw new InvalidPackageMetadataError('name');
  }
}

function checkPackageVersion(version: string): void {
  if (version.trim().length === 0 || version.length > LOCKFILE_LIMITS.maxVersionLength || hasControlCharacters(version)) {
    throw new InvalidPackageMetadataError('version');
  }
}

function hasControlCharacters(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) return true;
  }
  return false;
}

function packageNameFromPath(lockPath: string): string | undefined {
  const segments = lockPath.split('/');
  for (let index = segments.length - 1; index >= 0; index -= 1) {
    if (segments[index] !== 'node_modules') continue;
    const name = segments[index + 1];
    if (!name) return undefined;
    if (name.startsWith('@')) {
      const packagePart = segments[index + 2];
      return packagePart ? `${name}/${packagePart}` : undefined;
    }
    return name;
  }
  return undefined;
}

function nodeModulesDepth(lockPath: string): number {
  return lockPath.split('/').filter((segment) => segment === 'node_modules').length;
}

function normalizedLinkTarget(resolved: string | undefined): string | undefined {
  if (!resolved || resolved.includes('\\') || resolved.startsWith('/')) return undefined;
  const normalized = posix.normalize(resolved.replace(/^\.\//u, ''));
  if (normalized === '..' || normalized.startsWith('../')) return undefined;
  return normalized;
}

function ownStringEntries(value: unknown): Map<string, string> {
  if (!isRecord(value)) throw new InvalidLockfileError('Dependency declarations must be an object');
  const result = new Map<string, string>();
  for (const key of Object.keys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || typeof descriptor.value !== 'string') {
      throw new InvalidLockfileError('Dependency specifications must be strings');
    }
    result.set(key, descriptor.value);
  }
  return result;
}

function optionalPeerNames(value: unknown): Set<string> {
  const result = new Set<string>();
  if (!isRecord(value)) return result;
  for (const name of Object.keys(value)) {
    const item = Object.getOwnPropertyDescriptor(value, name)?.value;
    if (isRecord(item) && Object.getOwnPropertyDescriptor(item, 'optional')?.value === true) {
      result.add(name);
    }
  }
  return result;
}

function collectDeclarations(
  entry: LockfilePackageEntry,
): { dependencies: Map<string, DependencyType>; optionalPeers: Set<string> } {
  const dependencies = new Map<string, DependencyType>();
  const priority: Record<DependencyType, number> = { prod: 0, dev: 1, peer: 2, optional: 3 };

  for (const [field, depType] of DECLARATION_FIELDS) {
    const rawValue = entry[field];
    if (rawValue === undefined) continue;
    const declarations = ownStringEntries(rawValue);
    for (const name of declarations.keys()) {
      const current = dependencies.get(name);
      if (!current || priority[depType] > priority[current]) dependencies.set(name, depType);
    }
  }

  return { dependencies, optionalPeers: optionalPeerNames(entry.peerDependenciesMeta) };
}

function entryMap(packages: Record<string, unknown>): Map<string, NormalizedEntry> {
  const result = new Map<string, NormalizedEntry>();
  for (const lockPath of Object.keys(packages)) {
    const raw = Object.getOwnPropertyDescriptor(packages, lockPath)?.value;
    if (!isRecord(raw)) throw new InvalidLockfileError('Each packages entry must be an object');
    const parsed = LockfilePackageEntrySchema.safeParse(raw);
    if (!parsed.success) throw new InvalidLockfileError('A package entry contains an invalid field type');
    result.set(lockPath, { lockPath, raw: parsed.data });
  }
  return result;
}

function normalizeEntries(entries: Map<string, NormalizedEntry>, warnings: LockfileWarning[]): PackageInstance[] {
  const linkedTargets = new Set<string>();
  for (const { raw } of entries.values()) {
    if (raw.link === true) {
      const target = normalizedLinkTarget(raw.resolved ?? undefined);
      if (target) linkedTargets.add(target);
    }
  }

  const instances: PackageInstance[] = [];
  for (const { lockPath, raw } of entries.values()) {
    if (lockPath === '' || linkedTargets.has(lockPath)) continue;
    const linkTarget = raw.link === true ? normalizedLinkTarget(raw.resolved ?? undefined) : undefined;
    const effectiveLockPath = linkTarget ?? lockPath;
    const effective = linkTarget ? entries.get(linkTarget)?.raw : undefined;
    const name = effective?.name ?? raw.name ?? packageNameFromPath(lockPath);
    const version = effective?.version ?? raw.version;

    if (!name || !version) {
      warnings.push({
        code: 'INCOMPLETE_PACKAGE',
        message: `Skipping package entry without a usable name and version: ${lockPath}`,
        lockPath,
      });
      continue;
    }
    checkPackageName(name);
    checkPackageVersion(version);

    const descriptor = effective ?? raw;
    const { dependencies, optionalPeers } = collectDeclarations(descriptor);
    instances.push({
      lockPath,
      name,
      version,
      effectiveLockPath,
      isDev: raw.dev === true || descriptor.dev === true,
      isOptional: raw.optional === true || descriptor.optional === true,
      isPeer: raw.peer === true || descriptor.peer === true,
      isLink: raw.link === true,
      dependencies,
      optionalPeers,
    });
  }
  return instances;
}

function resolveInstalledNode(
  fromLockPath: string,
  dependencyName: string,
  instancesByPath: Map<string, PackageInstance>,
): PackageInstance | undefined {
  let directory = fromLockPath;
  while (directory !== '') {
    const lastSegment = directory.slice(directory.lastIndexOf('/') + 1);
    if (lastSegment !== 'node_modules') {
      const candidate = `${directory}/node_modules/${dependencyName}`;
      const found = instancesByPath.get(candidate);
      if (found) return found;
    }
    const slash = directory.lastIndexOf('/');
    directory = slash < 0 ? '' : directory.slice(0, slash);
  }
  return instancesByPath.get(`node_modules/${dependencyName}`);
}

export function parseLockfile(input: string): ParsedLockfile {
  if (Buffer.byteLength(input, 'utf8') > LOCKFILE_LIMITS.maxBytes) throw new LockfileTooLargeError();

  let decoded: unknown;
  try {
    decoded = JSON.parse(input) as unknown;
  } catch (error: unknown) {
    throw new LockfileJsonParseError(error);
  }

  if (isRecord(decoded)) {
    const lockfileVersion = Object.getOwnPropertyDescriptor(decoded, 'lockfileVersion')?.value;
    if (lockfileVersion === 1) throw new UnsupportedLockfileVersionError(1);
    if (lockfileVersion !== 2 && lockfileVersion !== 3) {
      throw new UnsupportedLockfileVersionError(lockfileVersion);
    }
  }
  const header = LockfileHeaderSchema.safeParse(decoded);
  if (!header.success) throw new InvalidLockfileError('package-lock.json must contain lockfileVersion and packages');
  const lockfileVersion = header.data.lockfileVersion as 2 | 3;
  if (!isRecord(header.data.packages)) throw new InvalidLockfileError('package-lock.json packages must be an object');

  const packagePaths = Object.keys(header.data.packages).filter((lockPath) => lockPath !== '');
  if (packagePaths.length > LOCKFILE_LIMITS.maxPackages) throw new LockfileTooManyPackagesError();
  for (const lockPath of packagePaths) {
    if (hasControlCharacters(lockPath)) throw new InvalidLockfileError('Package paths must not contain control characters');
    if (nodeModulesDepth(lockPath) > LOCKFILE_LIMITS.maxNodeModulesDepth) {
      throw new LockfilePathTooDeepError();
    }
  }

  const entries = entryMap(header.data.packages);
  const rootEntry = entries.get('')?.raw;
  const warnings: LockfileWarning[] = [];
  const instances = normalizeEntries(entries, warnings);
  const instancesByPath = new Map(instances.map((instance) => [instance.lockPath, instance]));
  const edges: ParsedLockfile['edges'][number][] = [];

  const declaringEntries: {
    readonly parent: PackageInstance | null;
    readonly dependencies: ReadonlyMap<string, DependencyType>;
    readonly optionalPeers: ReadonlySet<string>;
    readonly resolveFrom: string;
  }[] = [];
  if (rootEntry) {
    const declarations = collectDeclarations(rootEntry);
    declaringEntries.push({ parent: null, ...declarations, resolveFrom: '' });
  }
  for (const instance of instances) {
    declaringEntries.push({
      parent: instance,
      dependencies: instance.dependencies,
      optionalPeers: instance.optionalPeers,
      resolveFrom: instance.effectiveLockPath,
    });
  }

  for (const { parent, dependencies, optionalPeers, resolveFrom } of declaringEntries) {
    for (const [dependencyName, depType] of dependencies) {
      checkPackageName(dependencyName);
      const child = resolveInstalledNode(resolveFrom, dependencyName, instancesByPath);
      if (!child) {
        if (depType === 'optional' || depType === 'peer' || optionalPeers.has(dependencyName)) continue;
        warnings.push({
          code: 'MISSING_REQUIRED_DEPENDENCY',
          message: `Required ${depType} dependency is not installed: ${dependencyName}`,
          lockPath: parent?.lockPath ?? '',
          dependencyName,
        });
        continue;
      }
      edges.push({ parentLockPath: parent?.lockPath ?? null, childLockPath: child.lockPath, depType });
    }
  }

  return {
    lockfileVersion,
    instances,
    edges,
    warnings,
  };
}

export function toLockfileGraph(lockfile: ParsedLockfile): LockfileGraph {
  const packagesByIdentity = new Map<string, PackageRow>();
  for (const instance of lockfile.instances) {
    packagesByIdentity.set(JSON.stringify([instance.name, instance.version]), {
      name: instance.name,
      version: instance.version,
    });
  }
  return {
    lockfileVersion: lockfile.lockfileVersion,
    packages: [...packagesByIdentity.values()],
    instances: lockfile.instances.map((instance) => ({
      lockPath: instance.lockPath,
      name: instance.name,
      version: instance.version,
      isDev: instance.isDev,
      isOptional: instance.isOptional,
      isPeer: instance.isPeer,
      isLink: instance.isLink,
    })),
    edges: lockfile.edges,
    warnings: lockfile.warnings,
  };
}
