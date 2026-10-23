-- Up Migration
CREATE TABLE scan_package_instances (
  id uuid PRIMARY KEY,
  scan_id uuid NOT NULL REFERENCES scans(id) ON DELETE CASCADE,
  package_id uuid NOT NULL REFERENCES packages(id),
  lock_path text NOT NULL,
  is_dev boolean NOT NULL DEFAULT false,
  is_optional boolean NOT NULL DEFAULT false,
  is_peer boolean NOT NULL DEFAULT false,
  is_link boolean NOT NULL DEFAULT false,
  UNIQUE (scan_id, lock_path)
);

-- Preserve existing Phase 1 edges with synthetic paths during migration.
INSERT INTO scan_package_instances (id, scan_id, package_id, lock_path)
SELECT gen_random_uuid(), package_refs.scan_id, package_refs.package_id,
       'legacy/' || package_refs.package_id::text
FROM (
  SELECT scan_id, parent_package_id AS package_id
  FROM dependency_edges
  WHERE parent_package_id IS NOT NULL
  UNION
  SELECT scan_id, child_package_id AS package_id
  FROM dependency_edges
) AS package_refs;

ALTER TABLE dependency_edges
  ADD COLUMN parent_instance_id uuid,
  ADD COLUMN child_instance_id uuid;

UPDATE dependency_edges edge
SET parent_instance_id = parent_instance.id
FROM scan_package_instances parent_instance
WHERE edge.parent_package_id = parent_instance.package_id
  AND edge.scan_id = parent_instance.scan_id;

UPDATE dependency_edges edge
SET child_instance_id = child_instance.id
FROM scan_package_instances child_instance
WHERE edge.child_package_id = child_instance.package_id
  AND edge.scan_id = child_instance.scan_id;

DROP INDEX dependency_edges_parent_idx;
DROP INDEX dependency_edges_parent_package_idx;
DROP INDEX dependency_edges_child_idx;

ALTER TABLE dependency_edges
  DROP CONSTRAINT dependency_edges_parent_package_id_fkey,
  DROP CONSTRAINT dependency_edges_child_package_id_fkey,
  DROP CONSTRAINT dependency_edges_scan_id_parent_package_id_child_package_id_key,
  DROP COLUMN parent_package_id,
  DROP COLUMN child_package_id,
  ALTER COLUMN child_instance_id SET NOT NULL,
  ADD CONSTRAINT dependency_edges_parent_instance_id_fkey
    FOREIGN KEY (parent_instance_id) REFERENCES scan_package_instances(id) ON DELETE CASCADE,
  ADD CONSTRAINT dependency_edges_child_instance_id_fkey
    FOREIGN KEY (child_instance_id) REFERENCES scan_package_instances(id) ON DELETE CASCADE,
  ADD CONSTRAINT dependency_edges_instance_edge_unique
    UNIQUE NULLS NOT DISTINCT (scan_id, parent_instance_id, child_instance_id, dep_type);

CREATE INDEX dependency_edges_parent_instance_idx
  ON dependency_edges(scan_id, parent_instance_id);
CREATE INDEX dependency_edges_child_instance_idx
  ON dependency_edges(scan_id, child_instance_id);
CREATE INDEX scan_package_instances_scan_package_idx
  ON scan_package_instances(scan_id, package_id);

-- Down Migration
DROP INDEX scan_package_instances_scan_package_idx;
DROP INDEX dependency_edges_child_instance_idx;
DROP INDEX dependency_edges_parent_instance_idx;

ALTER TABLE dependency_edges
  DROP CONSTRAINT dependency_edges_instance_edge_unique,
  DROP CONSTRAINT dependency_edges_parent_instance_id_fkey,
  DROP CONSTRAINT dependency_edges_child_instance_id_fkey,
  ADD COLUMN parent_package_id uuid,
  ADD COLUMN child_package_id uuid;

UPDATE dependency_edges edge
SET parent_package_id = parent_instance.package_id
FROM scan_package_instances parent_instance
WHERE edge.parent_instance_id = parent_instance.id;

UPDATE dependency_edges edge
SET child_package_id = child_instance.package_id
FROM scan_package_instances child_instance
WHERE edge.child_instance_id = child_instance.id;

ALTER TABLE dependency_edges
  ALTER COLUMN child_package_id SET NOT NULL,
  ADD CONSTRAINT dependency_edges_parent_package_id_fkey
    FOREIGN KEY (parent_package_id) REFERENCES packages(id),
  ADD CONSTRAINT dependency_edges_child_package_id_fkey
    FOREIGN KEY (child_package_id) REFERENCES packages(id),
  ADD CONSTRAINT dependency_edges_scan_id_parent_package_id_child_package_id_key
    UNIQUE NULLS NOT DISTINCT (scan_id, parent_package_id, child_package_id),
  DROP COLUMN parent_instance_id,
  DROP COLUMN child_instance_id;

CREATE INDEX dependency_edges_parent_idx ON dependency_edges(scan_id, parent_package_id);
CREATE INDEX dependency_edges_parent_package_idx ON dependency_edges(parent_package_id);
CREATE INDEX dependency_edges_child_idx ON dependency_edges(child_package_id);

DROP TABLE scan_package_instances;
