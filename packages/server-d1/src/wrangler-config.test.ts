import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { unstable_readConfig } from 'wrangler'

const CONFIG = fileURLToPath(new URL('../wrangler.jsonc', import.meta.url))
const PLACEHOLDER = '00000000-0000-0000-0000-000000000000'
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

describe('wrangler.jsonc (OPS4 C2)', () => {
  it('the top level is unchanged and local-only', () => {
    const c = unstable_readConfig({ config: CONFIG })
    expect(c.name).toBe('vault')
    expect(c.d1_databases).toHaveLength(1)
    expect(c.d1_databases[0]!.database_id).toBe(PLACEHOLDER)
    expect(c.routes ?? []).toEqual([])
    expect(c.account_id).toBeUndefined()
  })

  it('env smoked1 has exactly the C2 shape', () => {
    const c = unstable_readConfig({ config: CONFIG, env: 'smoked1' })
    expect(c.name).toBe('vault-smoked1')
    expect(c.workers_dev).toBe(false)
    expect(c.preview_urls).toBe(false)
    expect(c.routes).toEqual([{ pattern: 'api.smoked1.vibase.ai', custom_domain: true }])
    expect(c.observability?.enabled).toBe(true)
    expect(c.d1_databases).toHaveLength(1)
    const db = c.d1_databases[0]!
    expect(db.binding).toBe('DB')
    expect(db.database_name).toBe('vault-smoked1')
    expect(db.remote).toBe(true)
    expect(db.migrations_dir).toMatch(/storage-d1\/migrations$/)
    expect(db.preview_database_id).toBeUndefined()
    expect(c.r2_buckets).toEqual([{ binding: 'BODIES', bucket_name: 'vault-smoked1-bodies' }])
    expect(c.vars).toEqual({ AUTH_PROVIDER: '', CORS_ALLOWED_ORIGINS: '' })
    expect(c.account_id).toBeUndefined()
  })

  it('names no reserved production hostname or environment (D23)', () => {
    const text = readFileSync(CONFIG, 'utf8')
    for (const reserved of ['api.vibase.ai', 'app.vibase.ai', '"production"']) expect(text).not.toContain(reserved)
  })

  it('the smoked1 database id is a uuid', () => {
    const c = unstable_readConfig({ config: CONFIG, env: 'smoked1' })
    expect(c.d1_databases[0]!.database_id).toMatch(UUID)
  })
})
