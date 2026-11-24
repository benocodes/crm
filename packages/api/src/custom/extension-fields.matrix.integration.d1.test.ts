import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { ActionKit, Actor } from '../test/action-kit.js'
import {
  ONE_OF_EACH,
  RESOURCES,
  baseBody,
  company,
  every,
  openExtendedKit,
  resetKit,
  pathOf,
  type Resource,
} from '../test/extension-kit.js'

// [[CORE559]] P1, D1, D18, D25: with an `extend` declaring one field of each kind on each of contacts, companies, deals and tasks (applied by [[CORE555]]'s apply), create, get, list and update carry the values over REST and MCP,
// and an enum value outside the declaration is refused. One suite body over the four resources.
let k: ActionKit
let owner: Actor
beforeAll(async () => {
  k = await openExtendedKit(every(ONE_OF_EACH))
})
afterAll(() => k.close())
beforeEach(async () => {
  await resetKit(k)
  owner = k.owner
})

const rpc = async (method: string, params: unknown = {}) =>
  (await k.call(owner, 'POST', '/mcp', { jsonrpc: '2.0', id: 1, method, params })).body as any
const structured = (r: any) => (r.result.structuredContent ?? JSON.parse(r.result.content[0].text)) as any

describe.each(RESOURCES)('%s', (r: Resource) => {
  const values = (parent: string) => ({
    note__c: 'hello',
    seats__c: 12,
    vip__c: true,
    renew__c: '2027-01-02T03:04:05Z',
    tier__c: 'gold',
    parent__c: parent,
  })

  it('create, get, list and update carry the value of every kind (REST)', async () => {
    const parent = await company(k, owner)
    const made = await k.call(owner, 'POST', pathOf(r), { ...(await baseBody(k, owner, r)), ...values(parent) })
    expect(made.status, JSON.stringify(made.body)).toBe(201)
    const want = { ...values(parent), renew__c: '2027-01-02T03:04:05.000Z' }
    expect(made.body).toMatchObject(want)
    const got = await k.call(owner, 'GET', `${pathOf(r)}/${made.body.id}`)
    expect(got.body).toMatchObject(want)
    const listed = await k.call(owner, 'GET', pathOf(r))
    expect(listed.body.data.find((x: any) => x.id === made.body.id)).toMatchObject(want)
    const patched = await k.call(owner, 'PATCH', `${pathOf(r)}/${made.body.id}`, {
      seats__c: 13,
      vip__c: false,
      note__c: null,
      tier__c: 'silver',
    })
    expect(patched.status, JSON.stringify(patched.body)).toBe(200)
    expect(patched.body).toMatchObject({ ...want, seats__c: 13, vip__c: false, note__c: null, tier__c: 'silver' })
  })

  it('a record made without them reads every one as null, and an update naming none changes none', async () => {
    const made = await k.call(owner, 'POST', pathOf(r), await baseBody(k, owner, r))
    expect(made.status, JSON.stringify(made.body)).toBe(201)
    for (const f of Object.keys(ONE_OF_EACH)) expect(made.body[f], f).toBeNull()
    const touched = await k.call(owner, 'PATCH', `${pathOf(r)}/${made.body.id}`, { seats__c: 1 })
    expect(touched.body).toMatchObject({ seats__c: 1, note__c: null, tier__c: null })
  })

  it('an enum value outside the declaration is refused on create and on update; a name nobody declared is refused', async () => {
    const made = await k.call(owner, 'POST', pathOf(r), await baseBody(k, owner, r))
    const bad = await k.call(owner, 'POST', pathOf(r), { ...(await baseBody(k, owner, r, 2)), tier__c: 'bronze' })
    expect([bad.status, bad.body.error.code]).toEqual([400, 'validation_error'])
    const badUpdate = await k.call(owner, 'PATCH', `${pathOf(r)}/${made.body.id}`, { tier__c: 'bronze' })
    expect([badUpdate.status, badUpdate.body.error.code]).toEqual([400, 'validation_error'])
    const unknown = await k.call(owner, 'POST', pathOf(r), { ...(await baseBody(k, owner, r, 3)), colour__c: 'red' })
    expect(unknown.status).toBe(400)
    expect((await k.call(owner, 'GET', `${pathOf(r)}/${made.body.id}`)).body.tier__c).toBeNull()
  })

  it('a value of the wrong type is refused', async () => {
    const body = await baseBody(k, owner, r)
    for (const bad of [{ seats__c: 'x' }, { vip__c: 'yes' }, { renew__c: 'tomorrow' }, { parent__c: 'not-a-uuid' }]) {
      const res = await k.call(owner, 'POST', pathOf(r), { ...body, ...bad })
      expect([res.status, res.body.error.code], JSON.stringify(bad)).toEqual([400, 'validation_error'])
    }
  })

  it('MCP: the tools take and return the fields, and the schemas list them', async () => {
    const tools = (await rpc('tools/list')).result.tools as any[]
    const create = tools.find((t) => t.name === `${r}_create`)
    expect(Object.keys(create.inputSchema.properties)).toEqual(expect.arrayContaining(Object.keys(ONE_OF_EACH)))
    expect(JSON.stringify(create.inputSchema.properties.tier__c)).toMatch(/gold.*silver/)
    const parent = await company(k, owner)
    const body = { ...(await baseBody(k, owner, r)), ...values(parent) }
    const made = await rpc('tools/call', { name: `${r}_create`, arguments: body })
    expect(made.result.isError, JSON.stringify(made)).not.toBe(true)
    const rec = structured(made)
    expect(rec).toMatchObject({ seats__c: 12, vip__c: true, tier__c: 'gold', parent__c: parent })
    const updated = await rpc('tools/call', { name: `${r}_update`, arguments: { id: rec.id, seats__c: 99 } })
    expect(structured(updated)).toMatchObject({ seats__c: 99, tier__c: 'gold' })
    const got = await rpc('tools/call', { name: `${r}_get`, arguments: { id: rec.id } })
    expect(structured(got)).toMatchObject({ seats__c: 99, note__c: 'hello' })
    const refused = await rpc('tools/call', { name: `${r}_update`, arguments: { id: rec.id, tier__c: 'bronze' } })
    expect(refused.result.isError).toBe(true)
  })

  it('OpenAPI: the record, create and update schemas name each field, untranslated (D25)', async () => {
    const doc = (await k.call(owner, 'GET', '/api/v1/openapi.json')).body as any
    const text = JSON.stringify(doc.paths[pathOf(r)])
    for (const f of Object.keys(ONE_OF_EACH)) expect(text, f).toContain(`"${f}"`)
    expect(text).not.toContain('--c')
  })
})
