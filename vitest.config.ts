import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['*/test/**/*.test.ts'],
    benchmark: { include: ['*/test/**/*.bench.ts'] },
    environment: 'node',
    testTimeout: 20_000,
    pool: 'threads',
  },
});
