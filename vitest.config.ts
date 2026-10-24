import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: [
      'apps/api/src/**/*.test.ts',
      'packages/advisory/src/**/*.test.ts',
      'packages/advisory/src/**/*.integration.test.ts',
      'packages/core/src/**/*.test.ts',
      'packages/storage/**/*.test.ts',
    ],
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
