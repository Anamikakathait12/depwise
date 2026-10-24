import { pool, query } from './db.js';

export interface AdvisoryAffectedPackageWrite {
  readonly packageName: string;
  readonly ranges: readonly unknown[];
  readonly versions: readonly string[];
}

export interface AdvisoryWrite {
  readonly id: string;
  readonly summary: string;
  readonly details: string;
  readonly aliases: readonly string[];
  readonly severity: string | null;
  readonly cvss: string | null;
  readonly publishedAt: string | null;
  readonly withdrawnAt: string | null;
  readonly affectedRanges: readonly unknown[];
  readonly affectedPackages: readonly AdvisoryAffectedPackageWrite[];
}

export interface AdvisoryWriteCounts {
  readonly inserted: number;
  readonly updated: number;
}

export interface ScanAdvisoryCandidate {
  readonly advisoryId: string;
  readonly instanceId: string;
  readonly packageId: string;
  readonly packageName: string;
  readonly packageVersion: string;
  readonly ranges: unknown;
  readonly versions: unknown;
  readonly affectedRanges: unknown;
}

export type ScanAlertMatchKind = 'range' | 'version_list' | 'uncertain';

export interface ScanAlertWrite {
  readonly advisoryId: string;
  readonly instanceId: string;
  readonly packageId: string;
  readonly matchKind: ScanAlertMatchKind;
  readonly matchedDetail: Readonly<Record<string, unknown>>;
}

interface ExistingAdvisoryRow {
  readonly id: string;
}

const UPSERT_ADVISORIES_SQL = `
  INSERT INTO advisories
    (id, summary, details, aliases, severity, cvss, published_at, withdrawn_at, affected_ranges)
  SELECT incoming.id, incoming.summary, incoming.details, incoming.aliases,
         incoming.severity, incoming.cvss, incoming.published_at, incoming.withdrawn_at,
         incoming.affected_ranges
  FROM jsonb_to_recordset($1::jsonb) AS incoming(
    id text,
    summary text,
    details text,
    aliases text[],
    severity text,
    cvss text,
    published_at timestamptz,
    withdrawn_at timestamptz,
    affected_ranges jsonb
  )
  ON CONFLICT (id) DO UPDATE SET
    summary = EXCLUDED.summary,
    details = EXCLUDED.details,
    aliases = EXCLUDED.aliases,
    severity = EXCLUDED.severity,
    cvss = EXCLUDED.cvss,
    published_at = EXCLUDED.published_at,
    withdrawn_at = EXCLUDED.withdrawn_at,
    affected_ranges = EXCLUDED.affected_ranges
`;

export async function upsertAdvisoryBatch(records: readonly AdvisoryWrite[]): Promise<AdvisoryWriteCounts> {
  if (records.length === 0) return { inserted: 0, updated: 0 };

  const ids = records.map((record) => record.id);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const existing = await client.query<ExistingAdvisoryRow>(
      'SELECT id FROM advisories WHERE id = ANY($1::text[])',
      [ids],
    );
    await client.query(UPSERT_ADVISORIES_SQL, [JSON.stringify(records.map((record) => ({
      id: record.id,
      summary: record.summary,
      details: record.details,
      aliases: record.aliases,
      severity: record.severity,
      cvss: record.cvss,
      published_at: record.publishedAt,
      withdrawn_at: record.withdrawnAt,
      affected_ranges: record.affectedRanges,
    })))]);

    await client.query('DELETE FROM advisory_affected_packages WHERE advisory_id = ANY($1::text[])', [ids]);
    const affectedRows = records.flatMap((record) => record.affectedPackages.map((affected) => ({
      advisory_id: record.id,
      package_name: affected.packageName,
      ranges: affected.ranges,
      versions: affected.versions,
    })));
    if (affectedRows.length > 0) {
      await client.query(
        `INSERT INTO advisory_affected_packages (advisory_id, package_name, ranges, versions)
         SELECT incoming.advisory_id, incoming.package_name, incoming.ranges, incoming.versions
         FROM jsonb_to_recordset($1::jsonb) AS incoming(
           advisory_id text, package_name text, ranges jsonb, versions text[]
         )`,
        [JSON.stringify(affectedRows)],
      );
    }

    await client.query('COMMIT');
    const updated = existing.rowCount ?? 0;
    return { inserted: records.length - updated, updated };
  } catch (error: unknown) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackError: unknown) {
      console.error('Failed to roll back advisory batch transaction', rollbackError);
    }
    throw error;
  } finally {
    client.release();
  }
}

interface CandidateRow {
  readonly advisory_id: string;
  readonly instance_id: string;
  readonly package_id: string;
  readonly package_name: string;
  readonly package_version: string;
  readonly ranges: unknown;
  readonly versions: unknown;
  readonly affected_ranges: unknown;
}

export async function getScanAdvisoryCandidates(scanId: string): Promise<readonly ScanAdvisoryCandidate[]> {
  const result = await query<CandidateRow>(
    `SELECT affected.advisory_id, instance.id AS instance_id, instance.package_id,
            package.name AS package_name, package.version AS package_version,
            affected.ranges, affected.versions, advisory.affected_ranges
     FROM scan_package_instances instance
     JOIN packages package ON package.id = instance.package_id
     JOIN advisory_affected_packages affected
       ON affected.package_name = lower(package.name)
     JOIN advisories advisory ON advisory.id = affected.advisory_id
     WHERE instance.scan_id = $1
       AND NOT instance.is_link
       AND advisory.withdrawn_at IS NULL`,
    [scanId],
  );
  return result.rows.map((row) => ({
    advisoryId: row.advisory_id,
    instanceId: row.instance_id,
    packageId: row.package_id,
    packageName: row.package_name,
    packageVersion: row.package_version,
    ranges: row.ranges,
    versions: row.versions,
    affectedRanges: row.affected_ranges,
  }));
}

export async function replaceScanAlerts(scanId: string, alerts: readonly ScanAlertWrite[]): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM scan_alerts WHERE scan_id = $1', [scanId]);
    if (alerts.length > 0) {
      await client.query(
        `INSERT INTO scan_alerts
           (scan_id, advisory_id, instance_id, package_id, match_kind, matched_detail)
         SELECT $1::uuid, incoming.advisory_id, incoming.instance_id, incoming.package_id,
                incoming.match_kind, incoming.matched_detail
         FROM jsonb_to_recordset($2::jsonb) AS incoming(
           advisory_id text,
           instance_id uuid,
           package_id uuid,
           match_kind text,
           matched_detail jsonb
         )`,
        [scanId, JSON.stringify(alerts.map((alert) => ({
          advisory_id: alert.advisoryId,
          instance_id: alert.instanceId,
          package_id: alert.packageId,
          match_kind: alert.matchKind,
          matched_detail: alert.matchedDetail,
        })))],
      );
    }
    await client.query('COMMIT');
  } catch (error: unknown) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackError: unknown) {
      console.error('Failed to roll back scan alert replacement', rollbackError);
    }
    throw error;
  } finally {
    client.release();
  }
}
