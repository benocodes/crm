import { readFileSync } from 'node:fs'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { d1GoldenBackend, type D1GoldenBackend } from '../test/golden/d1-backend.js'
import type { EngineName } from '../test/engines.js'
import { pgGoldenBackend, type PgGoldenBackend } from '../test/golden/pg-backend.js'
import { runScenario } from '../test/golden/runner.js'
import { administrationScenarios, authScenarios, dealScenarios, directoryScenarios, identityModelScenarios, messagingScenarios, schemaScenarios, tagScenarios, taskScenarios, type GoldenScenario } from '../test/golden/scenarios.js'
import { NAMED_DIFFERENCES } from '../test/golden/fixtures.js'

// Golden fixtures (CORE69 D19-D22, CORE72): generated on the D1 path (`pnpm -C packages/api golden:generate`), the oracle, and
// replayed exactly on D1. The Postgres replay checks that the parked engine still agrees; the one named difference is where it does
// not: a foreign organisation claim is admitted there (CORE36 D19). No legacy oracle and no symbolic comparison.
type Transcript = { name: string; steps: Array<{ status: number; response: unknown; events: Array<{ type: string }> }> }
const read = (name: string) => JSON.parse(readFileSync(new URL(`../../fixtures/golden/${name}`, import.meta.url), 'utf-8')) as { named_differences: unknown[]; scenarios: Transcript[] }
const SETS: Array<[string, string, readonly GoldenScenario[]]> = [
  ['tasks', 'tasks.json', taskScenarios],
  ['identity model', 'identity-model.json', identityModelScenarios],
  ['administration', 'administration.json', administrationScenarios],
  ['auth', 'auth.json', authScenarios],
  ['directory', 'directory.json', directoryScenarios],
  ['messaging', 'messaging.json', messagingScenarios],
  ['tags', 'tags.json', tagScenarios],
  ['deals', 'deals.json', dealScenarios],
  ['schema', 'schema.json', schemaScenarios],
]
/**
 * `messaging.json` replays on D1 only (CORE72 planner decision): the Postgres backend seeds no object store or capture pipeline, and
 * Postgres work is parked (CORE69 non-goals). That is coverage, not a behaviour difference, so it is not a named difference.
 * Reversed when Postgres is un-parked (#89).
 */
const D1_ONLY = new Set(['messaging.json', 'tags.json', 'deals.json', 'schema.json']) // tags.json, deals.json: Postgres has no such tables (CORE129 D16, CORE130 D19); schema.json: schema.get is D1 only (501 on Postgres, API63 D15)
/** What Postgres records for the named scenario (the committed fixture held it before the D1 regeneration): the claim is admitted and the membership created. */
const POSTGRES_CLAIM = { status: 200, response: { data: [], next_cursor: null }, eventTypes: ['membership.created'] }

/** The suite body: one instance per engine entry file (`*.d1.test.ts`, `*.postgres.test.ts`). */
export function engineSuite(engineName: EngineName): void {
  describe.each(SETS.filter(([, file]) => engineName === 'd1' || !D1_ONLY.has(file)))('golden fixtures: %s', (_label, file, scenarios) => {
    const fixture = read(file)

    /** The scenario a named Postgres difference is about: replayed on Postgres for its own outcome rather than for equality. */
    const differs = (scenario: string) => NAMED_DIFFERENCES.some((d) => d.engine === 'postgres' && d.scenario === scenario)

    // Engine-independent (fixtures against scenario definitions): registered once, by the oracle's entry file.
    if (engineName === 'd1') it('cover exactly the recorded scenarios and name exactly the declared engine differences', () => {
      expect(fixture.scenarios.map((s) => s.name)).toEqual(scenarios.map((s) => s.name))
      expect(fixture.named_differences).toEqual(NAMED_DIFFERENCES.filter((d) => scenarios.some((s) => s.name === d.scenario)))
    })

    if (engineName === 'postgres') describe('postgres path', () => {
      let pg: PgGoldenBackend
      beforeAll(() => {
        pg = pgGoldenBackend()
      })
      afterAll(() => pg.close())

      it.each(scenarios.map((s) => [s.name, s] as const))('%s equals the committed fixture exactly (or its named Postgres outcome)', async (_n, scenario) => {
        const transcript = await runScenario(pg, scenario)
        if (!differs(scenario.name)) {
          expect(transcript).toEqual(fixture.scenarios.find((s) => s.name === scenario.name))
          return
        }
        // The parked engine admits the foreign claim (CORE36 D19): the one difference, asserted as its own outcome.
        expect(transcript.steps.map((s) => ({ status: s.status, response: s.response, eventTypes: s.events.map((e) => e.type) }))).toEqual([POSTGRES_CLAIM])
      })
    })

    if (engineName === 'd1') describe('D1 replay', () => {
      let d1: D1GoldenBackend
      beforeAll(async () => {
        d1 = await d1GoldenBackend()
      })
      afterAll(() => d1.close())

      it.each(scenarios.map((s) => [s.name, s] as const))('%s equals the committed fixture exactly', async (_n, scenario) => {
        await d1.reset()
        const seededCounts = await d1.rowCounts()
        const transcript = await runScenario(d1, scenario)
        expect(
          transcript,
          'D1 replay differs from the committed golden fixture. Regenerate on D1 and review the diff: pnpm -C packages/api golden:generate',
        ).toEqual(fixture.scenarios.find((s) => s.name === scenario.name))
        // Equality covers responses and events, not rows: a refused claim must also leave every table as seeded (CORE72, kept from D19).
        if (scenario.name === 'foreign-organisation-claim') expect(await d1.rowCounts()).toEqual(seededCounts)
      })
    })
  })
}
