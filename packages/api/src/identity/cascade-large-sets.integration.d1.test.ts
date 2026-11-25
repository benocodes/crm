import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { uuidv7 } from '@vibase/storage'
import { createVibaseRegistry } from '../operations.js'
import { createApp } from '../rest/app.js'
import { openD1Engine, type Engine } from '../test/engines.js'
import { fakeUserAuthenticator, mintTestUserToken } from '../test/user-auth.js'

// [[CORE573]] D15: a delete's cascade reads and `contacts.merge`'s reads are bounded by the cascade cap (5,000), not the default 100, on real rows.
const registry = createVibaseRegistry()
let e: Engine
let app: ReturnType<typeof createApp>
beforeAll(async () => {
  e = await openD1Engine()
})
afterAll(() => e.close())
beforeEach(async () => {
  await e.reset()
  app = createApp({ registry, storage: () => e.binding, userAuthenticator: fakeUserAuthenticator() })
})
const call = async (method: string, path: string, body?: unknown) => {
  const token = mintTestUserToken({
    userId: e.userId,
    organizationId: e.organizationId,
    scopes: registry.declaredScopes(),
    kind: 'user',
  })
  const res = await app.request(path, {
    method,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await res.text()
  return { status: res.status, body: text ? (JSON.parse(text) as any) : null }
}
const stamp = '2026-11-05T09:00:00.000Z'
/** Bulk seeding by one batched statement per 50 rows, on the raw D1 (the suite's own row helpers insert one by one). */
async function bulk(table: string, rows: Record<string, unknown>[]) {
  const cols = Object.keys(rows[0]!)
  const stmt = e.d1!.prepare(`insert into ${table} (${cols.join(', ')}) values (${cols.map(() => '?').join(', ')})`)
  for (let i = 0; i < rows.length; i += 50)
    await e.d1!.batch(rows.slice(i, i + 50).map((r) => stmt.bind(...cols.map((c) => r[c]))))
}
const base = () => ({
  id: uuidv7(),
  created_at: stamp,
  updated_at: stamp,
  organization_id: e.organizationId,
  created_by: e.userId,
})
const edges = (type: string, id: string, n: number) =>
  Array.from({ length: n }, () => ({
    ...base(),
    a_type: type,
    a_id: id,
    b_type: 'tags',
    b_id: uuidv7(),
    relation: 'related_to',
  }))
const n = async (sqlText: string, ...binds: unknown[]) =>
  Number(
    (
      (await e
        .d1!.prepare(sqlText)
        .bind(...binds)
        .first()) as { n: number }
    ).n,
  )
const eventCount = (type: string) => n('select count(*) as n from events where type = ?', type)

describe.each([101, 1000])('a delete with %i linked rows succeeds atomically (D15)', (size) => {
  it('contacts.delete: identities and edges tombstoned, one event each', async () => {
    const c = (await call('POST', '/api/v1/contacts', { name: 'Big' })).body
    await bulk(
      'identities',
      Array.from({ length: size }, (_, i) => ({
        ...base(),
        kind: 'email',
        value: `b${i}@big.test`,
        contact_id: c.id,
        own: 0,
      })),
    )
    await bulk('associations', edges('contacts', c.id, size))
    expect((await call('DELETE', `/api/v1/contacts/${c.id}`)).status).toBe(204)
    expect(await n('select count(*) as n from identities where contact_id = ? and deleted_at is null', c.id)).toBe(0)
    expect(await n('select count(*) as n from associations where a_id = ? and deleted_at is null', c.id)).toBe(0)
    expect(await eventCount('identity.deleted')).toBe(size)
    expect(await eventCount('association.deleted')).toBe(size)
    expect(await eventCount('contact.deleted')).toBe(1)
  })

  it('companies.delete: its contacts unlinked, one contact.updated each', async () => {
    const co = (await call('POST', '/api/v1/companies', { name: 'Big Co' })).body
    await bulk(
      'contacts',
      Array.from({ length: size }, (_, i) => ({ ...base(), name: `P${i}`, company_id: co.id })),
    )
    expect((await call('DELETE', `/api/v1/companies/${co.id}`)).status).toBe(204)
    expect(await n('select count(*) as n from contacts where company_id = ?', co.id)).toBe(0)
    expect(await eventCount('contact.updated')).toBe(size)
  })

  it('deals.delete: its edges tombstoned', async () => {
    const pipeline = (await call('POST', '/meta/v1/pipelines', { name: 'P' })).body
    const stage = (
      await call('POST', '/meta/v1/pipeline-stages', {
        pipeline_id: pipeline.id,
        name: 'Researched',
        kind: 'open',
        position: 10,
      })
    ).body
    const dealRes = await call('POST', '/api/v1/deals', { name: 'D', stage_id: stage.id })
    const deal = dealRes.body
    await bulk('associations', edges('deals', deal.id, size))
    expect((await call('DELETE', `/api/v1/deals/${deal.id}`)).status).toBe(204)
    expect(await n('select count(*) as n from associations where a_id = ? and deleted_at is null', deal.id)).toBe(0)
    expect(await eventCount('association.deleted')).toBe(size)
  })
})

describe('contacts.merge with 1,000 edges on the source (D15)', () => {
  it('re-points every edge to the survivor', async () => {
    const survivor = (await call('POST', '/api/v1/contacts', { name: 'S' })).body
    const source = (await call('POST', '/api/v1/contacts', { name: 'X' })).body
    await bulk('associations', edges('contacts', source.id, 1000))
    const r = await call('POST', `/api/v1/contacts/${survivor.id}/merge`, { source_id: source.id })
    expect(r.status).toBe(200)
    expect(await n('select count(*) as n from associations where a_id = ? and deleted_at is null', survivor.id)).toBe(
      1000,
    )
    expect(await n('select count(*) as n from associations where a_id = ? and deleted_at is null', source.id)).toBe(0)
  })
})

describe('the default cap still bounds a non-cascade set read (D15)', () => {
  it('with maxSetSize 2: identities.resolve of 3 known addresses is 400 set_limit_exceeded, while a 3-identity contact delete passes', async () => {
    const small = await openD1Engine({ maxSetSize: 2 })
    try {
      await small.reset()
      const a = createApp({ registry, storage: () => small.binding, userAuthenticator: fakeUserAuthenticator() })
      const token = mintTestUserToken({
        userId: small.userId,
        organizationId: small.organizationId,
        scopes: registry.declaredScopes(),
        kind: 'user',
      })
      const send = async (method: string, path: string, body?: unknown) => {
        const res = await a.request(path, {
          method,
          headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
          body: body === undefined ? undefined : JSON.stringify(body),
        })
        const text = await res.text()
        return { status: res.status, body: text ? (JSON.parse(text) as any) : null }
      }
      const c = (await send('POST', '/api/v1/contacts', { name: 'T' })).body
      for (const v of ['a', 'b', 'c'])
        await send('POST', '/api/v1/identities', { kind: 'email', value: `${v}@cap.test`, contact_id: c.id })
      const r = await send('POST', '/api/v1/identities/resolve', {
        identities: ['a', 'b', 'c'].map((v) => ({ kind: 'email', value: `${v}@cap.test` })),
      })
      expect([r.status, r.body.error.code]).toEqual([400, 'set_limit_exceeded'])
      expect((await send('DELETE', `/api/v1/contacts/${c.id}`)).status).toBe(204)
    } finally {
      await small.close()
    }
  })
})
