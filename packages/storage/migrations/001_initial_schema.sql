-- Up Migration
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TYPE dependency_type AS ENUM ('prod', 'dev', 'optional', 'peer');

CREATE TABLE users (
  id uuid PRIMARY KEY,
  email text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE scans (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status text NOT NULL CHECK (status IN ('queued', 'running', 'completed', 'failed')),
  source text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
-- Supports listing scans for a user and cascaded user deletion.
CREATE INDEX scans_user_id_idx ON scans(user_id);

CREATE TABLE packages (
  id uuid PRIMARY KEY,
  name text NOT NULL,
  version text NOT NULL,
  UNIQUE (name, version)
);

CREATE TABLE dependency_edges (
  scan_id uuid NOT NULL REFERENCES scans(id) ON DELETE CASCADE,
  parent_package_id uuid REFERENCES packages(id),
  child_package_id uuid NOT NULL REFERENCES packages(id),
  dep_type dependency_type NOT NULL,
  UNIQUE NULLS NOT DISTINCT (scan_id, parent_package_id, child_package_id)
);
-- Supports looking up graph children by scan and parent during traversal.
CREATE INDEX dependency_edges_parent_idx ON dependency_edges(scan_id, parent_package_id);
-- Supports the parent_package_id foreign key and reverse package lookups.
CREATE INDEX dependency_edges_parent_package_idx ON dependency_edges(parent_package_id);
-- Supports reverse dependency lookup and package FK maintenance.
CREATE INDEX dependency_edges_child_idx ON dependency_edges(child_package_id);

CREATE TABLE advisories (
  id text PRIMARY KEY,
  summary text NOT NULL,
  details text NOT NULL,
  affected_ranges jsonb NOT NULL,
  severity text,
  published_at timestamptz,
  details_tsv tsvector GENERATED ALWAYS AS (
    to_tsvector('english', coalesce(summary, '') || ' ' || coalesce(details, ''))
  ) STORED,
  embedding vector(1536)
);
-- Supports PostgreSQL full-text retrieval over advisory summary and details.
CREATE INDEX advisories_details_tsv_idx ON advisories USING GIN(details_tsv);

CREATE TABLE verdicts (
  id uuid PRIMARY KEY,
  scan_id uuid NOT NULL REFERENCES scans(id) ON DELETE CASCADE,
  advisory_id text NOT NULL REFERENCES advisories(id),
  package_id uuid NOT NULL REFERENCES packages(id),
  verdict text NOT NULL CHECK (verdict IN ('affected', 'not_affected', 'needs_review')),
  confidence double precision NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
  evidence jsonb NOT NULL,
  reasoning text NOT NULL,
  usage_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
-- Supports finding cached results for the advisory/package/usage identity.
CREATE INDEX verdicts_cache_idx ON verdicts(advisory_id, package_id, usage_hash);
-- Supports retrieving a scan's verdicts and cascaded scan deletion.
CREATE INDEX verdicts_scan_id_idx ON verdicts(scan_id);
-- Supports advisory and package FK maintenance/lookups.
CREATE INDEX verdicts_advisory_id_idx ON verdicts(advisory_id);
CREATE INDEX verdicts_package_id_idx ON verdicts(package_id);

-- Down Migration
DROP TABLE verdicts;
DROP TABLE dependency_edges;
DROP TABLE advisories;
DROP TABLE packages;
DROP TABLE scans;
DROP TABLE users;
DROP TYPE dependency_type;
