import { readFileSync } from 'node:fs'
import { parse } from 'jsonc-parser'
import { describe, expect, it } from 'vitest'
import { PLACEHOLDER_DATABASE_ID } from '../remote.js'
import { reconcileEnvBlock, type DesiredEnv } from './config-editor.js'
import { REAL_CONFIG_PATH } from './test/world.js'

const real = readFileSync(REAL_CONFIG_PATH, 'utf8')
const UUID = '13f7fb64-d909-44e7-9ce7-cc3c753bb3bc'
const smoked1: DesiredEnv = { env: 'smoked1', workerName: 'vault-smoked1', d1Name: 'vault-smoked1', d1Id: UUID, r2Name: 'vault-smoked1-bodies', apiHost: 'api.smoked1.vibase.ai', corsOrigins: '' }
const acme: DesiredEnv = { env: 'acme', workerName: 'vault-acme', d1Name: 'vault-acme', d1Id: '0f5a1c2e-3b4d-4e6f-8a9b-1c2d3e4f5a6b', r2Name: 'vault-acme-bodies', apiHost: 'api.acme.vibase.ai', corsOrigins: 'https://app.example.com' }

/** True when `a` is `b` with characters only added (no edits, no deletions). */
const onlyAdditions = (a: string, b: string) => {
  let i = 0
  for (const ch of b) if (i < a.length && a[i] === ch) i++
  return i === a.length
}

describe('reconcileEnvBlock (D9)', () => {
  it('the real env.smoked1 is already the desired block: no change, no mismatch, identical bytes', () => {
    const r = reconcileEnvBlock(real, smoked1)
    expect(r.mismatches).toEqual([])
    expect(r.changed).toEqual([])
    expect(r.text).toBe(real)
  })

  it('adds a missing env block beside an existing one and keeps comments and formatting byte-identical', () => {
    const r = reconcileEnvBlock(real, acme)
    expect(r.mismatches).toEqual([])
    expect(r.changed.length).toBeGreaterThan(0)
    expect(onlyAdditions(real, r.text)).toBe(true)
    for (const keep of ['// There is deliberately no account_id', '// vars, d1_databases, r2_buckets and routes are not inherited', '// Local R2 (no account needed)', '// No nodejs_compat']) expect(r.text).toContain(keep)
    const cfg = parse(r.text) as { env: Record<string, Record<string, unknown>> }
    expect(cfg.env.smoked1).toEqual((parse(real) as typeof cfg).env.smoked1)
    expect(cfg.env.acme).toEqual({
      name: 'vault-acme',
      workers_dev: false,
      preview_urls: false,
      routes: [{ pattern: 'api.acme.vibase.ai', custom_domain: true }],
      observability: { enabled: true },
      d1_databases: [{ binding: 'DB', database_name: 'vault-acme', database_id: acme.d1Id, migrations_dir: '../storage-d1/migrations', remote: true }],
      r2_buckets: [{ binding: 'BODIES', bucket_name: 'vault-acme-bodies' }],
      vars: { AUTH_PROVIDER: '', CORS_ALLOWED_ORIGINS: 'https://app.example.com' },
    })
  })

  it('fills only the placeholder database_id of an existing block and keeps the rest', () => {
    const once = reconcileEnvBlock(real, { ...acme, d1Id: PLACEHOLDER_DATABASE_ID }).text
    const r = reconcileEnvBlock(once, acme)
    expect(r.mismatches).toEqual([])
    expect(r.changed).toEqual(['env.acme.d1_databases.DB.database_id'])
    expect(r.text.replace(acme.d1Id, PLACEHOLDER_DATABASE_ID)).toBe(once)
  })

  it('adds a missing key to a partial block without touching the present ones', () => {
    const partial = real.replace('"workers_dev": false,\n      "preview_urls": false,', '"workers_dev": false,')
    const r = reconcileEnvBlock(partial, smoked1)
    expect(r.changed).toEqual(['env.smoked1.preview_urls'])
    expect(onlyAdditions(partial, r.text)).toBe(true)
    expect((parse(r.text) as { env: { smoked1: { preview_urls: boolean } } }).env.smoked1.preview_urls).toBe(false)
  })

  describe('a present value that differs is a mismatch naming the key; the text is returned unchanged', () => {
    const cases: [string, string, DesiredEnv, string][] = [
      ['resource id', real.replace(UUID, '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d'), smoked1, 'env.smoked1.d1_databases.DB.database_id'],
      ['name', real.replace('"name": "vault-smoked1"', '"name": "hand-tuned"'), smoked1, 'env.smoked1.name'],
      ['var', real, { ...smoked1, corsOrigins: 'https://app.example.com' }, 'env.smoked1.vars.CORS_ALLOWED_ORIGINS'],
      ['bucket name', real.replace('"bucket_name": "vault-smoked1-bodies"', '"bucket_name": "other"'), smoked1, 'env.smoked1.r2_buckets.BODIES.bucket_name'],
      ['route', real.replace('"pattern": "api.smoked1.vibase.ai"', '"pattern": "elsewhere.example.com"'), smoked1, 'env.smoked1.routes'],
    ]
    it.each(cases)('%s', (_n, text, desired, key) => {
      const r = reconcileEnvBlock(text, desired)
      expect(r.mismatches).toEqual([key])
      expect(r.text).toBe(text)
      expect(r.changed).toEqual([])
    })
  })

  it('a real database_id where the desired one is the planned placeholder is a mismatch, not an overwrite', () => {
    const r = reconcileEnvBlock(real, { ...smoked1, d1Id: PLACEHOLDER_DATABASE_ID })
    expect(r.mismatches).toEqual(['env.smoked1.d1_databases.DB.database_id'])
  })
})
