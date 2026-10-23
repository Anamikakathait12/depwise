import Fastify, { type FastifyInstance } from 'fastify';
import { query } from '@npm-alert-triage/storage/db';

export interface ServerOptions {
  readonly logger?: boolean;
  readonly checkDatabase?: () => Promise<void>;
}

export function buildServer(options: ServerOptions = {}): FastifyInstance {
  const server = Fastify({ logger: options.logger ?? true });

  server.get('/health', async (_request, reply) => {
    try {
      if (options.checkDatabase) {
        await options.checkDatabase();
      } else {
        await query('SELECT 1');
      }
      return reply.code(200).send({ status: 'ok' });
    } catch (error: unknown) {
      server.log.error({ err: error }, 'Database health check failed');
      return reply.code(503).send({ status: 'unavailable' });
    }
  });

  return server;
}
