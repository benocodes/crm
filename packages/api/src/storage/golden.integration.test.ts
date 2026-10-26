import { readFileSync } from 'node:fs'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { postgresBinding } from '@vault/storage-postgres'
import { d1GoldenBackend, type D1GoldenBackend } from '../test/golden/d1-backend.js'
import { pgGoldenBackend, type PgGoldenBackend } from '../test/golden/pg-backend.js'
import { runScenario } from '../test/golden/runner.js'
import { identityModelScenarios, taskScenarios, type GoldenScenario } from '../test/golden/scenarios.js'

// Golden fixtures (CORE35 D17, CORE36 D12): recorded through the Postgres prepared path only, replayed exactly on
// D1. No legacy oracle, no symbolic comparison, no named engine difference.
const read = (name: string) => JSON.parse(readFileSync(new URL(`../../fixtures/golden/${name}`, import.meta.url), 'utf-8')) as { named_differences: unknown[]; scenarios: Array<{ name: string }> }
const SETS: Array<[string, string, readonly GoldenScenario[]]> = [
  ['tasks', 'tasks.json', taskScenarios],
  ['identity model', 'identity-model.json', identityModelScenarios],
]

describe.each(SETS)('golden fixtures: %s', (_label, file, scenarios) => {
  const fixture = read(file)

  it('cover exactly the recorded scenarios and name no engine difference', () => {
    expect(fixture.scenarios.map((s) => s.name)).toEqual(scenarios.map((s) => s.name))
    expect(fixture.named_differences).toEqual([])
  })

  describe('postgres path', () => {
    let pg: PgGoldenBackend
    beforeAll(() => {
      pg = pgGoldenBackend({ extra: ({ db, clock, newId }) => ({ storage: () => postgresBinding(db), clock, newId }) })
    })
    afterAll(() => pg.close())

    it.each(scenarios.map((s) => [s.name, s] as const))('%s equals the committed fixture exactly', async (_n, scenario) => {
      expect(await runScenario(pg, scenario)).toEqual(fixture.scenarios.find((s) => s.name === scenario.name))
    })
  })

  describe('D1 replay', () => {
    let d1: D1GoldenBackend
    beforeAll(async () => {
      d1 = await d1GoldenBackend()
    })
    afterAll(() => d1.close())

    it.each(scenarios.map((s) => [s.name, s] as const))('%s equals the committed fixture exactly', async (_n, scenario) => {
      expect(await runScenario(d1, scenario)).toEqual(fixture.scenarios.find((s) => s.name === scenario.name))
    })
  })
})
