import { randomUUID } from 'node:crypto';
import { LockfileGraphIntegrityError, type DependencyType, type LockfileGraph } from '@npm-alert-triage/core/lockfile';
import { pool, query } from './db.js';

const MAX_PATH_DEPTH = 50;
const MAX_RETURNED_PATHS = 100;

interface PackageIdRow {
  readonly id: string;
  readonly name: string;
  readonly version: string;
}

interface InstanceIdRow {
  readonly id: string;
  readonly lock_path: string;
}

interface PackagePathRow {
  readonly lock_paths: string[];
  readonly dev_only: boolean;
}

interface BooleanRow {
  readonly reachable: boolean;
}

interface TruncationRow {
  readonly truncated: boolean;
}

export interface PackagePath {
  readonly lockPaths: readonly string[];
  readonly devOnly: boolean;
}

export interface PackagePathsResult {
  readonly paths: readonly PackagePath[];
  readonly truncated: boolean;
}

export interface PersistLockfileGraphResult {
  readonly packageCount: number;
  readonly instanceCount: number;
  readonly edgeCount: number;
  readonly warnings: LockfileGraph['warnings'];
}

function identityKey(name: string, version: string): string {
  return JSON.stringify([name, version]);
}

export async function persistLockfileGraph(
  scanId: string,
  graph: LockfileGraph,
): Promise<PersistLockfileGraphResult> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM scan_package_instances WHERE scan_id = $1', [scanId]);

    const packageIds = graph.packages.map(() => randomUUID());
    const packageRows = await client.query<PackageIdRow>(
      `INSERT INTO packages (id, name, version)
       SELECT incoming.id, incoming.name, incoming.version
       FROM unnest($1::uuid[], $2::text[], $3::text[])
         AS incoming(id, name, version)
       ON CONFLICT (name, version) DO UPDATE SET name = EXCLUDED.name
       RETURNING id, name, version`,
      [packageIds, graph.packages.map((item) => item.name), graph.packages.map((item) => item.version)],
    );

    const packageIdByIdentity = new Map(
      packageRows.rows.map((row) => [identityKey(row.name, row.version), row.id]),
    );
    const instanceIds = graph.instances.map(() => randomUUID());
    const instancePackageIds = graph.instances.map((instance) => {
      const packageId = packageIdByIdentity.get(identityKey(instance.name, instance.version));
      if (!packageId) {
        throw new LockfileGraphIntegrityError(
          `No package row exists for ${instance.name}@${instance.version}`,
        );
      }
      return packageId;
    });

    const instanceRows = await client.query<InstanceIdRow>(
      `INSERT INTO scan_package_instances
         (id, scan_id, package_id, lock_path, is_dev, is_optional, is_peer, is_link)
       SELECT incoming.id, $1::uuid, incoming.package_id, incoming.lock_path,
              incoming.is_dev, incoming.is_optional, incoming.is_peer, incoming.is_link
       FROM unnest($2::uuid[], $3::uuid[], $4::text[], $5::boolean[], $6::boolean[],
                   $7::boolean[], $8::boolean[])
         AS incoming(id, package_id, lock_path, is_dev, is_optional, is_peer, is_link)
       RETURNING id, lock_path`,
      [
        scanId,
        instanceIds,
        instancePackageIds,
        graph.instances.map((item) => item.lockPath),
        graph.instances.map((item) => item.isDev),
        graph.instances.map((item) => item.isOptional),
        graph.instances.map((item) => item.isPeer),
        graph.instances.map((item) => item.isLink),
      ],
    );

    const instanceIdByPath = new Map(instanceRows.rows.map((row) => [row.lock_path, row.id]));
    const parentIds: (string | null)[] = [];
    const childIds: string[] = [];
    const dependencyTypes: DependencyType[] = [];
    for (const edge of graph.edges) {
      const childId = instanceIdByPath.get(edge.childLockPath);
      const parentId = edge.parentLockPath === null ? null : instanceIdByPath.get(edge.parentLockPath);
      if (!childId || (edge.parentLockPath !== null && !parentId)) {
        throw new LockfileGraphIntegrityError(
          `Dependency edge references an absent lockfile path: ${edge.parentLockPath ?? '<root>'} -> ${edge.childLockPath}`,
        );
      }
      parentIds.push(parentId ?? null);
      childIds.push(childId);
      dependencyTypes.push(edge.depType);
    }

    await client.query(
      `INSERT INTO dependency_edges (scan_id, parent_instance_id, child_instance_id, dep_type)
       SELECT $1::uuid, incoming.parent_id, incoming.child_id, incoming.dep_type::dependency_type
       FROM unnest($2::uuid[], $3::uuid[], $4::text[])
         AS incoming(parent_id, child_id, dep_type)`,
      [scanId, parentIds, childIds, dependencyTypes],
    );

    await client.query('COMMIT');
    return {
      packageCount: packageRows.rowCount ?? 0,
      instanceCount: instanceRows.rowCount ?? 0,
      edgeCount: graph.edges.length,
      warnings: graph.warnings,
    };
  } catch (error: unknown) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackError: unknown) {
      console.error('Failed to roll back lockfile graph transaction', rollbackError);
    }
    throw error;
  } finally {
    client.release();
  }
}

const PATHS_TO_PACKAGE_SQL = `
  WITH RECURSIVE ancestors AS (
    SELECT
      instance.id AS current_instance_id,
      ARRAY[instance.id]::uuid[] AS instance_path,
      ARRAY[instance.lock_path]::text[] AS lock_paths,
      instance.is_dev AS dev_only,
      0::integer AS depth,
      false AS is_root
    FROM scan_package_instances instance
    WHERE instance.scan_id = $1
      AND instance.package_id = $2

    UNION ALL

    SELECT
      edge.parent_instance_id AS current_instance_id,
      CASE
        WHEN parent.id IS NULL THEN ancestors.instance_path
        ELSE ancestors.instance_path || parent.id
      END AS instance_path,
      CASE
        WHEN parent.id IS NULL THEN ancestors.lock_paths
        ELSE ARRAY[parent.lock_path]::text[] || ancestors.lock_paths
      END AS lock_paths,
      ancestors.dev_only OR edge.dep_type = 'dev'::dependency_type
        OR coalesce(parent.is_dev, false) AS dev_only,
      ancestors.depth + 1 AS depth,
      edge.parent_instance_id IS NULL AS is_root
    FROM ancestors
    JOIN dependency_edges edge
      ON edge.scan_id = $1
     AND edge.child_instance_id = ancestors.current_instance_id
    LEFT JOIN scan_package_instances parent
      ON parent.id = edge.parent_instance_id
    WHERE ancestors.depth < $3
      AND (parent.id IS NULL OR NOT (parent.id = ANY(ancestors.instance_path)))
  )
  SELECT lock_paths, dev_only
  FROM ancestors
  WHERE is_root
  LIMIT $4
`;

const DEPTH_TRUNCATION_SQL = `
  WITH RECURSIVE ancestors AS (
    SELECT
      instance.id AS current_instance_id,
      ARRAY[instance.id]::uuid[] AS instance_path,
      0::integer AS depth,
      false AS is_root
    FROM scan_package_instances instance
    WHERE instance.scan_id = $1
      AND instance.package_id = $2

    UNION ALL

    SELECT
      edge.parent_instance_id AS current_instance_id,
      CASE
        WHEN parent.id IS NULL THEN ancestors.instance_path
        ELSE ancestors.instance_path || parent.id
      END AS instance_path,
      ancestors.depth + 1 AS depth,
      edge.parent_instance_id IS NULL AS is_root
    FROM ancestors
    JOIN dependency_edges edge
      ON edge.scan_id = $1
     AND edge.child_instance_id = ancestors.current_instance_id
    LEFT JOIN scan_package_instances parent
      ON parent.id = edge.parent_instance_id
    WHERE ancestors.depth < $3
      AND (parent.id IS NULL OR NOT (parent.id = ANY(ancestors.instance_path)))
  )
  SELECT EXISTS (
    SELECT 1
    FROM ancestors frontier
    JOIN dependency_edges edge
      ON edge.scan_id = $1
     AND edge.child_instance_id = frontier.current_instance_id
    LEFT JOIN scan_package_instances parent
      ON parent.id = edge.parent_instance_id
    WHERE frontier.depth >= $3
      AND NOT frontier.is_root
      AND (parent.id IS NULL OR NOT (parent.id = ANY(frontier.instance_path)))
  ) AS truncated
`;

export async function getPathsToPackage(
  scanId: string,
  packageId: string,
  depthCap = MAX_PATH_DEPTH,
): Promise<PackagePathsResult> {
  if (!Number.isInteger(depthCap) || depthCap < 1 || depthCap > MAX_PATH_DEPTH) {
    throw new RangeError(`depthCap must be an integer between 1 and ${MAX_PATH_DEPTH}`);
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await client.query('SET LOCAL statement_timeout = 5000');
    const result = await client.query<PackagePathRow>(PATHS_TO_PACKAGE_SQL, [
      scanId,
      packageId,
      depthCap,
      MAX_RETURNED_PATHS + 1,
    ]);
    const wasPathLimited = result.rows.length > MAX_RETURNED_PATHS;
    const paths = result.rows.slice(0, MAX_RETURNED_PATHS).map((row) => ({
      lockPaths: row.lock_paths,
      devOnly: row.dev_only,
    }));
    const depthResult = wasPathLimited
      ? undefined
      : await client.query<TruncationRow>(DEPTH_TRUNCATION_SQL, [scanId, packageId, depthCap]);
    await client.query('COMMIT');
    return {
      paths,
      truncated: wasPathLimited || (depthResult?.rows[0]?.truncated ?? false),
    };
  } catch (error: unknown) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackError: unknown) {
      console.error('Failed to roll back package path read transaction', rollbackError);
    }
    throw error;
  } finally {
    client.release();
  }
}

const REACHABLE_VIA_PROD_SQL = `
  WITH RECURSIVE production_reachable(instance_id) AS (
    SELECT edge.child_instance_id
    FROM dependency_edges edge
    JOIN scan_package_instances child
      ON child.id = edge.child_instance_id
    WHERE edge.scan_id = $1
      AND edge.parent_instance_id IS NULL
      AND edge.dep_type <> 'dev'::dependency_type
      AND NOT child.is_dev

    UNION

    SELECT edge.child_instance_id
    FROM production_reachable reachable
    JOIN dependency_edges edge
      ON edge.scan_id = $1
     AND edge.parent_instance_id = reachable.instance_id
    JOIN scan_package_instances child
      ON child.id = edge.child_instance_id
    WHERE edge.dep_type <> 'dev'::dependency_type
      AND NOT child.is_dev
  )
  SELECT EXISTS (
    SELECT 1
    FROM production_reachable reachable
    JOIN scan_package_instances instance
      ON instance.id = reachable.instance_id
    WHERE instance.scan_id = $1
      AND instance.package_id = $2
  ) AS reachable
`;

export async function isReachableViaProd(scanId: string, packageId: string): Promise<boolean> {
  const result = await query<BooleanRow>(REACHABLE_VIA_PROD_SQL, [scanId, packageId]);
  return result.rows[0]?.reachable ?? false;
}
