// `pnpm test:postgres`: the postgres project alone, whatever the switch in vitest.config.ts says.
import { defineConfig } from 'vitest/config'
import { postgresProject } from './vitest.projects.ts'

export default defineConfig({ test: { maxWorkers: 1, projects: [postgresProject] } })
