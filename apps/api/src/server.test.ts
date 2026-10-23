import 'dotenv/config';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildServer } from './server.js';
import { close, query } from '@npm-alert-triage/storage/db';

describe('GET /health (PostgreSQL integration)', () => {
  const server = buildServer({ logger: false });

  beforeAll(async () => {
    expect(process.env.DATABASE_URL, 'DATABASE_URL must be set for integration tests').toBeTruthy();
    await query('SELECT 1');
  });

  afterAll(async () => {
    await server.close();
    await close();
  });

  it('returns healthy when PostgreSQL accepts a connection', async () => {
    const response = await server.inject({ method: 'GET', url: '/health' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ok' });
  });
});
