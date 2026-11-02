import { defineConfig } from 'vitest/config'
import { configDefaults } from 'vitest/config'
import { postgresOnly } from '../../vitest.postgres'

export default defineConfig({
  test: {
    environment: 'node',
    setupFiles: ['./src/test/setup.ts'],
    // Postgres is parked (D1-only MVP): these files need a Postgres database and run only with VAULT_TEST_POSTGRES=1
    // (`pnpm test:postgres`). Suites that run on both engines take their engine list from ENGINE_NAMES instead.
    exclude: [
      ...configDefaults.exclude,
      ...postgresOnly([
        'src/bootstrap.integration.test.ts',
        'src/account/account.integration.test.ts',
        'src/admin/admin.integration.test.ts',
        'src/auth/middleware.integration.test.ts',
        'src/auth/user-auth.integration.test.ts',
        'src/directory/sync.integration.test.ts',
        'src/directory/webhook.integration.test.ts',
        'src/resources/agents.integration.test.ts',
        'src/resources/memberships.integration.test.ts',
        'src/rest/app.integration.test.ts',
        'src/storage/isolation.integration.test.ts',
        'src/test/contract-suite.integration.test.ts',
      ]),
    ],
    // Vitest 4+ removed `poolOptions`; every test file shares one database, so run files serially.
    // The default 5s flakes under CPU load for the D1 golden replays, the over-cap cases and the 20-trial concurrency suites.
    testTimeout: 30_000,
    pool: 'forks',
    fileParallelism: false,
  },
})
