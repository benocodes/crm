// Golden fixtures on the D1 path ([[CORE69]] D19, [[CORE72]]). `generate` runs every recorded scenario through the D1 app (Miniflare, no
// database URL) and writes deterministic JSON into fixtures/golden; `check` regenerates and exits non-zero when a committed fixture
// differs. D1 is the oracle (AGENTS.md "Engines"): the Postgres replay only checks that the parked engine still agrees.
//
//   pnpm -C packages/api golden:generate
//   pnpm -C packages/api golden:check
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { d1GoldenBackend } from '../src/test/golden/d1-backend.js'
import { FIXTURES, NAMED_DIFFERENCES } from '../src/test/golden/fixtures.js'
import { fixtureText, runScenario } from '../src/test/golden/runner.js'
import type { GoldenScenario } from '../src/test/golden/scenarios.js'

export const GENERATED_BY = 'packages/api/scripts/golden.ts (d1 path)'

export async function generate(resource: string, scenarios: readonly GoldenScenario[]): Promise<string> {
  const backend = await d1GoldenBackend()
  try {
    const transcripts = []
    for (const s of scenarios) transcripts.push(await runScenario(backend, s))
    return fixtureText({ format: 1, resource, generated_by: GENERATED_BY, named_differences: NAMED_DIFFERENCES.filter((d) => scenarios.some((s) => s.name === d.scenario)), scenarios: transcripts })
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
    } else {
      let committed: string | undefined
      try {
        committed = readFileSync(target(f.file), 'utf-8')
      } catch {
        committed = undefined
      }
      if (committed !== text) {
        console.error(`golden fixture ${f.file} is stale: run \`pnpm -C packages/api golden:generate\` and commit the diff`)
        stale = true
      }
    }
  }
  if (mode === 'check') {
    if (stale) process.exit(1)
    console.log('golden fixtures are current')
  }
}
