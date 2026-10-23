import 'dotenv/config';
import { afterAll, describe, expect, it } from 'vitest';
import { close, query } from './db.js';
import { runner } from 'node-pg-migrate';

describe('migration lifecycle (PostgreSQL integration)', () => {
  afterAll(async () => {
    await close();
  });

  it('runs migration 002 up, down, then up again', async () => {
    const databaseUrl = process.env.DATABASE_URL ?? '';
    expect(databaseUrl, 'DATABASE_URL must be set for integration tests').toBeTruthy();

    await runner({
      databaseUrl,
      dir: 'packages/storage/migrations',
      migrationsTable: 'schema_migrations',
      direction: 'up',
      count: 1,
      logger: { ...console, info: () => undefined, warn: () => undefined, error: console.error },
    });
    expect((await query("SELECT to_regclass('public.scan_package_instances') AS name")).rows[0]?.name)
      .toBe('scan_package_instances');
    expect((await query<{ present: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'dependency_edges'
           AND column_name = 'child_instance_id'
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
    expect((await query("SELECT to_regclass('public.scan_package_instances') AS name")).rows[0]?.name)
      .toBeNull();
    expect((await query<{ present: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'dependency_edges'
           AND column_name = 'child_package_id'
       ) AS present`,
    )).rows[0]?.present).toBe(true);

    await runner({
      databaseUrl,
      dir: 'packages/storage/migrations',
      migrationsTable: 'schema_migrations',
      direction: 'up',
      count: 1,
      logger: { ...console, info: () => undefined, warn: () => undefined, error: console.error },
    });
    expect((await query("SELECT to_regclass('public.scan_package_instances') AS name")).rows[0]?.name)
      .toBe('scan_package_instances');
    expect((await query<{ present: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'dependency_edges'
           AND column_name = 'child_instance_id'
       ) AS present`,
    )).rows[0]?.present).toBe(true);
  });
});
