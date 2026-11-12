// OPS223 D3/D5: which test projects may run their files side by side. The Postgres suites share one per-worktree database
// (invariant 2), so they stay serial; the default projects (engine-neutral, d1) open a private in-memory D1 per file and may
// run in parallel, but only where a package's `test` script raises the worker count (the root `maxWorkers: 1` is the default).
import { describe, expect, it } from 'vitest'
import { fileURLToPath } from 'node:url'

// Loaded by path, not by a static import: the root config files import each other with `.ts` extensions, which this package's
// `tsc --noEmit` rejects (TS5097). The shapes are read through `any`; the assertions are what matter.
const load = async (file: string): Promise<any> => import(fileURLToPath(new URL(`../../../${file}`, import.meta.url)))
const { d1Project, engineNeutralProject, postgresProject } = await load('vitest.projects.ts')
const postgresConfig = (await load('vitest.postgres.config.ts')).default
const rootConfig = (await load('vitest.config.ts')).default

describe('test project parallelism (OPS223 D3, D5)', () => {
  it('the postgres project runs its files serially', () => {
    expect(postgresProject.test?.fileParallelism).toBe(false)
  })

  it('the postgres-only config keeps one worker', () => {
    expect(postgresConfig.test?.maxWorkers).toBe(1)
  })

  it.each([
    ['engine-neutral', engineNeutralProject],
    ['d1', d1Project],
  ])('the %s project allows file parallelism, in forked processes', (_name, project) => {
    expect(project.test?.fileParallelism).toBe(true)
    expect(project.test?.pool).toBe('forks')
  })

  it('the root default is one worker, so only a package that raises the count runs files in parallel', () => {
    expect(rootConfig.test?.maxWorkers).toBe(1)
  })
})
