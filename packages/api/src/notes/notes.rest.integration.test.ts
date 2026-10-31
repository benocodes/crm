import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createVaultRegistry } from '../operations.js'
import type { ContractSession, ContractTenant } from '../test/contract.js'
import { d1Backend } from '../test/d1-backend.js'

// CORE74 over REST on the D1 app: the `include` query parameter and the scopes the HTTP adapter checks.
const FULL = ['notes:read', 'notes:write', 'associations:read', 'associations:write', 'contacts:read', 'contacts:write', 'tasks:read', 'tasks:write']
let s: ContractSession
let t: ContractTenant
beforeAll(async () => {
  s = await d1Backend().open(createVaultRegistry())
})
afterAll(async () => {
  await s.close()
})
beforeEach(async () => {
  t = (await s.reset()).a
})
const call = async (scopes: string[], method: string, path: string, body?: unknown, actor: 'user' | 'agent' = 'agent') => {
  const res = await s.call(t, actor, scopes, method, path, body)
  return { status: res.status, body: res.status === 204 ? null : ((await res.json()) as any) }
}

describe('notes over REST', () => {
  it('an agent writes a note, links it, reads the contact with its links, and the delete removes the edge from the view', async () => {
    const contact = (await call(FULL, 'POST', '/contacts', { name: 'C' })).body
    const note = await call(FULL, 'POST', '/notes', { title: 'T', content: '# Markdown' })
    expect(note.status).toBe(201)
    expect(note.body.created_by).toBe(t.agentId)
    expect((await call(FULL, 'POST', '/associations', { a_type: 'notes', a_id: note.body.id, b_type: 'contacts', b_id: contact.id })).status).toBe(201)
    const view = await call(FULL, 'GET', `/contacts/${contact.id}?include=associations`)
    expect(view.status).toBe(200)
    expect(view.body.associations).toMatchObject([{ neighbour_type: 'notes', neighbour_id: note.body.id }])
    expect(view.body.associations_truncated).toBe(false)
    expect((await call(FULL, 'DELETE', `/notes/${note.body.id}`)).status).toBe(204)
    expect((await call(FULL, 'GET', `/contacts/${contact.id}?include=associations`)).body.associations).toEqual([])
  })

  it('include without associations:read is 403 insufficient_scope naming it; an unknown include value is 400 validation_error', async () => {
    const contact = (await call(FULL, 'POST', '/contacts', { name: 'C' })).body
    const noAssoc = FULL.filter((x) => x !== 'associations:read')
    const denied = await call(noAssoc, 'GET', `/contacts/${contact.id}?include=associations`)
    expect(denied.status).toBe(403)
    expect(denied.body.error.code).toBe('insufficient_scope')
    expect(denied.body.error.message).toContain('associations:read')
    expect((await call(noAssoc, 'GET', `/contacts/${contact.id}`)).status).toBe(200)
    const unknown = await call(FULL, 'GET', `/contacts/${contact.id}?include=everything`)
    expect([unknown.status, unknown.body.error.code]).toEqual([400, 'validation_error'])
  })

  it('an agent without notes:write or notes:read is refused', async () => {
    expect((await call(['notes:read'], 'POST', '/notes', { content: 'c' })).body.error.code).toBe('insufficient_scope')
    expect((await call(['notes:write'], 'GET', '/notes')).body.error.code).toBe('insufficient_scope')
  })
})
