import { defineConfig } from 'vitest/config'
export default defineConfig({
  test: {
    environment: 'node',
    pool: 'forks',
    fileParallelism: false,
    testTimeout: 30000,
    hookTimeout: 60000,
    setupFiles: ['./src/test/setup.ts'],
  },
})
