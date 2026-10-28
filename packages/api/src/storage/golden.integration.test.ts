import { readFileSync } from 'node:fs'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { d1GoldenBackend, type D1GoldenBackend } from '../test/golden/d1-backend.js'
import { pgGoldenBackend, type PgGoldenBackend } from '../test/golden/pg-backend.js'
import { runScenario } from '../test/golden/runner.js'
import { administrationScenarios, authScenarios, directoryScenarios, identityModelScenarios, taskScenarios, type GoldenScenario } from '../test/golden/scenarios.js'
import { NAMED_DIFFERENCES } from '../test/golden/fixtures.js'

// Golden fixtures (CORE35 D17, CORE36 D12): recorded through the Postgres prepared path only, replayed exactly on
// D1. No legacy oracle and no symbolic comparison. The one named engine difference is D1 fixed-organisation admission (CORE41 D19).
type Transcript = { name: string; steps: Array<{ status: number; response: unknown; events: unknown[] }> }
const read = (name: string) => JSON.parse(readFileSync(new URL(`../../fixtures/golden/${name}`, import.meta.url), 'utf-8')) as { named_differences: unknown[]; scenarios: Transcript[] }
const SETS: Array<[string, string, readonly GoldenScenario[]]> = [
  ['tasks', 'tasks.json', taskScenarios],
  ['identity model', 'identity-model.json', identityModelScenarios],
  ['administration', 'administration.json', administrationScenarios],
  ['auth', 'auth.json', authScenarios],
  ['directory', 'directory.json', directoryScenarios],
]

describe.each(SETS)('golden fixtures: %s', (_label, file, scenarios) => {
  const fixture = read(file)

  const named = (engine: string) => NAMED_DIFFERENCES.filter((d) => d.engine === engine && scenarios.some((s) => s.name === d.scenario))
  /** The scenario a named D1 difference is about, replayed on D1 for the D1 outcome rather than for equality. */
  const differs = (scenario: string) => named('d1').some((d) => d.scenario === scenario)

  it('cover exactly the recorded scenarios and name exactly the declared engine differences', () => {
    expect(fixture.scenarios.map((s) => s.name)).toEqual(scenarios.map((s) => s.name))
    expect(fixture.named_differences).toEqual(NAMED_DIFFERENCES.filter((d) => scenarios.some((s) => s.name === d.scenario)))
  })

  describe('postgres path', () => {
    let pg: PgGoldenBackend
    beforeAll(() => {
      pg = pgGoldenBackend()
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

    it.each(scenarios.map((s) => [s.name, s] as const))('%s equals the committed fixture exactly (or the named D1 outcome)', async (_n, scenario) => {
      await d1.reset()
      const seededCounts = await d1.rowCounts()
      const transcript = await runScenario(d1, scenario)
      if (!differs(scenario.name)) {
        expect(
          transcript,
          'D1 replay differs from the committed golden fixture. Fixtures are regenerated only on the enterprise side: ask a maintainer to run pnpm -C packages/server-postgres golden:generate',
        ).toEqual(fixture.scenarios.find((s) => s.name === scenario.name))
        return
      }
      // D19: every step is refused 403 organization_forbidden before any SQL: no event and no new row.
      for (const step of transcript.steps) {
        expect(step.status).toBe(403)
        expect(step.response).toEqual({ error: { code: 'organization_forbidden', message: 'not a member of that organisation' } })
        expect(step.events).toEqual([])
      }
      expect(await d1.rowCounts()).toEqual(seededCounts)
    })
  })
})
