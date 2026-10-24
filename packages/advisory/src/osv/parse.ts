import { Buffer } from 'node:buffer';
import { InvalidOsvRecordError, OsvFileTooLargeError } from './errors.js';
import {
  MAX_OSV_DETAILS_LENGTH,
  MAX_OSV_FILE_BYTES,
  OsvRecordSchema,
  type OsvRecord,
} from './schema.js';
import type { AdvisoryAffectedPackageWrite, AdvisoryWrite } from '@npm-alert-triage/storage/advisories';

export interface DetailsTruncation {
  readonly originalLength: number;
  readonly storedLength: number;
}

export interface ParsedOsvAdvisory {
  readonly advisory: AdvisoryWrite;
  readonly detailsTruncation?: DetailsTruncation;
}

export type OsvParseResult =
  | { readonly status: 'parsed'; readonly value: ParsedOsvAdvisory }
  | { readonly status: 'skipped'; readonly reason: 'NO_NPM_AFFECTED_PACKAGES' };

function hasControlCharacters(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) return true;
  }
  return false;
}

function validateRecord(input: unknown): OsvRecord {
  const parsed = OsvRecordSchema.safeParse(input);
  if (!parsed.success) throw new InvalidOsvRecordError(parsed.error.issues[0]?.message ?? 'schema validation failed');
  if (hasControlCharacters(parsed.data.id)) throw new InvalidOsvRecordError('id contains control characters');
  for (const alias of parsed.data.aliases ?? []) {
    if (hasControlCharacters(alias)) throw new InvalidOsvRecordError('alias contains control characters');
  }
  for (const entry of parsed.data.affected) {
    if (hasControlCharacters(entry.package.name)) {
      throw new InvalidOsvRecordError('package name contains control characters');
    }
  }
  return parsed.data;
}

function normalizeAffectedEntries(record: OsvRecord) {
  return record.affected
    .filter((entry) => entry.package.ecosystem === 'npm')
    .map((entry) => ({
      package: { ecosystem: 'npm', name: entry.package.name.toLowerCase() },
      ranges: entry.ranges ?? [],
      versions: entry.versions ?? [],
    }));
}

function mergeAffectedPackages(
  entries: ReturnType<typeof normalizeAffectedEntries>,
): AdvisoryAffectedPackageWrite[] {
  const grouped = new Map<string, { ranges: unknown[]; versions: Set<string> }>();
  for (const entry of entries) {
    const current = grouped.get(entry.package.name) ?? { ranges: [], versions: new Set<string>() };
    current.ranges.push(...entry.ranges);
    for (const version of entry.versions) current.versions.add(version);
    grouped.set(entry.package.name, current);
  }
  return [...grouped.entries()].map(([packageName, value]) => ({
    packageName,
    ranges: value.ranges,
    versions: [...value.versions],
  }));
}

export function parseOsvText(input: string): OsvParseResult {
  if (Buffer.byteLength(input, 'utf8') > MAX_OSV_FILE_BYTES) {
    throw new OsvFileTooLargeError('<input>');
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(input) as unknown;
  } catch {
    throw new InvalidOsvRecordError('file is not valid JSON');
  }
  const record = validateRecord(decoded);
  const npmEntries = normalizeAffectedEntries(record);
  if (npmEntries.length === 0) return { status: 'skipped', reason: 'NO_NPM_AFFECTED_PACKAGES' };

  const details = record.details ?? '';
  const storedDetails = details.slice(0, MAX_OSV_DETAILS_LENGTH);
  const severity = record.database_specific?.severity ?? null;
  const cvss = record.severity?.find((item) => item.type.startsWith('CVSS_'))?.score ?? null;
  const detailsTruncation = details.length > MAX_OSV_DETAILS_LENGTH
    ? { originalLength: details.length, storedLength: storedDetails.length }
    : undefined;

  return {
    status: 'parsed',
    value: {
      advisory: {
        id: record.id,
        summary: record.summary ?? '',
        details: storedDetails,
        aliases: record.aliases ?? [],
        severity,
        cvss,
        publishedAt: record.published ?? null,
        withdrawnAt: record.withdrawn ?? null,
        affectedRanges: npmEntries,
        affectedPackages: mergeAffectedPackages(npmEntries),
      },
      ...(detailsTruncation ? { detailsTruncation } : {}),
    },
  };
}
