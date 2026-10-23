// Golden fixtures ([[CORE35]] D17). `generate` runs the recorded scenarios through the Postgres path (enterprise
// side) and writes deterministic JSON into packages/api/fixtures/golden; `check` regenerates and fails on a diff,
// intended for enterprise CI so the committed fixtures cannot go stale silently.
//
//   pnpm -C packages/api golden:generate
//   pnpm -C packages/api golden:check
import '@vault/db/test-setup'
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { postgresBinding } from '@vault/storage-postgres'
import { pgGoldenBackend } from '../src/test/golden/pg-backend.js'
import { fixtureText, runScenario } from '../src/test/golden/runner.js'
import { taskScenarios } from '../src/test/golden/scenarios.js'

export const NAMED_DIFFERENCES = [
  {
    engine: 'postgres',
    what: 'the generator disables the tasks updated_at trigger so the stored clock equals the injected clock',
    why: 'production Postgres keeps app.set_updated_at (updated_at = transaction time); D1 and the fixtures use the injected clock. No other difference.',
  },
]

export async function generateTasks(): Promise<string> {
  const backend = pgGoldenBackend({
    freezeUpdatedAt: true,
    extra: ({ db, clock, newId }) => ({ storage: () => postgresBinding(db), clock, newId }),
  })
  try {
    const scenarios = []
    for (const s of taskScenarios) scenarios.push(await runScenario(backend, s))
    return fixtureText({ format: 1, resource: 'tasks', generated_by: 'packages/api/scripts/golden.ts (postgres path)', named_differences: NAMED_DIFFERENCES, scenarios })
  } finally {
    await backend.close()
  }
}

const target = fileURLToPath(new URL('../fixtures/golden/tasks.json', import.meta.url))
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const mode = process.argv[2]
  const text = await generateTasks()
  if (mode === 'generate') {
    writeFileSync(target, text)
    console.log('wrote', target)
  } else if (mode === 'check') {
    if (readFileSync(target, 'utf-8') !== text) {
      console.error('golden fixtures are stale: run `pnpm -C packages/api golden:generate` and commit the diff')
      process.exit(1)
    }
    console.log('golden fixtures are current')
  } else {
    console.error('usage: golden.ts generate|check')
    process.exit(2)
  }
}
