import 'dotenv/config';
import { Pool, type QueryResult, type QueryResultRow } from 'pg';

const statementTimeoutMs = 5_000;

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 10,
  statement_timeout: statementTimeoutMs,
});

pool.on('error', (error: Error) => {
  console.error('Unexpected idle PostgreSQL client error', error);
});

export async function query<T extends QueryResultRow>(
  text: string,
  values: readonly unknown[] = [],
): Promise<QueryResult<T>> {
  return pool.query<T>(text, [...values]);
}

export async function close(): Promise<void> {
  await pool.end();
}
