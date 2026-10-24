import { z } from 'zod';

export const MAX_OSV_FILE_BYTES = 10 * 1024 * 1024;
export const MAX_OSV_DETAILS_LENGTH = 50_000;
export const MAX_OSV_AFFECTED_ENTRIES = 200;
export const MAX_OSV_RANGES_PER_ENTRY = 200;
export const MAX_OSV_EVENTS_PER_RANGE = 500;
export const MAX_OSV_VERSIONS_PER_ENTRY = 10_000;
export const OSV_INGEST_BATCH_SIZE = 100;

const OsvEventSchema = z.record(z.string().max(100), z.string().max(256)).refine(
  (event) => Object.keys(event).length === 1,
  'Each OSV range event must contain exactly one event field',
);

export const OsvRangeSchema = z.object({
  type: z.string().min(1).max(64),
  events: z.array(OsvEventSchema).max(MAX_OSV_EVENTS_PER_RANGE),
}).passthrough();

export const OsvAffectedEntrySchema = z.object({
  package: z.object({
    ecosystem: z.string().min(1).max(64),
    name: z.string().min(1).max(214),
  }).passthrough(),
  ranges: z.array(OsvRangeSchema).max(MAX_OSV_RANGES_PER_ENTRY).optional(),
  versions: z.array(z.string().max(256)).max(MAX_OSV_VERSIONS_PER_ENTRY).optional(),
}).passthrough();

export const OsvRecordSchema = z.object({
  id: z.string().min(1).max(256),
  aliases: z.array(z.string().min(1).max(256)).max(100).optional(),
  summary: z.string().max(2_000).optional(),
  details: z.string().optional(),
  published: z.string().datetime({ offset: true }).optional(),
  withdrawn: z.string().datetime({ offset: true }).optional(),
  severity: z.array(z.object({
    type: z.string().min(1).max(64),
    score: z.string().min(1).max(512),
    source: z.string().max(2_000).optional(),
  }).passthrough()).max(10).optional(),
  affected: z.array(OsvAffectedEntrySchema).max(MAX_OSV_AFFECTED_ENTRIES),
  database_specific: z.object({
    severity: z.enum(['LOW', 'MODERATE', 'HIGH', 'CRITICAL']).optional(),
  }).passthrough().optional(),
}).passthrough();

export type OsvRecord = z.infer<typeof OsvRecordSchema>;
