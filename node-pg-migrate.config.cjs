require('dotenv').config();

module.exports = {
  databaseUrl: process.env.DATABASE_URL,
  dir: 'packages/storage/migrations',
  migrationsTable: 'schema_migrations',
  migrationsSchema: 'public',
  direction: 'up',
  checkOrder: true,
};
