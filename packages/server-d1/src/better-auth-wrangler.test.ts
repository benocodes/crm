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
import { clerkKit } from './test/kit.js'

// [[CORE283]] (the CORE259 lesson): the seed and the discovery documents through the REAL wrangler.jsonc bindings (`getPlatformProxy`: the config's own two local D1 databases), not only the test kit's Miniflare.
const CONFIG = fileURLToPath(new URL('../wrangler.jsonc', import.meta.url))
const BASE = 'http://localhost:8787'

describe('the local wrangler.jsonc composition', () => {
  it('bootstrap seeds vibase-cli into the config CONTROL_DB, twice, and the Worker on those bindings serves the discovery documents', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wrangler-clients-'))
    const proxy = await getPlatformProxy<{ DB: D1Like; CONTROL_DB: D1Like }>({
      configPath: CONFIG,
      persist: { path: dir },
      remoteBindings: false,
    })
    try {
      await applyMigrations(proxy.env.DB)
      await applyControlMigrations(proxy.env.CONTROL_DB)
      const opts = {
        organizationName: 'Local',
        authProvider: 'better-auth',
        authOrgId: 'better-auth',
        publicBaseUrl: BASE,
      }
      await bootstrapD1(proxy.env.DB, opts, { control: openControlDb(proxy.env.CONTROL_DB) })
      await bootstrapD1(proxy.env.DB, opts, { control: openControlDb(proxy.env.CONTROL_DB) })
      expect(
        await proxy.env.CONTROL_DB.prepare(
          "select count(*) n from auth_oauth_clients where client_id = 'vibase-cli'",
        ).first(),
      ).toEqual({ n: 1 })
      await expect(proxy.env.DB.prepare('select * from auth_oauth_clients').all()).rejects.toThrow(/no such table/i)

      const worker = composeD1Worker({
        DB: proxy.env.DB,
        CONTROL_DB: proxy.env.CONTROL_DB,
        AUTH_PROVIDER: 'better-auth',
        AUTH_SECRET: 'test-auth-secret-0123456789-abcdefghij-klmnop',
        PUBLIC_BASE_URL: BASE,
      })
      const vibase = (await (await worker.fetch(new Request(`${BASE}/.well-known/vibase`))).json()) as {
        auth: { issuer: string; resource: string }
      }
      expect(vibase.auth).toMatchObject({ issuer: `${BASE}/auth`, resource: BASE })
      const meta = await worker.fetch(new Request(`${BASE}/.well-known/oauth-authorization-server/auth`))
      expect(meta.status).toBe(200)
      expect(((await meta.json()) as { issuer: string }).issuer).toBe(`${BASE}/auth`)
    } finally {
      await proxy.dispose()
      rmSync(dir, { recursive: true, force: true })
    }
  }, 120_000)

  // [[CORE326]] obligation 1: the same real bindings on the two other modes. The control plane is required there too, the two bindings are distinct databases, and the Worker answers once both are migrated and paired.
  it.each(['unset', 'clerk'] as const)(
    "%s: the config's two bindings are distinct databases, and the Worker serves once both are migrated and paired",
    async (mode) => {
      const dir = mkdtempSync(join(tmpdir(), `wrangler-${mode}-`))
      const proxy = await getPlatformProxy<{ DB: D1Like; CONTROL_DB: D1Like }>({
        configPath: CONFIG,
        persist: { path: dir },
        remoteBindings: false,
      })
      try {
        await applyMigrations(proxy.env.DB)
        await applyControlMigrations(proxy.env.CONTROL_DB)
        const kit = await clerkKit()
        const boot = await bootstrapD1(
          proxy.env.DB,
          mode === 'clerk'
            ? { organizationName: 'Local', authProvider: 'clerk', authOrgId: kit.issuer.issuer }
            : {
                organizationName: 'Local',
                authProvider: 'none',
                authOrgId: 'org_local',
                email: 'o@x.test',
                agentName: 'bot',
              },
          { control: openControlDb(proxy.env.CONTROL_DB) },
        )
        const marker = (await proxy.env.CONTROL_DB.prepare(
          'select organization_id from control_deployment',
        ).first()) as {
          organization_id: string
        }
        expect(marker.organization_id).toBe(boot.organizationId)
        await expect(proxy.env.DB.prepare('select * from control_deployment').all()).rejects.toThrow(/no such table/i)
        await expect(proxy.env.CONTROL_DB.prepare('select * from deployment').all()).rejects.toThrow(/no such table/i)

        const env = mode === 'clerk' ? { ...kit.env, CLERK_WEBHOOK_SECRET: undefined } : { AUTH_PROVIDER: '' }
        const worker = composeD1Worker(
          { DB: proxy.env.DB, CONTROL_DB: proxy.env.CONTROL_DB, ...env },
          { fetch: kit.fetch },
        )
        expect((await worker.fetch(new Request(`${BASE}/health`))).status).toBe(200)
        expect((await worker.fetch(new Request(`${BASE}/api/v1/contacts`))).status).toBe(401)
        // Without the binding the same Worker refuses everything but /health.
        const bare = composeD1Worker({ DB: proxy.env.DB, ...env }, { fetch: kit.fetch })
        expect((await bare.fetch(new Request(`${BASE}/health`))).status).toBe(200)
        expect((await bare.fetch(new Request(`${BASE}/api/v1/contacts`))).status).toBe(500)
      } finally {
        await proxy.dispose()
        rmSync(dir, { recursive: true, force: true })
      }
    },
    120_000,
  )
})
