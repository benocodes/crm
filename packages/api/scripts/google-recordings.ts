// Rewrites the synthetic Google recordings ([[CHN153]], [[CHN5]] D80): `pnpm -C packages/api recordings:generate`.
// Real recordings (`source: recorded`) are never touched: only files named in SYNTHETIC are written.
import { mkdirSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { buildSyntheticRecordings } from '../src/test/google-recordings.js'

const dir = fileURLToPath(new URL('../src/test/fixtures/google/', import.meta.url))
mkdirSync(dir, { recursive: true })
for (const fx of await buildSyntheticRecordings()) writeFileSync(`${dir}${fx.name}.json`, `${JSON.stringify(fx, null, 2)}\n`)
console.log('synthetic Google recordings written')
