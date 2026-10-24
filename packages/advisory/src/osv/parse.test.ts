import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { InvalidOsvRecordError, OsvFileTooLargeError } from './errors.js';
import { parseOsvText } from './parse.js';
import {
  MAX_OSV_AFFECTED_ENTRIES,
  MAX_OSV_DETAILS_LENGTH,
  MAX_OSV_EVENTS_PER_RANGE,
  MAX_OSV_FILE_BYTES,
} from './schema.js';

function fixture(name: string): string {
  return readFileSync(resolve(process.cwd(), 'fixtures/advisories', name), 'utf8');
}

describe('parseOsvText', () => {
  it('parses supported OSV fields and normalizes affected package names', () => {
    const result = parseOsvText(fixture('introduced-fixed.json'));
    expect(result.status).toBe('parsed');
    if (result.status !== 'parsed') return;
    expect(result.value.advisory).toMatchObject({
      id: 'TEST-INTRODUCED-FIXED',
      aliases: ['CVE-2099-0001'],
      severity: 'HIGH',
      cvss: 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H',
      affectedPackages: [{ packageName: 'target-pkg' }],
    });
  });

  it('merges repeated affected entries by lowercase package name', () => {
    const result = parseOsvText(fixture('merge-same-package.json'));
    expect(result.status).toBe('parsed');
    if (result.status !== 'parsed') return;
    expect(result.value.advisory.affectedPackages).toEqual([{
      packageName: 'target-pkg',
      ranges: [
        { type: 'SEMVER', events: [{ introduced: '1.0.0' }, { fixed: '1.1.0' }] },
        { type: 'ECOSYSTEM', events: [{ introduced: '2.0.0' }, { fixed: '2.1.0' }] },
      ],
      versions: ['1.0.1', '1.0.2', '2.0.1'],
    }]);
    expect(result.value.advisory.affectedRanges).toHaveLength(2);
  });

  it('skips records without npm affected packages', () => {
    expect(parseOsvText(fixture('non-npm.json'))).toEqual({
      status: 'skipped',
      reason: 'NO_NPM_AFFECTED_PACKAGES',
    });
  });

  it('throws typed errors for malformed records and files above the byte cap', () => {
    expect(() => parseOsvText(fixture('malformed.json'))).toThrow(InvalidOsvRecordError);
    expect(() => parseOsvText(' '.repeat(MAX_OSV_FILE_BYTES + 1))).toThrow(OsvFileTooLargeError);
  });

  it('truncates long details and reports original and stored lengths', () => {
    const record = JSON.parse(fixture('introduced-fixed.json')) as Record<string, unknown>;
    record.details = 'd'.repeat(MAX_OSV_DETAILS_LENGTH + 12);
    const result = parseOsvText(JSON.stringify(record));
    expect(result.status).toBe('parsed');
    if (result.status !== 'parsed') return;
    expect(result.value.advisory.details).toHaveLength(MAX_OSV_DETAILS_LENGTH);
    expect(result.value.detailsTruncation).toEqual({
      originalLength: MAX_OSV_DETAILS_LENGTH + 12,
      storedLength: MAX_OSV_DETAILS_LENGTH,
    });
  });

  it('enforces affected-entry and range-event caps', () => {
    const source = JSON.parse(fixture('introduced-fixed.json')) as Record<string, unknown>;
    const affected = source.affected as unknown[];
    source.affected = Array.from({ length: MAX_OSV_AFFECTED_ENTRIES + 1 }, () => affected[0]);
    expect(() => parseOsvText(JSON.stringify(source))).toThrow(InvalidOsvRecordError);

    const eventRecord = JSON.parse(fixture('introduced-fixed.json')) as {
      affected: { ranges: { events: unknown[] }[] }[];
    };
    eventRecord.affected[0]!.ranges[0]!.events = Array.from(
      { length: MAX_OSV_EVENTS_PER_RANGE + 1 },
      () => ({ introduced: '0' }),
    );
    expect(() => parseOsvText(JSON.stringify(eventRecord))).toThrow(InvalidOsvRecordError);
  });

  it('parses the two attributed public GHSA fixtures and merges protobufjs entries', () => {
    const protobuf = parseOsvText(fixture('GHSA-h755-8qp9-cq85.json'));
    const htmlMinifier = parseOsvText(fixture('GHSA-pfq8-rq6v-vf5m.json'));
    expect(protobuf.status).toBe('parsed');
    expect(htmlMinifier.status).toBe('parsed');
    if (protobuf.status !== 'parsed' || htmlMinifier.status !== 'parsed') return;
    expect(protobuf.value.advisory.affectedPackages).toHaveLength(1);
    expect(protobuf.value.advisory.affectedPackages[0]?.ranges).toHaveLength(2);
    expect(htmlMinifier.value.advisory.affectedPackages[0]?.packageName).toBe('html-minifier');
  });
});
