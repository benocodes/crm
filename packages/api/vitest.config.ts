import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    setupFiles: ['./src/test/setup.ts'],
    // Vitest 4+ removed `poolOptions`; every test file shares one database, so run files serially.
    // The default 5s flakes under CPU load for the D1 golden replays, the over-cap cases and the 20-trial concurrency suites.
    testTimeout: 30_000,
    pool: 'forks',
    fileParallelism: false,
  },
})
