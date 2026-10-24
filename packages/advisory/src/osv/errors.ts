export class OsvInputPathError extends Error {
  constructor() {
    super('OSV input path is not a readable file or directory');
    this.name = 'OsvInputPathError';
  }
}

export class OsvFileTooLargeError extends Error {
  constructor(readonly source: string) {
    super(`OSV file exceeds the ${10 * 1024 * 1024} byte limit`);
    this.name = 'OsvFileTooLargeError';
  }
}

export class InvalidOsvRecordError extends Error {
  constructor(readonly reason: string) {
    super(`Invalid OSV record: ${reason}`);
    this.name = 'InvalidOsvRecordError';
  }
}
