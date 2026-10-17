import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    setupFiles: ['./src/test-setup.ts'],
    // Vitest 4+ removed `poolOptions`; every test file shares one database, so run files serially.
    pool: 'forks',
    fileParallelism: false,
  },
})
