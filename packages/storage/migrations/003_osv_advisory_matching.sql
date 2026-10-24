-- Up Migration
ALTER TABLE advisories
  ADD COLUMN IF NOT EXISTS aliases text[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS withdrawn_at timestamptz,
  ADD COLUMN IF NOT EXISTS cvss text;

CREATE TABLE advisory_affected_packages (
  advisory_id text NOT NULL REFERENCES advisories(id) ON DELETE CASCADE,
  package_name text NOT NULL,
  ranges jsonb NOT NULL DEFAULT '[]'::jsonb,
  versions text[] NOT NULL DEFAULT '{}',
  UNIQUE (advisory_id, package_name)
);

CREATE INDEX advisory_affected_packages_package_name_idx
  ON advisory_affected_packages(package_name);

CREATE TABLE scan_alerts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scan_id uuid NOT NULL REFERENCES scans(id) ON DELETE CASCADE,
  advisory_id text NOT NULL REFERENCES advisories(id) ON DELETE CASCADE,
  instance_id uuid NOT NULL REFERENCES scan_package_instances(id) ON DELETE CASCADE,
  package_id uuid NOT NULL REFERENCES packages(id),
  match_kind text NOT NULL CHECK (match_kind IN ('range', 'version_list', 'uncertain')),
  matched_detail jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (scan_id, advisory_id, instance_id)
);

CREATE INDEX scan_alerts_scan_id_idx ON scan_alerts(scan_id);
CREATE INDEX scan_alerts_advisory_id_idx ON scan_alerts(advisory_id);

-- Down Migration
DROP TABLE scan_alerts;
DROP TABLE advisory_affected_packages;

ALTER TABLE advisories
  DROP COLUMN IF EXISTS cvss,
  DROP COLUMN IF EXISTS withdrawn_at,
  DROP COLUMN IF EXISTS aliases;
