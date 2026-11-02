import { configDefaults, defineConfig } from 'vitest/config'
import { postgresOnly } from '../../vitest.postgres'

export default defineConfig({
  test: {
    environment: 'node',
    // Postgres is parked (D1-only MVP): database-backed suites run only with VAULT_TEST_POSTGRES=1 (`pnpm test:postgres`).
    exclude: [...configDefaults.exclude, ...postgresOnly(['src/**/*.integration.test.ts'])],
    setupFiles: ['./src/test-setup.ts'],
    // Vitest 4+ removed `poolOptions`; every test file shares one database, so run files serially.
    pool: 'forks',
    fileParallelism: false,
  },
})
