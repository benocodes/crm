import { fileURLToPath } from 'node:url'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { getPlatformProxy } from 'wrangler'
import { openControlDb, type D1Like } from '@vibase/storage-d1'
import { applyControlMigrations, applyMigrations } from '@vibase/storage-d1/test'
import { bootstrapD1 } from './bootstrap-d1.js'
import { composeD1Worker } from './compose.js'

// [[CORE283]] (the CORE259 lesson): the seed and the discovery documents through the REAL wrangler.jsonc bindings (`getPlatformProxy`: the config's own two local D1 databases), not only the test kit's Miniflare.
const CONFIG = fileURLToPath(new URL('../wrangler.jsonc', import.meta.url))
const BASE = 'http://localhost:8787'

describe('the local wrangler.jsonc composition', () => {
  it('bootstrap seeds vibase-cli into the config CONTROL_DB, twice, and the Worker on those bindings serves the discovery documents', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wrangler-clients-'))
    const proxy = await getPlatformProxy<{ DB: D1Like; CONTROL_DB: D1Like }>({ configPath: CONFIG, persist: { path: dir }, remoteBindings: false })
    try {
      await applyMigrations(proxy.env.DB)
      await applyControlMigrations(proxy.env.CONTROL_DB)
      const opts = { organizationName: 'Local', authProvider: 'better-auth', authOrgId: 'better-auth', publicBaseUrl: BASE }
      await bootstrapD1(proxy.env.DB, opts, { control: openControlDb(proxy.env.CONTROL_DB) })
      await bootstrapD1(proxy.env.DB, opts, { control: openControlDb(proxy.env.CONTROL_DB) })
      expect((await proxy.env.CONTROL_DB.prepare("select count(*) n from auth_oauth_clients where client_id = 'vibase-cli'").first())).toEqual({ n: 1 })
      await expect(proxy.env.DB.prepare('select * from auth_oauth_clients').all()).rejects.toThrow(/no such table/i)

      const worker = composeD1Worker({ DB: proxy.env.DB, CONTROL_DB: proxy.env.CONTROL_DB, AUTH_PROVIDER: 'better-auth', AUTH_SECRET: 'test-auth-secret-0123456789-abcdefghij-klmnop', PUBLIC_BASE_URL: BASE })
      const vibase = (await (await worker.fetch(new Request(`${BASE}/.well-known/vibase`))).json()) as { auth: { issuer: string; resource: string } }
      expect(vibase.auth).toMatchObject({ issuer: `${BASE}/auth`, resource: BASE })
      const meta = await worker.fetch(new Request(`${BASE}/.well-known/oauth-authorization-server/auth`))
      expect(meta.status).toBe(200)
      expect(((await meta.json()) as { issuer: string }).issuer).toBe(`${BASE}/auth`)
    } finally {
      await proxy.dispose()
      rmSync(dir, { recursive: true, force: true })
    }
  }, 120_000)
})
