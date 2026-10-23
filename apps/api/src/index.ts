import { close } from '@npm-alert-triage/storage/db';
import { buildServer } from './server.js';

const server = buildServer();
const port = Number(process.env.PORT ?? 3000);
const host = process.env.HOST ?? '0.0.0.0';

try {
  await server.listen({ port, host });
} catch (error: unknown) {
  server.log.error({ err: error }, 'Failed to start HTTP server');
  await close();
  process.exitCode = 1;
}

async function shutdown(): Promise<void> {
  await server.close();
  await close();
}

process.once('SIGINT', () => void shutdown());
process.once('SIGTERM', () => void shutdown());
