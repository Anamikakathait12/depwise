import 'dotenv/config';
import { afterAll, describe, expect, it } from 'vitest';
import { close, query } from './db.js';
import { runner } from 'node-pg-migrate';

describe('migration lifecycle (PostgreSQL integration)', () => {
  afterAll(async () => {
    await close();
  });

  it('runs migration 003 up, down, then up again', async () => {
    const databaseUrl = process.env.DATABASE_URL ?? '';
    expect(databaseUrl, 'DATABASE_URL must be set for integration tests').toBeTruthy();

    await runner({
      databaseUrl,
      dir: 'packages/storage/migrations',
      migrationsTable: 'schema_migrations',
      direction: 'down',
      count: 1,
      logger: { ...console, info: () => undefined, warn: () => undefined, error: console.error },
    });
    await runner({
      databaseUrl,
      dir: 'packages/storage/migrations',
      migrationsTable: 'schema_migrations',
      direction: 'up',
      count: 1,
      logger: { ...console, info: () => undefined, warn: () => undefined, error: console.error },
    });
    expect((await query("SELECT to_regclass('public.advisory_affected_packages') AS name")).rows[0]?.name)
      .toBe('advisory_affected_packages');
    expect((await query("SELECT to_regclass('public.scan_alerts') AS name")).rows[0]?.name)
      .toBe('scan_alerts');
    expect((await query<{ definition: string }>(
      `SELECT pg_get_constraintdef(oid) AS definition
       FROM pg_constraint
       WHERE conrelid = 'public.scan_alerts'::regclass AND contype = 'f'`,
    )).rows.map((row) => row.definition)).toEqual(expect.arrayContaining([
      'FOREIGN KEY (advisory_id) REFERENCES advisories(id) ON DELETE CASCADE',
      'FOREIGN KEY (instance_id) REFERENCES scan_package_instances(id) ON DELETE CASCADE',
    ]));
    expect((await query<{ present: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'advisories'
           AND column_name IN ('aliases', 'withdrawn_at', 'cvss')
         GROUP BY table_name
         HAVING count(*) = 3
       ) AS present`,
    )).rows[0]?.present).toBe(true);

    await runner({
      databaseUrl,
      dir: 'packages/storage/migrations',
      migrationsTable: 'schema_migrations',
      direction: 'down',
      count: 1,
      logger: { ...console, info: () => undefined, warn: () => undefined, error: console.error },
    });
    expect((await query("SELECT to_regclass('public.advisory_affected_packages') AS name")).rows[0]?.name)
      .toBeNull();
    expect((await query("SELECT to_regclass('public.scan_alerts') AS name")).rows[0]?.name).toBeNull();
    expect((await query<{ present: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'advisories'
           AND column_name IN ('aliases', 'withdrawn_at', 'cvss')
       ) AS present`,
    )).rows[0]?.present).toBe(false);
    expect((await query<{ severity_type: string; details_generated: string }>(
      `SELECT severity.data_type AS severity_type, details_tsv.is_generated AS details_generated
       FROM information_schema.columns severity
       JOIN information_schema.columns details_tsv
         ON details_tsv.table_schema = severity.table_schema
        AND details_tsv.table_name = severity.table_name
       WHERE severity.table_schema = 'public' AND severity.table_name = 'advisories'
         AND severity.column_name = 'severity' AND details_tsv.column_name = 'details_tsv'`,
    )).rows[0]).toEqual({ severity_type: 'text', details_generated: 'ALWAYS' });

    await runner({
      databaseUrl,
      dir: 'packages/storage/migrations',
      migrationsTable: 'schema_migrations',
      direction: 'up',
      count: 1,
      logger: { ...console, info: () => undefined, warn: () => undefined, error: console.error },
    });
    expect((await query("SELECT to_regclass('public.advisory_affected_packages') AS name")).rows[0]?.name)
      .toBe('advisory_affected_packages');
    expect((await query("SELECT to_regclass('public.scan_alerts') AS name")).rows[0]?.name)
      .toBe('scan_alerts');
  });
});
