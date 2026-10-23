export type LockfileVersion = 2 | 3;
export type DependencyType = 'prod' | 'dev' | 'optional' | 'peer';

export interface PackageIdentity {
  readonly name: string;
  readonly version: string;
}

export interface PackageInstance extends PackageIdentity {
  readonly lockPath: string;
  readonly isDev: boolean;
  readonly isOptional: boolean;
  readonly isPeer: boolean;
  readonly isLink: boolean;
  readonly effectiveLockPath: string;
  readonly dependencies: ReadonlyMap<string, DependencyType>;
  readonly optionalPeers: ReadonlySet<string>;
}

export interface DependencyEdge {
  readonly parentLockPath: string | null;
  readonly childLockPath: string;
  readonly depType: DependencyType;
}

export interface LockfileWarning {
  readonly code: 'MISSING_REQUIRED_DEPENDENCY' | 'INCOMPLETE_PACKAGE';
  readonly message: string;
  readonly lockPath: string;
  readonly dependencyName?: string;
}

export interface ParsedLockfile {
  readonly lockfileVersion: LockfileVersion;
  readonly instances: readonly PackageInstance[];
  readonly edges: readonly DependencyEdge[];
  readonly warnings: readonly LockfileWarning[];
}

export type PackageRow = PackageIdentity;

export interface LockfileGraph {
  readonly lockfileVersion: LockfileVersion;
  readonly packages: readonly PackageRow[];
  readonly instances: readonly Omit<PackageInstance, 'dependencies' | 'optionalPeers' | 'effectiveLockPath'>[];
  readonly edges: readonly DependencyEdge[];
  readonly warnings: readonly LockfileWarning[];
}
