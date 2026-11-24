import { describe, expect, it } from 'vitest'
import { COLUMN_KINDS } from '@vibase/storage'
import { createVibaseRegistry } from '../operations.js'
import { createApp } from '../rest/app.js'
import { deriveTools } from '../mcp/tools.js'
import { contacts } from '../resources/contacts.js'
import { fakeUserAuthenticator } from '../test/user-auth.js'
import { coldStorage } from '../test/storage.js'
import type { ExtendDeclarations } from './extend.js'

// [[CORE559]] P1 (D23): the seam. With no `extend`, or an empty one, the registry is the registry of today; with one, every registry carries the composed definitions (including the operations that name a built-in's record), and
// nothing module-level changes.
const EXTEND: ExtendDeclarations = {
  contacts: { tier__c: { kind: 'enum', values: ['gold', 'silver'] } },
  deals: { seats__c: { kind: 'integer' } },
}
type Reg = ReturnType<typeof createVibaseRegistry>
const snapshot = async (registry: Reg) => {
  const app = createApp({ storage: coldStorage(), registry, userAuthenticator: fakeUserAuthenticator() })
  return JSON.stringify({
    docs: [
      await (await app.request('/api/v1/openapi.json')).json(),
      await (await app.request('/meta/v1/openapi.json')).json(),
    ],
    tools: deriveTools(registry).map((e) => e.tool),
    scopes: registry.declaredScopes(),
    ops: registry.operations().map((o) => [o.name, o.method, o.path]),
    events: [...registry.eventTypes()],
  })
}

describe('no extend, no change', () => {
  it('a registry built with an empty extend, or empty field lists, equals one built with none', async () => {
    const plain = await snapshot(createVibaseRegistry())
    expect(await snapshot(createVibaseRegistry({ extend: {} }))).toBe(plain)
    expect(await snapshot(createVibaseRegistry({ extend: { contacts: {}, tasks: {} } }))).toBe(plain)
    expect(plain).not.toContain('__c')
  })
})

describe('an extend reaches every definition and every operation that names a record', () => {
  const doc = async (registry: Reg) =>
    (await (
      await createApp({ storage: coldStorage(), registry, userAuthenticator: fakeUserAuthenticator() }).request(
        '/api/v1/openapi.json',
      )
    ).json()) as { paths: Record<string, unknown> }
  const reg = createVibaseRegistry({ extend: EXTEND })

  it('the generated surface of each extended resource names its fields, and no other resource does', async () => {
    const paths = (await doc(reg)).paths
    const has = (p: string, f: string) => JSON.stringify(paths[p]).includes(`"${f}"`)
    expect(has('/api/v1/contacts', 'tier__c')).toBe(true)
    expect(has('/api/v1/contacts/{id}', 'tier__c')).toBe(true)
    expect(has('/api/v1/deals', 'seats__c')).toBe(true)
    expect(has('/api/v1/companies', 'tier__c')).toBe(false)
    expect(has('/api/v1/tasks', 'seats__c')).toBe(false)
    expect(has('/api/v1/deals', 'tier__c')).toBe(false)
  })
  it('the hand-written operations answer with the composed record: resolve, merge and move_stage', async () => {
    const paths = (await doc(reg)).paths
    const has = (p: string, f: string) => JSON.stringify(paths[p]).includes(`"${f}"`)
    expect(has('/api/v1/identities/resolve', 'tier__c')).toBe(true)
    expect(has('/api/v1/contacts/{id}/merge', 'tier__c')).toBe(true)
    expect(has('/api/v1/deals/{id}/move-stage', 'seats__c')).toBe(true)
  })
  it('the queue lists the extended writes and its arguments are the extended ones', () => {
    const op = reg.get('contacts.update') as unknown as { request: { body: { shape: Record<string, unknown> } } }
    expect(Object.keys(op.request.body.shape)).toContain('tier__c')
  })
})

describe('no module-level state', () => {
  it('building an extended registry leaves the module definitions, the column inventory and a later plain registry untouched', async () => {
    const before = JSON.stringify(COLUMN_KINDS)
    const plainBefore = await snapshot(createVibaseRegistry())
    createVibaseRegistry({ extend: EXTEND })
    expect(JSON.stringify(COLUMN_KINDS)).toBe(before)
    expect(Object.keys(contacts.create!.shape)).not.toContain('tier__c')
    expect(Object.keys(contacts.record.shape)).not.toContain('tier__c')
    expect(await snapshot(createVibaseRegistry())).toBe(plainBefore)
  })
  it('two registries in one process each carry their own extend', () => {
    const a = createVibaseRegistry({ extend: { contacts: { a__c: { kind: 'text' } } } })
    const b = createVibaseRegistry({ extend: { contacts: { b__c: { kind: 'text' } } } })
    const keys = (r: Reg) =>
      Object.keys((r.get('contacts.create') as unknown as { request: { body: { shape: object } } }).request.body.shape)
    expect(keys(a)).toContain('a__c')
    expect(keys(a)).not.toContain('b__c')
    expect(keys(b)).toContain('b__c')
    expect(keys(b)).not.toContain('a__c')
  })
})
