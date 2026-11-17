import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createVibaseRegistry } from '../operations.js'
import { createApp } from '../rest/app.js'
import { openD1Engine, type Engine } from '../test/engines.js'
import { fakeUserAuthenticator, mintTestUserToken } from '../test/user-auth.js'

// [[CORE408]] groups 5 and 6: the identities API over an unattached identity (REST and MCP, D1), and the dormancy pin.
const registry = createVibaseRegistry()
const ALL = registry.declaredScopes()
let e: Engine
let app: ReturnType<typeof createApp>
beforeAll(async () => {
  e = await openD1Engine()
})
afterAll(async () => {
  await e.close()
})
beforeEach(async () => {
  await e.reset()
  app = createApp({ registry, storage: () => e.binding, userAuthenticator: fakeUserAuthenticator() })
})
const token = () => mintTestUserToken({ userId: e.userId, organizationId: e.organizationId, scopes: ALL, kind: 'user' })
const call = async (method: string, path: string, body?: unknown) => {
  const res = await app.request(path, {
    method,
    headers: { authorization: `Bearer ${token()}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  return { status: res.status, body: (await res.json()) as any }
}
const unattached = (value: string) => e.insert('identities', { kind: 'email', value, contact_id: null, own: false })
const eventTypes = async () => (await e.events()).map((x) => String(x.type))

describe('identities over an unattached identity (group 5)', () => {
  it('resolve promotes it: created false, the contact is new, identity.updated and contact.created', async () => {
    const un = await unattached('u@x.test')
    const r = await call('POST', '/api/v1/identities/resolve', {
      identities: [{ kind: 'email', value: 'U@x.test', name: 'Una' }],
    })
    expect(r.status).toBe(200)
    expect(r.body.data[0]).toMatchObject({
      created: false,
      contact: { name: 'Una' },
      identity: { id: un.id, own: false },
    })
    expect(r.body.data[0].identity.contact_id).toBe(r.body.data[0].contact.id)
    expect(await eventTypes()).toEqual(['contact.created', 'identity.updated'])
  })

  it('resolve through the MCP tool promotes it the same way', async () => {
    await unattached('m@x.test')
    const res = await app.request('/mcp', {
      method: 'POST',
      headers: { authorization: `Bearer ${token()}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'identities_resolve', arguments: { identities: [{ kind: 'email', value: 'm@x.test' }] } },
      }),
    })
    const out = (await res.json()) as any
    expect(out.result.isError).not.toBe(true)
    expect(JSON.stringify(out.result)).toContain('"created":false')
    expect(await eventTypes()).toEqual(['contact.created', 'identity.updated'])
  })

  it('get and list return it as contact_id null, own false', async () => {
    const un = await unattached('g@x.test')
    const got = await call('GET', `/api/v1/identities/${un.id}`)
    expect(got.status).toBe(200)
    expect(got.body).toMatchObject({ id: un.id, contact_id: null, own: false })
    const list = await call('GET', '/api/v1/identities')
    expect(list.status).toBe(200)
    expect(list.body.data).toHaveLength(1)
    expect(list.body.data[0]).toMatchObject({ id: un.id, contact_id: null, own: false })
  })

  it('update with contact_id attaches it with one identity.updated; with own true makes it own', async () => {
    const a = await unattached('a@x.test')
    const b = await unattached('b@x.test')
    const c = await call('POST', '/api/v1/contacts', { name: 'Held' })
    const up = await call('PATCH', `/api/v1/identities/${a.id}`, { contact_id: c.body.id })
    expect(up.status).toBe(200)
    expect(up.body).toMatchObject({ contact_id: c.body.id, own: false })
    const own = await call('PATCH', `/api/v1/identities/${b.id}`, { own: true })
    expect(own.body).toMatchObject({ contact_id: null, own: true })
    expect((await eventTypes()).filter((t) => t === 'identity.updated')).toHaveLength(2)
  })

  it('create and update without exactly one of contact_id / own: true are still 400 validation_error', async () => {
    const un = await unattached('v@x.test')
    const msg = 'exactly one of contact_id or own: true is required'
    const create = await call('POST', '/api/v1/identities', { kind: 'email', value: 'nobody@x.test' })
    expect(create.status).toBe(400)
    expect(create.body.error).toEqual({ code: 'validation_error', message: msg })
    const c = await call('POST', '/api/v1/contacts', { name: 'C' })
    const both = await call('PATCH', `/api/v1/identities/${un.id}`, { contact_id: c.body.id, own: true })
    expect(both.status).toBe(400)
    expect(both.body.error).toEqual({ code: 'validation_error', message: msg })
    expect(await e.rows('identities')).toHaveLength(1)
  })

  it('creating an identity for an address already held unattached is refused with 409 identity_exists and says so', async () => {
    await unattached('dup@x.test')
    const c = await call('POST', '/api/v1/contacts', { name: 'C' })
    const r = await call('POST', '/api/v1/identities', { kind: 'email', value: 'dup@x.test', contact_id: c.body.id })
    expect(r.status).toBe(409)
    expect(r.body.error).toEqual({
      code: 'identity_exists',
      message: 'the address is already recorded without a contact',
    })
  })
})

describe('catalog and dormancy (group 6)', () => {
  it('schema.get describes the three states of an identity', async () => {
    const r = await call('GET', '/meta/v1/schema')
    expect(r.status).toBe(200)
    const table =
      r.body.tables?.find?.((t: any) => t.name === 'identities') ??
      r.body.data?.tables?.find?.((t: any) => t.name === 'identities')
    expect(table, 'identities in schema.get').toBeDefined()
    expect(table.description).toBe(
      "An address (email or phone) that resolves to a contact's, to the organisation itself when own, or to nobody yet when unattached (captured but not given a contact).",
    )
    const col = table.columns.find((c: any) => c.name === 'contact_id')
    expect(col.description).toBe(
      'The contact the address belongs to; null for an own address of the organisation, or for an unattached address that has no contact yet.',
    )
  })

  // Meant to break in CORE417 (#417), which passes the no-contact choice from capture: delete it there, by name.
  it('no caller of resolveProgram outside identity/ passes the no-contact choice yet', () => {
    const root = join(__dirname, '..')
    const files: string[] = []
    const walk = (dir: string) => {
      for (const f of readdirSync(dir)) {
        const p = join(dir, f)
        if (statSync(p).isDirectory()) walk(p)
        else if (/\.ts$/.test(f) && !/\.test\.ts$/.test(f) && !p.includes(`${join(root, 'test')}`)) files.push(p)
      }
    }
    walk(root)
    const offenders = files.filter((p) => {
      if (p.startsWith(join(root, 'identity'))) return false
      return readFileSync(p, 'utf8').includes('mayCreateContact')
    })
    expect(offenders).toEqual([])
    const users = files.filter(
      (p) => !p.startsWith(join(root, 'identity')) && readFileSync(p, 'utf8').includes('resolveProgram'),
    )
    expect(users.length).toBeGreaterThan(0)
  })
})
