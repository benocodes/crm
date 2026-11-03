import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { parse } from 'jsonc-parser'
import { describe, expect, it } from 'vitest'
import { FIXTURE_CONFIG_PATH } from './test/world.js'

// The setup tests must not read the committed wrangler.jsonc: its env blocks (hq, a fork's own) carry real values that change
// as a team configures a deployment, and a test built on them fails the deploy gate (hq, 2026-11-03).
const SETUP_DIR = fileURLToPath(new URL('.', import.meta.url))

/** The files under scripts/setup (this guard excepted) whose text names the repo's wrangler.jsonc as something to read. */
export const readersOfRealConfig = (files: Record<string, string>): string[] =>
  Object.entries(files)
    .filter(([name]) => !name.endsWith('config-fixture.test.ts'))
    .filter(([, text]) => /(?<!\w)\.\.\/(?:\.\.\/)*wrangler\.jsonc/.test(text) || /new URL\(\s*['"][^'"]*(?<!fixture\.)wrangler\.jsonc/.test(text))
    .map(([name]) => name)

const ownFiles = (dir: string): Record<string, string> => {
  const out: Record<string, string> = {}
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) Object.assign(out, ownFiles(p))
    else if (e.name.endsWith('.ts')) out[p] = readFileSync(p, 'utf8')
  }
  return out
}

describe('the setup tests are independent of the committed wrangler.jsonc', () => {
  it('no file under scripts/setup reads the repo wrangler.jsonc', () => {
    expect(readersOfRealConfig(ownFiles(SETUP_DIR))).toEqual([])
  })

  it('absence mutation: a test that reads the repo file is detected', () => {
    const bad = { 'x.test.ts': "const p = new URL('../../../wrangler.jsonc', import.meta.url)", 'y.ts': "readFileSync('../../wrangler.jsonc')", 'ok.ts': "new URL('./wrangler.fixture.jsonc', import.meta.url)" }
    expect(readersOfRealConfig(bad)).toEqual(['x.test.ts', 'y.ts'])
  })

  it('the fixture is a literal: it has smoked1 and no hq block, whatever the real file holds', () => {
    const cfg = parse(readFileSync(FIXTURE_CONFIG_PATH, 'utf8')) as { env: Record<string, unknown> }
    expect(Object.keys(cfg.env)).toEqual(['smoked1'])
  })
})
