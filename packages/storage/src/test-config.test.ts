// OPS223 D3/D5: which test projects may run their files side by side. The Postgres suites share one per-worktree database
// (invariant 2), so they stay serial; the default projects (engine-neutral, d1) open a private in-memory D1 per file and may
// run in parallel, but only where a package's `test` script raises the worker count (the root `maxWorkers: 1` is the default).
import { describe, expect, it } from 'vitest'
import postgresConfig from '../../../vitest.postgres.config'
import rootConfig from '../../../vitest.config'
import { d1Project, engineNeutralProject, postgresProject } from '../../../vitest.projects'

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
