// The default test run (`pnpm test`, `pnpm -r test`): the engine-neutral and d1 projects, and the postgres project
// only while this constant is true. The MVP is D1 only ([[discussions/2026-10-30-d1-only-mvp]]), so it is off.
// Turning it on moves every `*.postgres.test.ts` file into the default run and changes nothing else.
// `pnpm test:postgres` runs the postgres project alone regardless (vitest.postgres.config.ts).
import { defineConfig } from 'vitest/config'
import { d1Project, engineNeutralProject, postgresProject } from './vitest.projects.ts'

const RUN_POSTGRES_PROJECT = false

export default defineConfig({
  test: {
    // One worker by default: the projects share the machine (Miniflare per file) and, with the postgres project on, one database.
    // `@vibase/api`'s `test` script raises it (OPS223 D3/D4); every other package stays serial.
    maxWorkers: 1,
    projects: [engineNeutralProject, d1Project, ...(RUN_POSTGRES_PROJECT ? [postgresProject] : [])],
  },
})
