import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { openActionKit, type ActionKit, type Actor } from '../test/action-kit.js'

// [[AGT8]] D3-D7, D18, D19, D23, D37, D38, D41, D42 over the real REST app on D1: reviewers, voluntary review, the lifecycle, expiry at the
// boundary instant (injected clock), dedup, edits, the contact merge, events that never leak, and the refusal hint.
let k: ActionKit
let owner: Actor
let writer: Actor
let proposer: Actor
beforeAll(async () => {
  k = await openActionKit()
})
afterAll(() => k.close())
beforeEach(async () => {
  await k.reset()
  owner = k.owner
  writer = await k.actor('writer', 'agent', ['tasks:read', 'tasks:write', 'action_requests:read'])
  proposer = await k.actor('proposer', 'agent', ['tasks:read', 'tasks:request_approval', 'action_requests:read'])
})
const AR = '/api/v1/action-requests'
const task = async (title = 'a') => (await k.call(owner, 'POST', '/api/v1/tasks', { title })).body.id as string
const propose = (who: Actor, args: Record<string, unknown>, extra: Record<string, unknown> = {}, operation = 'tasks.update') => k.call(who, 'POST', AR, { operation, arguments: args, reason: 'because', ...extra })
const titleOf = async (id: string) => (await k.call(owner, 'GET', `/api/v1/tasks/${id}`)).body.title
const rowOf = async (id: string) => (await k.rows('action_requests', 'id = ?', id))[0]!
const code = (r: { status: number; body: any }) => [r.status, r.body?.error?.code]

describe('reviewers (D7, D23, D38)', () => {
  it('a human and a write-capable agent both approve; the approver is the principal of the target events, the proposer of the request', async () => {
    const t1 = await task()
    const t2 = await task()
    const a = (await propose(proposer, { id: t1, title: 'by owner' })).body
    const b = (await propose(owner, { id: t2, title: 'by writer' })).body
    const okOwner = await k.call(owner, 'POST', `${AR}/${a.id}/approve`)
    const okWriter = await k.call(writer, 'POST', `${AR}/${b.id}/approve`)
    expect([okOwner.status, okWriter.status]).toEqual([200, 200])
    expect(okOwner.body).toMatchObject({ status: 'executed', decided_by: owner.id, created_by: proposer.id })
    expect(okWriter.body).toMatchObject({ status: 'executed', decided_by: writer.id, created_by: owner.id })
    expect([await titleOf(t1), await titleOf(t2)]).toEqual(['by owner', 'by writer'])
    const updated = await k.events('task.updated')
    expect(updated.map((e) => e.actor_id)).toEqual([owner.id, writer.id])
  })

  it('proposal-only and read-only reviewers and a writer on the wrong resource get 403 insufficient_scope; the request stays pending', async () => {
    const id = (await propose(proposer, { id: await task(), title: 'x' })).body.id
    const wrong = await k.actor('wrong', 'agent', ['contacts:write', 'tasks:read'])
    const readOnly = await k.actor('readonly', 'agent', ['tasks:read'])
    for (const who of [proposer, readOnly, wrong]) {
      for (const action of ['approve', 'reject']) {
        const r = await k.call(who, 'POST', `${AR}/${id}/${action}`)
        expect(code(r), `${action} as ${who.scopes.join(',')}`).toEqual([403, 'insufficient_scope'])
        expect(r.body.error.message).toContain('tasks:write')
      }
    }
    expect((await rowOf(id)).status).toBe('pending')
  })

  it('a proposal-only agent cannot approve its own request; the same principal as a writer can', async () => {
    const t = await task()
    const id = (await propose(proposer, { id: t, title: 'self' })).body.id
    expect(code(await k.call(proposer, 'POST', `${AR}/${id}/approve`))).toEqual([403, 'insufficient_scope'])
    const asWriter = k.as(proposer, ['tasks:write'])
    const ok = await k.call(asWriter, 'POST', `${AR}/${id}/approve`)
    expect(ok.status).toBe(200)
    expect(ok.body).toMatchObject({ created_by: proposer.id, decided_by: proposer.id })
  })

  it('an edit that changes the target id is validated and authorised as the new target; an edit naming a missing record is the target\'s 404 and leaves the request pending', async () => {
    const t1 = await task('one')
    const t2 = await task('two')
    const id = (await propose(proposer, { id: t1, title: 'x' })).body.id
    const missing = await k.call(writer, 'POST', `${AR}/${id}/approve`, { edited_arguments: { id: '0190b2c4-0000-7000-8000-00000000dead', title: 'y' } })
    expect(code(missing)).toEqual([404, 'not_found'])
    expect((await rowOf(id)).status).toBe('pending')
    const bad = await k.call(writer, 'POST', `${AR}/${id}/approve`, { edited_arguments: { id: t2, title: '' } })
    expect(code(bad)).toEqual([400, 'validation_error'])
    expect((await rowOf(id)).status).toBe('pending')
    const ok = await k.call(writer, 'POST', `${AR}/${id}/approve`, { edited_arguments: { id: t2, title: 'edited' }, decision_reason: 'right task' })
    expect(ok.status).toBe(200)
    expect([await titleOf(t1), await titleOf(t2)]).toEqual(['one', 'edited'])
    expect(ok.body).toMatchObject({ arguments: { id: t1, title: 'x' }, edited_arguments: { id: t2, title: 'edited' }, decision_reason: 'right task' })
  })

  it('an edit is authorised with the reviewer\'s own reads: an association edited onto a type the reviewer cannot read is refused', async () => {
    const t = await task()
    const c = (await k.call(owner, 'POST', '/api/v1/contacts', { name: 'C' })).body.id
    const co = (await k.call(owner, 'POST', '/api/v1/companies', { name: 'Co' })).body.id
    const reviewer = await k.actor('assoc-reviewer', 'agent', ['associations:write', 'tasks:read', 'contacts:read'])
    const p = await k.actor('assoc-proposer', 'agent', ['associations:request_approval', 'tasks:read', 'contacts:read'])
    const id = (await propose(p, { a_type: 'tasks', a_id: t, b_type: 'contacts', b_id: c }, {}, 'associations.create')).body.id
    const r = await k.call(reviewer, 'POST', `${AR}/${id}/approve`, { edited_arguments: { a_type: 'tasks', a_id: t, b_type: 'companies', b_id: co } })
    expect(code(r)).toEqual([403, 'insufficient_scope'])
    expect(r.body.error.message).toContain('companies:read')
    expect((await rowOf(id)).status).toBe('pending')
  })

  it('no users-only decided_by key remains: decided_by, created_by reference principals', async () => {
    const fks = (await k.d1.prepare('pragma foreign_key_list(action_requests)').all()).results as Array<{ from: string; table: string }>
    expect(fks.filter((f) => ['decided_by', 'created_by'].includes(f.from)).map((f) => `${f.from}->${f.table}`).sort()).toEqual(['created_by->principals', 'decided_by->principals'])
  })

  it('list and get need action_requests:read, creating needs only the target authority (D38)', async () => {
    const id = (await propose(proposer, { id: await task(), title: 'x' })).body.id
    const blind = await k.actor('blind', 'agent', ['tasks:request_approval', 'tasks:read'])
    expect(code(await k.call(blind, 'GET', AR))).toEqual([403, 'insufficient_scope'])
    expect(code(await k.call(blind, 'GET', `${AR}/${id}`))).toEqual([403, 'insufficient_scope'])
    expect((await propose(blind, { id: await task(), title: 'y' })).status).toBe(201)
    const list = await k.call(proposer, 'GET', `${AR}?status=pending&operation=tasks.update&created_by=${proposer.id}`)
    expect(list.status).toBe(200)
    expect(list.body.data.map((r: any) => r.id)).toEqual([id])
  })
})

describe('voluntary review (D6)', () => {
  it('a write-capable agent\'s request leaves the target untouched until approval; events name both identities', async () => {
    const t = await task('before')
    const created = await propose(writer, { id: t, title: 'after' })
    expect(created.status).toBe(201)
    expect(await titleOf(t)).toBe('before')
    expect(await k.events('task.updated')).toEqual([])
    const stronger = await k.actor('stronger', 'agent', ['tasks:read', 'tasks:write'])
    const ok = await k.call(stronger, 'POST', `${AR}/${created.body.id}/approve`)
    expect(ok.status).toBe(200)
    expect(await titleOf(t)).toBe('after')
    const events = await k.rows('events', "type like 'action_request.%' or type = 'task.updated'")
    expect(events.map((e) => [e.type, e.actor_id])).toEqual([
      ['action_request.created', writer.id],
      ['task.updated', stronger.id],
      ['action_request.approved', stronger.id],
      ['action_request.executed', stronger.id],
    ])
    expect((await rowOf(created.body.id)).created_by).toBe(writer.id)
  })
})

describe('lifecycle (D3, D4, D5, D37)', () => {
  it('reject and withdraw end it; every later decision is 409 action_request_not_pending naming the status', async () => {
    const rej = (await propose(proposer, { id: await task(), title: 'x' })).body.id
    const wd = (await propose(proposer, { id: await task(), title: 'x' })).body.id
    const ap = (await propose(proposer, { id: await task(), title: 'x' })).body.id
    expect((await k.call(writer, 'POST', `${AR}/${rej}/reject`, { decision_reason: 'no' })).body).toMatchObject({ status: 'rejected', decided_by: writer.id, decision_reason: 'no' })
    expect((await k.call(proposer, 'POST', `${AR}/${wd}/withdraw`)).body).toMatchObject({ status: 'withdrawn', decided_by: proposer.id })
    expect((await k.call(writer, 'POST', `${AR}/${ap}/approve`)).body.status).toBe('executed')
    for (const [id, status] of [[rej, 'rejected'], [wd, 'withdrawn'], [ap, 'executed']] as const) {
      for (const action of ['approve', 'reject']) {
        const r = await k.call(writer, 'POST', `${AR}/${id}/${action}`)
        expect(code(r), `${action} ${status}`).toEqual([409, 'action_request_not_pending'])
        expect(r.body.error.message).toContain(status)
      }
      const w = await k.call(proposer, 'POST', `${AR}/${id}/withdraw`)
      expect(code(w), `withdraw ${status}`).toEqual([409, 'action_request_not_pending'])
      expect(w.body.error.message).toContain(status)
    }
  })

  it('the original arguments never change, even after an edited approval; an unknown id is 404', async () => {
    const t = await task()
    const id = (await propose(proposer, { id: t, title: 'orig' })).body.id
    await k.call(writer, 'POST', `${AR}/${id}/approve`, { edited_arguments: { id: t, title: 'edited' } })
    const row = await rowOf(id)
    expect(row.arguments).toEqual({ id: t, title: 'orig' })
    expect(row.edited_arguments).toEqual({ id: t, title: 'edited' })
    expect(code(await k.call(writer, 'POST', `${AR}/0190b2c4-0000-7000-8000-00000000dead/approve`))).toEqual([404, 'not_found'])
  })

  it('withdraw is the source\'s only, and still needs its proposal authority on the target', async () => {
    const id = (await propose(proposer, { id: await task(), title: 'x' })).body.id
    const other = k.as(writer, ['tasks:write'])
    expect(code(await k.call(other, 'POST', `${AR}/${id}/withdraw`))).toEqual([403, 'not_request_source'])
    expect(code(await k.call(k.as(proposer, ['tasks:read']), 'POST', `${AR}/${id}/withdraw`))).toEqual([403, 'insufficient_scope'])
    expect((await rowOf(id)).status).toBe('pending')
  })

  it('expires_at defaults to seven days, is never past, and is at most thirty days ahead', async () => {
    const t = await task()
    const at = k.now().getTime()
    const ok = await propose(proposer, { id: t, title: 'x' })
    expect(Date.parse(ok.body.expires_at)).toBe(at + 7 * 86_400_000)
    for (const [expires, label] of [[at, 'now'], [at - 1000, 'past'], [at + 31 * 86_400_000, 'too far']] as const) {
      const r = await propose(proposer, { id: t, title: 'x' }, { expires_at: new Date(expires).toISOString() })
      expect(code(r), label).toEqual([400, 'validation_error'])
    }
    expect((await propose(proposer, { id: t, title: 'x' }, { expires_at: new Date(at + 30 * 86_400_000).toISOString() })).status).toBe(201)
  })

  it('at the expiry instant approve and reject answer 409 action_request_expired and write nothing; one millisecond earlier they decide; withdraw still succeeds', async () => {
    const t = await task('start')
    const soon = new Date(k.now().getTime() + 60_000)
    const mk = async () => (await propose(proposer, { id: t, title: 'late' }, { expires_at: soon.toISOString() })).body.id as string
    const [a, r, w, early] = [await mk(), await mk(), await mk(), await mk()]
    k.setNow(new Date(soon.getTime() - 1))
    expect((await k.call(writer, 'POST', `${AR}/${early}/approve`)).status).toBe(200)
    k.setNow(soon)
    const eventsBefore = (await k.events()).length
    expect(code(await k.call(writer, 'POST', `${AR}/${a}/approve`))).toEqual([409, 'action_request_expired'])
    expect(code(await k.call(writer, 'POST', `${AR}/${r}/reject`))).toEqual([409, 'action_request_expired'])
    expect((await k.events()).length).toBe(eventsBefore)
    expect([(await rowOf(a)).status, (await rowOf(r)).status]).toEqual(['pending', 'pending'])
    expect((await k.call(proposer, 'POST', `${AR}/${w}/withdraw`)).body.status).toBe('withdrawn')
  })
})

describe('dedup (D5, D37)', () => {
  it('the same source supersedes its own pending request; another source is 409 duplicate_action_request', async () => {
    const t = await task()
    const first = (await propose(proposer, { id: t, title: 'v1' }, { dedup_key: 'k1' })).body
    const second = await propose(proposer, { id: t, title: 'v2' }, { dedup_key: 'k1' })
    expect(second.status).toBe(201)
    expect(await rowOf(first.id)).toMatchObject({ status: 'superseded', superseded_by_id: second.body.id, decided_by: proposer.id })
    expect(await rowOf(second.body.id)).toMatchObject({ status: 'pending' })
    expect((await k.events('action_request.superseded')).map((e) => [e.resource_id, e.after.superseded_by_id])).toEqual([[first.id, second.body.id]])
    const other = await propose(writer, { id: t, title: 'v3' }, { dedup_key: 'k1' })
    expect(code(other)).toEqual([409, 'duplicate_action_request'])
    expect((await k.rows('action_requests', "status = 'pending'")).map((r) => r.id)).toEqual([second.body.id])
    // A different key, or none, is independent.
    expect((await propose(writer, { id: t, title: 'v4' }, { dedup_key: 'k2' })).status).toBe(201)
    expect((await propose(writer, { id: t, title: 'v5' })).status).toBe(201)
  })

  it('an expired holder is marked expired by the system principal in the same unit, then the new request is created (any source)', async () => {
    const t = await task()
    const soon = new Date(k.now().getTime() + 1000)
    const stale = (await propose(proposer, { id: t, title: 'old' }, { dedup_key: 'k', expires_at: soon.toISOString() })).body
    k.setNow(soon)
    const fresh = await propose(writer, { id: t, title: 'new' }, { dedup_key: 'k' })
    expect(fresh.status).toBe(201)
    const sys = (await k.rows('principals', "kind = 'system'"))[0]!
    expect(await rowOf(stale.id)).toMatchObject({ status: 'expired', decided_by: sys.id })
    const expired = await k.events('action_request.expired')
    expect(expired.map((e) => [e.resource_id, e.actor_id])).toEqual([[stale.id, sys.id]])
    // Empty state: no holder, the key is simply free.
    expect((await propose(writer, { id: t, title: 'free' }, { dedup_key: 'unused' })).status).toBe(201)
  })
})

describe('contact merge (D19)', () => {
  it('moves context contact_id to the survivor, leaves arguments untouched, and emits the update', async () => {
    const keep = (await k.call(owner, 'POST', '/api/v1/contacts', { name: 'Keep' })).body.id
    const fold = (await k.call(owner, 'POST', '/api/v1/contacts', { name: 'Fold' })).body.id
    const t = await task()
    const reader = await k.actor('reader', 'agent', ['tasks:request_approval', 'tasks:read', 'contacts:read'])
    const req = (await propose(reader, { id: t, title: 'x' }, { contact_id: fold })).body
    const merged = await k.call(owner, 'POST', `/api/v1/contacts/${keep}/merge`, { source_id: fold })
    expect(merged.status).toBe(200)
    expect(await rowOf(req.id)).toMatchObject({ contact_id: keep, arguments: { id: t, title: 'x' }, status: 'pending' })
    expect((await k.events('action_request.updated')).map((e) => [e.resource_id, e.before.contact_id, e.after.contact_id, e.actor_id])).toEqual([[req.id, fold, keep, owner.id]])
  })
})

describe('events never leak (D18, D41)', () => {
  it('every action_request.* event on every path carries exactly the fields the reader of action_requests:read sees, and no secret', async () => {
    const t = await task()
    const c1 = (await k.call(owner, 'POST', '/api/v1/contacts', { name: 'Keep' })).body.id
    const c2 = (await k.call(owner, 'POST', '/api/v1/contacts', { name: 'Fold' })).body.id
    const reader = await k.actor('r2', 'agent', ['tasks:request_approval', 'tasks:read', 'contacts:read', 'action_requests:read'])
    const soon = new Date(k.now().getTime() + 1000)
    const created = (await propose(reader, { id: t, title: 'a' }, { dedup_key: 'x', contact_id: c2, expires_at: soon.toISOString() })).body
    await propose(reader, { id: t, title: 'b' }, { dedup_key: 'x', contact_id: c2 }) // supersede
    const rej = (await propose(reader, { id: t, title: 'c' })).body
    await k.call(writer, 'POST', `${AR}/${rej.id}/reject`, { decision_reason: 'no' })
    const wd = (await propose(reader, { id: t, title: 'd' })).body
    await k.call(reader, 'POST', `${AR}/${wd.id}/withdraw`)
    const ap = (await propose(reader, { id: t, title: 'e' })).body
    await k.call(writer, 'POST', `${AR}/${ap.id}/approve`)
    await k.call(owner, 'POST', `/api/v1/contacts/${c1}/merge`, { source_id: c2 }) // re-points the live request
    k.setNow(new Date(soon.getTime() + 1))
    void created
    const exp = (await propose(owner, { id: t, title: 'f' }, { dedup_key: 'y', expires_at: new Date(k.now().getTime() + 1000).toISOString() })).body
    k.setNow(new Date(k.now().getTime() + 2000))
    await propose(writer, { id: t, title: 'g' }, { dedup_key: 'y' }) // D37 takeover: expire
    void exp
    const types = new Set((await k.rows('events', "type like 'action_request.%'")).map((e) => e.type))
    expect([...types].sort()).toEqual(['action_request.approved', 'action_request.created', 'action_request.executed', 'action_request.expired', 'action_request.rejected', 'action_request.superseded', 'action_request.updated', 'action_request.withdrawn'])
    const record = (await k.call(reader, 'GET', `${AR}/${ap.id}`)).body
    const visible = new Set(Object.keys(record))
    for (const e of await k.rows('events', "type like 'action_request.%'")) {
      for (const side of [e.before, e.after]) {
        if (side === null) continue
        expect(Object.keys(side).filter((key) => !visible.has(key)), `${e.type} leaks`).toEqual([])
      }
      expect(JSON.stringify(e)).not.toMatch(/key_hash|refresh_token|ciphertext|storage_key|content_key/)
    }
  })
})

describe('the refusal hint (user decision 2026-11-06, D42)', () => {
  const hint = (op: string) => `call action_requests.create with operation=${op} and the same arguments, plus a reason`

  it('a proposer refused a direct write is told how to propose, on REST', async () => {
    const t = await task()
    const r = await k.call(proposer, 'PATCH', `/api/v1/tasks/${t}`, { title: 'x' })
    expect(code(r)).toEqual([403, 'insufficient_scope'])
    expect(r.body.error.message).toBe(`requires tasks:write; this agent can propose this change but not run it: ${hint('tasks.update')}`)
    expect(Object.keys(r.body.error).sort()).toEqual(['code', 'message'])
  })

  it('the same message over MCP, from the one shared refusal path', async () => {
    const t = await task()
    const res = await k.call(proposer, 'POST', '/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'tasks_update', arguments: { id: t, title: 'x' } } })
    expect(res.status).toBe(200)
    expect(res.body.result.isError).toBe(true)
    expect(res.body.result.structuredContent.error.message).toBe(`requires tasks:write; this agent can propose this change but not run it: ${hint('tasks.update')}`)
  })

  it('no hint without request_approval on the target, whether the caller holds read, another write, or nothing', async () => {
    const t = await task()
    for (const scopes of [[], ['tasks:read'], ['contacts:write', 'contacts:request_approval']]) {
      const r = await k.call(await k.actor('nohint', 'agent', scopes), 'PATCH', `/api/v1/tasks/${t}`, { title: 'x' })
      expect(r.body.error.message, scopes.join()).toBe('requires tasks:write')
    }
  })

  it('no hint when the operation is not proposable, even for a holder of request_approval on its resource', async () => {
    const c = (await k.call(owner, 'POST', '/api/v1/contacts', { name: 'C' })).body.id
    const file = await k.d1.prepare("select 1").first()
    void file
    const holder = await k.actor('contact-prop', 'agent', ['contacts:request_approval', 'contacts:read'])
    const r = await k.call(holder, 'POST', '/api/v1/contact-files', { contact_id: c, file_id: '0190b2c4-0000-7000-8000-00000000dead' })
    expect(code(r)).toEqual([403, 'insufficient_scope'])
    expect(r.body.error.message).toBe('requires contacts:write')
  })

  it('the hint respects the full scope needs of the call: an association proposer without read on an end gets none', async () => {
    const t = await task()
    const c = (await k.call(owner, 'POST', '/api/v1/contacts', { name: 'C' })).body.id
    const body = { a_type: 'tasks', a_id: t, b_type: 'contacts', b_id: c }
    const full = await k.actor('assoc-full', 'agent', ['associations:request_approval', 'tasks:read', 'contacts:read'])
    const partial = await k.actor('assoc-partial', 'agent', ['associations:request_approval', 'tasks:read'])
    const yes = await k.call(full, 'POST', '/api/v1/associations', body)
    expect(yes.body.error.message).toBe(`requires associations:write; this agent can propose this change but not run it: ${hint('associations.create')}`)
    const no = await k.call(partial, 'POST', '/api/v1/associations', body)
    expect(no.body.error.message).toBe('requires associations:write')
  })
})
