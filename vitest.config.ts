import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.spec.ts'],
    environment: 'node',
    // Run tests serially since some share module-level mocks via vi.mock.
    // Parallel test files are fine; parallel cases within a file are not.
    pool: 'forks',
    poolOptions: {
      forks: {
        singleFork: true,
      },
    },
    testTimeout: 10000,
    hookTimeout: 10000,
  },
  // Allow importing .ts files from src/ during tests.
  resolve: {
    alias: {},
  },
});