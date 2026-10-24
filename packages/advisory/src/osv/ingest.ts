import { lstat, readFile, readdir, stat } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
import { upsertAdvisoryBatch, type AdvisoryWrite } from '@npm-alert-triage/storage/advisories';
import { InvalidOsvRecordError, OsvFileTooLargeError, OsvInputPathError } from './errors.js';
import { parseOsvText } from './parse.js';
import { MAX_OSV_FILE_BYTES, OSV_INGEST_BATCH_SIZE } from './schema.js';

export interface SkippedOsvRecord {
  readonly source: string;
  readonly id?: string;
  readonly reason: string;
}

export interface TruncatedOsvDetails {
  readonly source: string;
  readonly id: string;
  readonly originalLength: number;
  readonly storedLength: number;
}

export interface OsvIngestionReport {
  readonly inserted: number;
  readonly updated: number;
  readonly skipped: number;
  readonly skippedRecords: readonly SkippedOsvRecord[];
  readonly truncatedDetails: readonly TruncatedOsvDetails[];
}

async function listJsonFiles(inputPath: string): Promise<string[]> {
  const absolutePath = resolve(inputPath);
  let rootInfo;
  try {
    rootInfo = await lstat(absolutePath);
  } catch {
    throw new OsvInputPathError();
  }
  if (rootInfo.isSymbolicLink()) throw new OsvInputPathError();
  if (rootInfo.isFile()) {
    return extname(absolutePath).toLowerCase() === '.json' ? [absolutePath] : [];
  }
  if (!rootInfo.isDirectory()) throw new OsvInputPathError();

  const files: string[] = [];
  async function visit(directory: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
    for (const entry of entries) {
      const entryPath = join(directory, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) await visit(entryPath);
      else if (entry.isFile() && extname(entry.name).toLowerCase() === '.json') files.push(entryPath);
    }
  }
  await visit(absolutePath);
  return files;
}

function skippedReason(error: unknown): string {
  if (error instanceof OsvFileTooLargeError) return 'FILE_TOO_LARGE';
  if (error instanceof InvalidOsvRecordError) return `INVALID_RECORD: ${error.reason}`;
  return 'FILE_READ_ERROR';
}

export async function ingestOsvPath(inputPath: string): Promise<OsvIngestionReport> {
  const files = await listJsonFiles(inputPath);
  const skippedRecords: SkippedOsvRecord[] = [];
  const truncatedDetails: TruncatedOsvDetails[] = [];
  const seenIds = new Set<string>();
  let inserted = 0;
  let updated = 0;
  let pending: AdvisoryWrite[] = [];

  async function flush(): Promise<void> {
    if (pending.length === 0) return;
    const counts = await upsertAdvisoryBatch(pending);
    inserted += counts.inserted;
    updated += counts.updated;
    pending = [];
  }

  for (const file of files) {
    try {
      const fileInfo = await stat(file);
      if (!fileInfo.isFile()) {
        skippedRecords.push({ source: file, reason: 'NOT_A_REGULAR_FILE' });
        continue;
      }
      if (fileInfo.size > MAX_OSV_FILE_BYTES) throw new OsvFileTooLargeError(file);
      const contents = await readFile(file, 'utf8');
      const result = parseOsvText(contents);
      if (result.status === 'skipped') {
        skippedRecords.push({ source: file, reason: result.reason });
        continue;
      }
      const { advisory } = result.value;
      if (seenIds.has(advisory.id)) {
        skippedRecords.push({ source: file, id: advisory.id, reason: 'DUPLICATE_ID_IN_INPUT' });
        continue;
      }
      seenIds.add(advisory.id);
      if (result.value.detailsTruncation) {
        truncatedDetails.push({
          source: file,
          id: advisory.id,
          ...result.value.detailsTruncation,
        });
      }
      pending.push(advisory);
      if (pending.length >= OSV_INGEST_BATCH_SIZE) await flush();
    } catch (error: unknown) {
      skippedRecords.push({ source: file, reason: skippedReason(error) });
    }
  }
  await flush();
  return {
    inserted,
    updated,
    skipped: skippedRecords.length,
    skippedRecords,
    truncatedDetails,
  };
}
