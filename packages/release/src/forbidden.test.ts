import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { assertNoForbidden, envDatabaseIds, scanForbidden } from './forbidden.js'
import { sources } from './fixtures.js'
import { stageRelease } from './stage.js'

const WRANGLER_JSONC = new URL('../../server-d1/wrangler.jsonc', import.meta.url).pathname
const dirs: string[] = []
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })
function clean() {
  const s = sources()
  const outDir = mkdtempSync(join(tmpdir(), 'ops210-out-'))
  dirs.push(s.root, outDir)
  stageRelease({ ...s, outDir })
  return outDir
}
const put = (dir: string, f: string, text: string) => { mkdirSync(dirname(join(dir, f)), { recursive: true }); writeFileSync(join(dir, f), text) }
const realIds = envDatabaseIds(readFileSync(WRANGLER_JSONC, 'utf8'))

describe('D8 forbidden content', () => {
  it('reads every env database_id from the real wrangler.jsonc', () => {
    expect(realIds.length).toBeGreaterThanOrEqual(2)
    for (const id of realIds) expect(id).toMatch(/^[0-9a-f-]{36}$/)
    expect(realIds).not.toContain('00000000-0000-0000-0000-000000000000')
  })
  it('a clean tree passes', () => {
    const d = clean()
    expect(scanForbidden(d, { databaseIds: realIds })).toEqual([])
    expect(() => assertNoForbidden(d, { databaseIds: realIds })).not.toThrow()
  })
  it('a worker bundle holding the bare PEM header literal passes (the Worker checks for it)', () => {
    const d = clean()
    put(d, 'worker/worker.js', 'if (!k.includes("-----BEGIN PUBLIC KEY-----")) throw 1')
    expect(scanForbidden(d, { databaseIds: realIds })).toEqual([])
  })
  const cases: [string, string, string, string][] = [
    ['.env file', '.env', '', 'env-file'],
    ['.env.local file', 'worker/.env.local', 'A=1', 'env-file'],
    ['.dev.vars', '.dev.vars', 'A=1', 'dev-vars'],
    ['wrangler.jsonc', 'wrangler.jsonc', '{}', 'wrangler-config'],
    ['sk_live_', 'worker/worker.js', 'const k = "sk_live_abcdef"', 'sk_live_'],
    ['sk_test_', 'assets/connect/connect.js', 'const k = "sk_test_abcdef"', 'sk_test_'],
    ['a PEM block', 'cli/vibase.js', 'k = "-----BEGIN PRIVATE KEY-----\\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASC"', 'pem'],
    ['an env database_id (first)', 'migrations/0001_a.sql', `-- ${realIds[0]}`, 'database-id'],
    ['an env database_id (last)', 'README.md', `id ${realIds.at(-1)}`, 'database-id'],
  ]
  it.each(cases)('refuses %s naming file and kind', (_n, file, text, kind) => {
    const d = clean()
    put(d, file, text)
    const found = scanForbidden(d, { databaseIds: realIds })
    expect(found).toContainEqual({ file, kind })
    expect(() => assertNoForbidden(d, { databaseIds: realIds })).toThrow(new RegExp(`${file.replace(/[.]/g, '\\.')}.*${kind}|${kind}.*${file.replace(/[.]/g, '\\.')}`))
  })
  it('refuses an env key in wrangler.base.jsonc', () => {
    const d = clean()
    put(d, 'wrangler.base.jsonc', '{ "name": "vault", "env": { "x": {} } }')
    expect(scanForbidden(d, { databaseIds: realIds })).toContainEqual({ file: 'wrangler.base.jsonc', kind: 'env-key' })
  })
  it('every real env id is found, one by one', () => {
    for (const id of realIds) {
      const d = clean()
      put(d, 'worker/worker.js', `x("${id}")`)
      expect(scanForbidden(d, { databaseIds: realIds })).toContainEqual({ file: 'worker/worker.js', kind: 'database-id' })
    }
  })
})
