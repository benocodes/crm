import { readFileSync } from 'node:fs'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { postgresBinding } from '@vault/storage-postgres'
import { d1GoldenBackend, type D1GoldenBackend } from '../test/golden/d1-backend.js'
import { pgGoldenBackend, type PgGoldenBackend } from '../test/golden/pg-backend.js'
import { runScenario, symbolic } from '../test/golden/runner.js'
import { taskScenarios } from '../test/golden/scenarios.js'

const read = (name: string) => JSON.parse(readFileSync(new URL(`../../fixtures/golden/${name}`, import.meta.url), 'utf-8'))
const fixture = read('tasks.json') as { scenarios: Array<{ name: string }> }
const legacy = read('legacy-oracle.tasks.json') as { scenarios: Array<{ name: string }> }

describe('golden fixtures (CORE35 D17)', () => {
  it('cover exactly the recorded scenarios', () => {
    const names = taskScenarios.map((s) => s.name)
    expect(fixture.scenarios.map((s) => s.name)).toEqual(names)
    expect(legacy.scenarios.map((s) => s.name)).toEqual(names)
  })

  describe('postgres path', () => {
    let pg: PgGoldenBackend
    beforeAll(() => {
      pg = pgGoldenBackend({ freezeUpdatedAt: true, extra: ({ db, clock, newId }) => ({ storage: () => postgresBinding(db), clock, newId }) })
    })
    afterAll(() => pg.close())

    it.each(taskScenarios.map((s) => [s.name, s] as const))('%s equals the committed fixture exactly and the old service symbolically', async (_n, scenario) => {
      const transcript = await runScenario(pg, scenario)
      expect(transcript).toEqual(fixture.scenarios.find((s) => s.name === scenario.name))
      // The pre-migration service, recorded in Phase 0 (ids and server clock symbolic: it could not inject them).
      expect(symbolic(transcript)).toEqual(legacy.scenarios.find((s) => s.name === scenario.name))
    })
  })

  describe('D1 replay', () => {
    let d1: D1GoldenBackend
    beforeAll(async () => {
      d1 = await d1GoldenBackend()
    })
    afterAll(() => d1.close())

    it.each(taskScenarios.map((s) => [s.name, s] as const))('%s equals the committed fixture exactly (no named differences for tasks)', async (_n, scenario) => {
      expect(await runScenario(d1, scenario)).toEqual(fixture.scenarios.find((s) => s.name === scenario.name))
    })
  })
})
