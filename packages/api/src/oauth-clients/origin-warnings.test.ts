import { describe, expect, it } from 'vitest'
import { oauthClientOperations } from './operations.js'
import type { OAuthClientRow, OAuthClientsPort, OAuthClientsRuntime } from './port.js'
import type { ControlOperation } from '../registry.js'

// [[CORE628]] group 4: the origin warning (D11, P2, P3, P6), a matrix over origin cases, on create and on update, through the operations with an in-memory port.
const API_ORIGIN = 'https://api.test'
const memoryPort = (): { port: OAuthClientsPort; rows: Map<string, OAuthClientRow>; calls: string[] } => {
  const rows = new Map<string, OAuthClientRow>()
  const calls: string[] = []
  const port: OAuthClientsPort = {
    async create(a) {
      calls.push('create')
      const row: OAuthClientRow = {
        clientId: a.clientId,
        name: a.name,
        redirectUris: a.redirectUris,
        scopes: a.scopes,
        skipConsent: a.skipConsent,
        createdAt: a.now,
        updatedAt: a.now,
      }
      rows.set(a.clientId, row)
      return row
    },
    async list() {
      return [...rows.values()]
    },
    async get(a) {
      return rows.get(a.clientId) ?? null
    },
    async delete(a) {
      return rows.delete(a.clientId)
    },
    async update(a) {
      calls.push('update')
      const row = rows.get(a.clientId)
      if (!row) return null
      const next = {
        ...row,
        ...(a.name !== undefined ? { name: a.name } : {}),
        ...(a.redirectUris !== undefined ? { redirectUris: a.redirectUris } : {}),
        ...(a.scopes !== undefined ? { scopes: a.scopes } : {}),
        ...(a.skipConsent !== undefined ? { skipConsent: a.skipConsent } : {}),
        updatedAt: a.now,
      }
      rows.set(a.clientId, next)
      return next
    },
  }
  return { port, rows, calls }
}
const runtime = (port: OAuthClientsPort, corsOrigins: readonly string[]): OAuthClientsRuntime => ({
  port,
  allowedScopes: ['openid', 'offline_access', 'contacts:read'],
  defaultScopes: ['openid', 'offline_access'],
  resources: [API_ORIGIN],
  corsOrigins,
  apiOrigin: API_ORIGIN,
})
const env = {
  organizationId: 'org',
  randomBytes: (n: number) => new Uint8Array(n).fill(7),
  actor: { id: 'owner' },
  now: new Date('2026-11-26T10:00:00Z'),
  newId: () => 'id',
} as never
const ops = (rt: OAuthClientsRuntime) => {
  const all = oauthClientOperations(rt)
  const op = (n: string) => all.find((o) => o.name === n) as ControlOperation
  return {
    create: (body: unknown) => op('oauth_clients.create').run(env, { body } as never) as Promise<any>,
    update: (id: string, body: unknown) =>
      op('oauth_clients.update').run(env, { params: { client_id: id }, body } as never) as Promise<any>,
    get: (id: string) => op('oauth_clients.get').run(env, { params: { client_id: id } } as never) as Promise<any>,
    list: () => op('oauth_clients.list').run(env, {} as never) as Promise<any>,
    del: (id: string) => op('oauth_clients.delete').run(env, { params: { client_id: id } } as never) as Promise<any>,
  }
}
const entry = (origin: string) => ({
  code: 'origin_not_allowed',
  origin,
  list: 'CORS_ALLOWED_ORIGINS',
  message: `${origin} is not in CORS_ALLOWED_ORIGINS: the app's browser calls to the token endpoint and the API will be refused until it is added`,
})

const CASES: Array<[string, string[], string[], string[]]> = [
  // [case, CORS_ALLOWED_ORIGINS, redirect_uris, warned origins]
  ['exact match', ['https://app.test'], ['https://app.test/cb'], []],
  ['wildcard match', ['https://*.app.test'], ['https://x.app.test/cb'], []],
  ['wildcard does not match the bare host', ['https://*.app.test'], ['https://app.test/cb'], ['https://app.test']],
  ['unlisted https origin', ['https://other.test'], ['https://app.test/cb'], ['https://app.test']],
  ['loopback, port differs from the list', ['http://localhost:5199'], ['http://localhost:3000/cb'], ['http://localhost:3000']],
  ['loopback with a port, list has none', ['http://localhost'], ['http://localhost:3000/cb'], ['http://localhost:3000']],
  ['loopback without a port, list has one', ['http://localhost:5199'], ['http://localhost/cb'], ['http://localhost']],
  ['loopback, list matches', ['http://localhost:5199'], ['http://localhost:5199/cb'], []],
  ['two URIs on one origin: one entry', [], ['https://a.test/1', 'https://a.test/2'], ['https://a.test']],
  ['the API own origin is never warned', [], [`${API_ORIGIN}/cb`], []],
  ['empty list: every non-API origin', [], ['https://a.test/cb', `${API_ORIGIN}/cb`, 'http://127.0.0.1:1/cb'], ['https://a.test', 'http://127.0.0.1:1']],
  ['order of first appearance', [], ['https://b.test/cb', 'https://a.test/cb', 'https://b.test/x'], ['https://b.test', 'https://a.test']],
  ['case in the URI: the origin is the lower-cased URL origin', ['https://app.test'], ['https://APP.test/cb'], []],
]

describe('origin warning matrix (D11, P2, P3)', () => {
  it.each(CASES)('%s: on create', async (_n, cors, uris, warned) => {
    const m = memoryPort()
    const rec = await ops(runtime(m.port, cors)).create({ name: 'A', redirect_uris: uris })
    expect(rec.warnings).toEqual(warned.map(entry))
    expect(m.rows.size).toBe(1) // the write happens whatever the warnings say
  })

  it.each(CASES)('%s: on update', async (_n, cors, uris, warned) => {
    const m = memoryPort()
    const o = ops(runtime(m.port, cors))
    const seeded = await o.create({ name: 'A', redirect_uris: ['https://seed.test/cb'] })
    const rec = await o.update(seeded.client_id, { redirect_uris: uris })
    expect(rec.warnings).toEqual(warned.map(entry))
    expect(rec.redirect_uris).toEqual([...new Set(uris)])
  })

  it('a name-only update reports the resulting list (P6)', async () => {
    const m = memoryPort()
    const o = ops(runtime(m.port, []))
    const made = await o.create({ name: 'A', redirect_uris: ['https://a.test/cb'] })
    const rec = await o.update(made.client_id, { name: 'B' })
    expect(rec.name).toBe('B')
    expect(rec.warnings).toEqual([entry('https://a.test')])
  })

  it('warnings is [] when everything matches, and is absent from list, get and delete', async () => {
    const m = memoryPort()
    const o = ops(runtime(m.port, ['https://a.test']))
    const made = await o.create({ name: 'A', redirect_uris: ['https://a.test/cb'] })
    expect(made.warnings).toEqual([])
    expect('warnings' in (await o.get(made.client_id))).toBe(false)
    expect('warnings' in (await o.list()).data[0]).toBe(false)
    expect(await o.del(made.client_id)).toBeUndefined()
  })

  it('create and update answer the D12 keys plus warnings', async () => {
    const m = memoryPort()
    const o = ops(runtime(m.port, []))
    const made = await o.create({ name: 'A', redirect_uris: ['https://a.test/cb'] })
    const keys = ['client_id', 'created_at', 'name', 'redirect_uris', 'scopes', 'skip_consent', 'updated_at', 'warnings']
    expect(Object.keys(made).sort()).toEqual(keys)
    expect(Object.keys(await o.update(made.client_id, { name: 'B' })).sort()).toEqual(keys)
  })
})
