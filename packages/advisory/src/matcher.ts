import semver from 'semver';
import { z } from 'zod';
import {
  getScanAdvisoryCandidates,
  replaceScanAlerts,
  type ScanAdvisoryCandidate,
  type ScanAlertMatchKind,
  type ScanAlertWrite,
} from '@npm-alert-triage/storage/advisories';
import { OsvAffectedEntrySchema, OsvRangeSchema } from './osv/schema.js';

const StoredRangesSchema = z.array(OsvRangeSchema);
const StoredVersionsSchema = z.array(z.string().max(256));
const StoredAffectedEntriesSchema = z.array(OsvAffectedEntrySchema);

export interface MatchEvaluation {
  readonly matchKind: ScanAlertMatchKind;
  readonly matchedDetail: Readonly<Record<string, unknown>>;
}

type CandidateEvaluation = MatchEvaluation | null;

function uncertain(reason: string, candidate: ScanAdvisoryCandidate): MatchEvaluation {
  return {
    matchKind: 'uncertain',
    matchedDetail: {
      reason,
      packageName: candidate.packageName.toLowerCase(),
      installedVersion: candidate.packageVersion,
      advisoryId: candidate.advisoryId,
    },
  };
}

function evaluateRange(
  range: z.infer<typeof OsvRangeSchema>,
  installedVersion: string,
): { readonly matched: boolean } | { readonly reason: string } {
  if (range.type !== 'SEMVER' && range.type !== 'ECOSYSTEM') {
    return { reason: `Unsupported range type: ${range.type}` };
  }

  let affected = false;
  for (const event of range.events) {
    const eventType = Object.keys(event)[0];
    if (!eventType) return { reason: 'Range event is empty' };
    const eventVersion = event[eventType];
    if (eventType === 'limit') return { reason: 'limit events are not evaluated' };
    if (eventType !== 'introduced' && eventType !== 'fixed' && eventType !== 'last_affected') {
      return { reason: `Unknown range event type: ${eventType}` };
    }
    if (eventVersion === undefined) return { reason: `Missing version for event: ${eventType}` };
    if (eventType === 'introduced' && eventVersion === '0') {
      affected = true;
      continue;
    }
    if (!semver.valid(eventVersion)) return { reason: `Invalid version boundary for ${eventType}: ${eventVersion}` };
    const comparison = semver.compare(installedVersion, eventVersion);
    if (eventType === 'introduced' && comparison >= 0) affected = true;
    else if (eventType === 'fixed' && comparison >= 0) affected = false;
    else if (eventType === 'last_affected' && comparison > 0) affected = false;
  }
  if (range.events.length === 0) return { reason: 'Range has no events' };
  return { matched: affected };
}

export function evaluateCandidate(candidate: ScanAdvisoryCandidate): CandidateEvaluation {
  if (!semver.valid(candidate.packageVersion)) {
    return uncertain('Installed version is not valid semver', candidate);
  }

  const ranges = StoredRangesSchema.safeParse(candidate.ranges);
  const versions = StoredVersionsSchema.safeParse(candidate.versions);
  const affectedEntries = StoredAffectedEntriesSchema.safeParse(candidate.affectedRanges);
  if (!ranges.success || !versions.success || !affectedEntries.success) {
    return uncertain('Stored affected-version data failed validation', candidate);
  }

  const normalizedName = candidate.packageName.toLowerCase();
  const packageEntries = affectedEntries.data.filter(
    (entry) => entry.package.ecosystem === 'npm' && entry.package.name.toLowerCase() === normalizedName,
  );
  if (packageEntries.length === 0) {
    return uncertain('No matching npm affected entry is available', candidate);
  }
  if (packageEntries.some((entry) => (entry.ranges?.length ?? 0) === 0 && (entry.versions?.length ?? 0) === 0)) {
    return uncertain('Affected package entry has no ranges or versions', candidate);
  }

  let rangeMatched = false;
  let uncertainReason: string | undefined;
  for (const range of ranges.data) {
    const result = evaluateRange(range, candidate.packageVersion);
    if ('reason' in result) {
      uncertainReason ??= result.reason;
      continue;
    }
    rangeMatched ||= result.matched;
  }
  const versionMatched = versions.data.includes(candidate.packageVersion);
  if (uncertainReason) return uncertain(uncertainReason, candidate);
  if (rangeMatched) {
    return {
      matchKind: 'range',
      matchedDetail: {
        packageName: normalizedName,
        installedVersion: candidate.packageVersion,
        matchedRanges: ranges.data.filter((range) => {
          const result = evaluateRange(range, candidate.packageVersion);
          return 'matched' in result && result.matched;
        }),
      },
    };
  }
  if (versionMatched) {
    return {
      matchKind: 'version_list',
      matchedDetail: {
        packageName: normalizedName,
        installedVersion: candidate.packageVersion,
        matchedVersion: candidate.packageVersion,
      },
    };
  }
  return null;
}

export interface MatchScanAlertsResult {
  readonly alertsWritten: number;
}

export async function matchScanAlerts(scanId: string): Promise<MatchScanAlertsResult> {
  const candidates = await getScanAdvisoryCandidates(scanId);
  const alerts: ScanAlertWrite[] = [];
  for (const candidate of candidates) {
    const evaluation = evaluateCandidate(candidate);
    if (!evaluation) continue;
    alerts.push({
      advisoryId: candidate.advisoryId,
      instanceId: candidate.instanceId,
      packageId: candidate.packageId,
      matchKind: evaluation.matchKind,
      matchedDetail: evaluation.matchedDetail,
    });
  }
  await replaceScanAlerts(scanId, alerts);
  return { alertsWritten: alerts.length };
}
