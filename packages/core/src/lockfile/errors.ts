export class LockfileError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
  }
}

export class LockfileTooLargeError extends LockfileError {
  constructor() {
    super('package-lock.json exceeds the 10 MB size limit');
  }
}

export class LockfileTooManyPackagesError extends LockfileError {
  constructor() {
    super('package-lock.json exceeds the 20,000 package limit');
  }
}

export class LockfilePathTooDeepError extends LockfileError {
  constructor() {
    super('Package path exceeds the 50 node_modules segment limit');
  }
}

export class LockfileJsonParseError extends LockfileError {
  constructor(cause: unknown) {
    super('package-lock.json contains invalid or excessively nested JSON', { cause });
  }
}

export class UnsupportedLockfileVersionError extends LockfileError {
  constructor(version: unknown) {
    const display = typeof version === 'number' || typeof version === 'string'
      ? version
      : version === undefined ? 'missing' : 'invalid';
    super(`Unsupported package-lock.json lockfileVersion: ${display}`);
  }
}

export class InvalidLockfileError extends LockfileError {
  constructor(message: string) {
    super(message);
  }
}

export class InvalidPackageMetadataError extends LockfileError {
  constructor(field: 'name' | 'version') {
    super(`Invalid package ${field}: value is empty, too long, or contains control characters`);
  }
}

export class LockfileGraphIntegrityError extends LockfileError {
  constructor(message: string) {
    super(message);
  }
}
