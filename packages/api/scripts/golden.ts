// Golden fixtures ([[CORE35]] D17, [[CORE36]] D12). `generate` runs the recorded scenarios through the Postgres path
// (enterprise side) and writes deterministic JSON into packages/api/fixtures/golden; `check` regenerates and fails on
// a diff, intended for enterprise CI so the committed fixtures cannot go stale silently. There is no legacy oracle
// and no Postgres-side named difference: the application owns every timestamp on both engines.
//
//   pnpm -C packages/api golden:generate
//   pnpm -C packages/api golden:check
import '@vault/db/test-setup'
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { postgresBinding } from '@vault/storage-postgres'
import { pgGoldenBackend } from '../src/test/golden/pg-backend.js'
import { fixtureText, runScenario } from '../src/test/golden/runner.js'
import { administrationScenarios, identityModelScenarios, taskScenarios, type GoldenScenario } from '../src/test/golden/scenarios.js'

/** The engine differences a fixture names. Empty until D1 fixed-organisation admission ([[CORE41]] D19). */
export const NAMED_DIFFERENCES: Array<{ engine: string; what: string; why: string }> = []

export const FIXTURES = [
  { file: 'tasks.json', resource: 'tasks', scenarios: taskScenarios },
  { file: 'identity-model.json', resource: 'identity-model', scenarios: identityModelScenarios },
  { file: 'administration.json', resource: 'administration', scenarios: administrationScenarios },
] as const

export async function generate(resource: string, scenarios: readonly GoldenScenario[]): Promise<string> {
  const backend = pgGoldenBackend({ extra: ({ db, clock, newId, randomBytes }) => ({ storage: () => postgresBinding(db), clock, newId, randomBytes }) })
  try {
    const transcripts = []
    for (const s of scenarios) transcripts.push(await runScenario(backend, s))
    return fixtureText({ format: 1, resource, generated_by: 'packages/api/scripts/golden.ts (postgres path)', named_differences: NAMED_DIFFERENCES, scenarios: transcripts })
  } finally {
    await backend.close()
  }
}

const target = (file: string) => fileURLToPath(new URL(`../fixtures/golden/${file}`, import.meta.url))
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const mode = process.argv[2]
  if (mode !== 'generate' && mode !== 'check') {
    console.error('usage: golden.ts generate|check')
    process.exit(2)
  }
  let stale = false
  for (const f of FIXTURES) {
    const text = await generate(f.resource, f.scenarios)
    if (mode === 'generate') {
      writeFileSync(target(f.file), text)
      console.log('wrote', target(f.file))
    } else if (readFileSync(target(f.file), 'utf-8') !== text) {
      console.error(`golden fixture ${f.file} is stale: run \`pnpm -C packages/api golden:generate\` and commit the diff`)
      stale = true
    }
  }
  if (mode === 'check') {
    if (stale) process.exit(1)
    console.log('golden fixtures are current')
  }
}
