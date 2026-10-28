import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'scripts/**/*.test.ts'],
    // Miniflare (workerd) starts per file; the api package's 30 s applies here too (CORE41, CORE38 plan).
    testTimeout: 30_000,
    pool: 'forks',
    fileParallelism: false,
  },
})
