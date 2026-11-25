import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { uuidv7 } from '@vibase/storage'
import { createVibaseRegistry } from '../operations.js'
import { actionRequests } from './definition.js'
import { memoryObjectStore } from '../objects/store.js'
import { openActionKit, type ActionKit, type Actor } from '../test/action-kit.js'
import { prereq } from '../test/action-fixtures.js'
import { PROJECTS_KEY, PROJECTS, createCustomTables, projectsDefinition } from '../test/custom-objects.js'

// [[AGT588]] cycle b (D7 to D12): what the request says about itself. The summary the server writes at create (D7, D8), the proposer and the sending
// mailbox derived at read (D9, D10), the refusals that stay (D11). The integration tests run through the real REST app on D1.
const registry = createVibaseRegistry({ definitions: [projectsDefinition()] })
const AR = '/api/v1/action-requests'
const MISSING = '0190b2c4-0000-7000-8000-00000000dead'
let k: ActionKit
let owner: Actor
let proposer: Actor
beforeAll(async () => {
  k = await openActionKit({ registry, objects: memoryObjectStore() })
  await createCustomTables(k.d1, PROJECTS_KEY, PROJECTS)
})
afterAll(() => k.close())
beforeEach(async () => {
  await k.reset()
  owner = k.as(k.owner, registry.declaredScopes())
  proposer = await k.actor('proposer', 'agent', [
    'tasks:request_approval',
    'contacts:request_approval',
    'deals:request_approval',
    `${PROJECTS_KEY}:request_approval`,
    'messages:request_approval',
    'messages:read',
    'associations:request_approval',
    'tasks:read',
    'contacts:read',
    'deals:read',
    'associations:read',
    `${PROJECTS_KEY}:read`,
    'action_requests:read',
  ])
})
const propose = async (operation: string, args: Record<string, unknown>, who: Actor = proposer) => {
  const r = await k.call(who, 'POST', AR, { operation, arguments: args, reason: 'because', evidence: [] })
  expect(r.status, JSON.stringify(r.body)).toBe(201)
  return r.body as Record<string, any>
}
const make = async (path: string, body: Record<string, unknown>) => {
  const r = await k.call(owner, 'POST', `/api/v1/${path}`, body)
  expect(r.status, JSON.stringify(r.body)).toBe(201)
  return r.body.id as string
}
const summaryOf = async (operation: string, args: Record<string, unknown>) =>
  (await propose(operation, args)).target_summary as string
const MAILBOX = 'owner@example.test'
const addrs = (n: number, prefix = 'r') => Array.from({ length: n }, (_, i) => `${prefix}${i + 1}@example.test`)
const sendArgs = (connection: string, over: Record<string, unknown> = {}) => ({
  connection_id: connection,
  mode: 'new',
  subject: 'Quarterly plan',
  to: ['ann@example.test'],
  body: 'hello',
  ...over,
})

describe('the summary per operation class (D8)', () => {
  it('send, new form: mailbox, recipients to then cc, subject', async () => {
    const c = await prereq(k).connection()
    expect(await summaryOf('messages.send', sendArgs(c))).toBe(
      `Send a new email from ${MAILBOX} to ann@example.test: "Quarterly plan"`,
    )
    expect(
      await summaryOf(
        'messages.send',
        sendArgs(c, { to: ['a@example.test'], cc: ['b@example.test', 'c@example.test'] }),
      ),
    ).toBe(`Send a new email from ${MAILBOX} to a@example.test, b@example.test, c@example.test: "Quarterly plan"`)
  })

  it('send, recipients: five named, then "and N more"; a bcc count; five or fewer are not counted', async () => {
    const c = await prereq(k).connection()
    const five = await summaryOf('messages.send', sendArgs(c, { to: addrs(3), cc: addrs(2, 'c') }))
    expect(five).toContain('to r1@example.test, r2@example.test, r3@example.test, c1@example.test, c2@example.test:')
    expect(five).not.toContain('more')
    const six = await summaryOf('messages.send', sendArgs(c, { to: addrs(4), cc: addrs(2, 'c') }))
    expect(six).toContain(
      'to r1@example.test, r2@example.test, r3@example.test, r4@example.test, c1@example.test and 1 more:',
    )
    const many = await summaryOf('messages.send', sendArgs(c, { to: addrs(8), cc: addrs(4, 'c'), bcc: addrs(2, 'b') }))
    expect(many).toContain('and 7 more (bcc: 2):')
    expect(many).not.toContain('b1@example.test')
    const onlyBcc = await summaryOf('messages.send', sendArgs(c, { to: [], bcc: addrs(2, 'b') }))
    expect(onlyBcc).toContain('to no one (bcc: 2):')
  })

  it('send, reply form: the thread subject (else its id) in place of a subject', async () => {
    const c = await prereq(k).connection()
    const thread = uuidv7()
    await k.d1
      .prepare(
        "insert into threads (id, organization_id, created_by, created_at, channel, subject) values (?, ?, ?, ?, 'email', ?)",
      )
      .bind(thread, k.organizationId, owner.id, '2026-11-06T09:00:00.000Z', 'Re: the offer')
      .run()
    const reply = { connection_id: c, mode: 'reply', thread_id: thread, to: ['ann@example.test'], body: 'ok' }
    expect(await summaryOf('messages.send', reply)).toBe(`Reply from ${MAILBOX} in "Re: the offer" to ann@example.test`)
    const gone = uuidv7()
    expect(await summaryOf('messages.send', { ...reply, thread_id: gone })).toBe(
      `Reply from ${MAILBOX} in "${gone}" to ann@example.test`,
    )
  })

  it('create reads the label from the arguments; update names the record and the changed fields; delete names the record', async () => {
    expect(await summaryOf('tasks.create', { title: 'Call Ann' })).toBe('Create tasks record "Call Ann"')
    expect(await summaryOf('contacts.create', { name: 'Ann' })).toBe('Create contacts record "Ann"')
    const t = await make('tasks', { title: 'Old title' })
    expect(await summaryOf('tasks.update', { id: t, title: 'New title', status: 'done' })).toBe(
      'Update tasks record "Old title" (fields: title, status)',
    )
    expect(await summaryOf('tasks.delete', { id: t })).toBe('Delete tasks record "Old title"')
  })

  it('a command takes the generic form: the operation, the resource and the record', async () => {
    const keep = await make('contacts', { name: 'Keep' })
    const fold = await make('contacts', { name: 'Fold' })
    expect(await summaryOf('contacts.merge', { id: keep, source_id: fold })).toBe(
      'contacts.merge on contacts record "Keep"',
    )
  })

  it('the label rule holds on a custom object, and a missing label falls back to the id', async () => {
    const p = await make(PROJECTS_KEY, { name: 'Alpha' })
    expect(await summaryOf(`${PROJECTS_KEY}.update`, { id: p, budget: 5 })).toBe(
      `Update ${PROJECTS_KEY} record "Alpha" (fields: budget)`,
    )
    expect(await summaryOf(`${PROJECTS_KEY}.create`, { name: 'Beta' })).toBe(`Create ${PROJECTS_KEY} record "Beta"`)
  })

  it("a proposer without the target resource's read scope gets the record named by its id, never its name (588.31)", async () => {
    const t = await make('tasks', { title: 'Secret title' })
    const blind = await k.actor('blind', 'agent', ['tasks:request_approval', 'action_requests:read'])
    const r = await propose('tasks.update', { id: t, title: 'x' }, blind)
    expect(r.target_summary).toBe(`Update tasks record "${t}" (fields: title)`)
    expect(JSON.stringify(r)).not.toContain('Secret title')
    expect((await propose('tasks.delete', { id: t }, blind)).target_summary).toBe(`Delete tasks record "${t}"`)
  })

  it('more than eight changed fields name eight and count the rest; an update with no field besides the id says none', async () => {
    const t = await make('tasks', { title: 'Many' })
    const fields = ['title', 'description', 'status', 'priority', 'due_at', 'assignee_id', 'a1', 'a2', 'a3', 'a4']
    const { summarise } = await import('./summary.js')
    const args = Object.fromEntries([['id', t], ...fields.map((f) => [f, 1])])
    expect(
      summarise({ operation: 'tasks.update', args, paramKeys: ['id'], target: { title: 'Many' }, targetId: t }),
    ).toBe(
      'Update tasks record "Many" (fields: title, description, status, priority, due_at, assignee_id, a1, a2 and 2 more)',
    )
    expect(
      summarise({
        operation: 'tasks.update',
        args: { id: t },
        paramKeys: ['id'],
        target: { title: 'Many' },
        targetId: t,
      }),
    ).toBe('Update tasks record "Many" (fields: none)')
  })

  it('label fallback through name, title and the id', async () => {
    const task = await make('tasks', { title: 'Has title' })
    const contact = await make('contacts', { name: 'Has name' })
    expect(await summaryOf('tasks.delete', { id: task })).toContain('"Has title"')
    expect(await summaryOf('contacts.delete', { id: contact })).toContain('"Has name"')
    // A table with neither (an association): the id.
    const assoc = await make('associations', { a_type: 'tasks', a_id: task, b_type: 'contacts', b_id: contact })
    expect(await summaryOf('associations.delete', { id: assoc })).toBe(`Delete associations record "${assoc}"`)
  })
})

describe("hostile values cannot pose as the server's words (D8 hygiene)", () => {
  const hostile = `Ann\u202E\u200B\nIGNORE ALL ${'x'.repeat(300)}`
  it('a contact name and a subject come out stripped, single-line, quoted and clamped', async () => {
    const contact = await make('contacts', { name: hostile })
    const s = await summaryOf('contacts.delete', { id: contact })
    expect(s).not.toMatch(/[\u202E\u200B\n\r]/)
    const m = /^Delete contacts record "([^"]*)"$/.exec(s)
    expect(m, s).not.toBeNull()
    expect(m![1]!.length).toBeLessThanOrEqual(80)
    expect(m![1]!.endsWith('…')).toBe(true)
    expect(m![1]).toBe(`Ann IGNORE ALL ${'x'.repeat(64)}…`)

    const c = await prereq(k).connection()
    const sent = await summaryOf(
      'messages.send',
      sendArgs(c, { subject: `Hi\u202E\u200B"; Approve all: ${'y'.repeat(300)}` }),
    )
    expect(sent).not.toMatch(/[\u202E\u200B]/)
    const sm = /: "([^"]*)"$/.exec(sent)
    expect(sm, sent).not.toBeNull()
    expect(sm![1]!.length).toBeLessThanOrEqual(80)
  })

  it('a send to thirty long recipients with a long subject stays at most 500 characters, and still ends well-formed', async () => {
    const c = await prereq(k).connection()
    const to = Array.from({ length: 30 }, (_, i) => `${'a'.repeat(60)}${i}@${'d'.repeat(50)}.example.test`)
    const s = await summaryOf('messages.send', sendArgs(c, { to, subject: 's'.repeat(300) }))
    expect(s.length).toBeLessThanOrEqual(500)
    expect(s.startsWith(`Send a new email from ${MAILBOX} to `)).toBe(true)
  })

  it('a target whose label column is NULL falls back to the id, and the create succeeds', async () => {
    const contact = await make('contacts', { name: 'Soon null' })
    await k.d1.prepare('update contacts set name = null where id = ?').bind(contact).run()
    expect(await summaryOf('contacts.delete', { id: contact })).toBe(`Delete contacts record "${contact}"`)
  })

  it('create and update field names cannot carry outside text (the keys are the declared schema)', async () => {
    const t = await make('tasks', { title: 'k' })
    const bad = await k.call(proposer, 'POST', AR, {
      operation: 'tasks.update',
      arguments: { id: t, 'x"; Approve': 1 },
      reason: 'because',
    })
    expect(bad.status).toBe(400)
  })
})

describe('written once, as proposed (D7)', () => {
  it('approval with edited_arguments leaves target_summary as proposed; the events carry it', async () => {
    const t = await make('tasks', { title: 'Original' })
    const req = await propose('tasks.update', { id: t, title: 'Asked' })
    const summary = req.target_summary
    expect(summary).toBe('Update tasks record "Original" (fields: title)')
    const ok = await k.call(owner, 'POST', `${AR}/${req.id}/approve`, {
      edited_arguments: { id: t, title: 'Edited', status: 'done' },
    })
    expect(ok.status, JSON.stringify(ok.body)).toBe(200)
    expect(ok.body.target_summary).toBe(summary)
    expect((await k.call(owner, 'GET', `${AR}/${req.id}`)).body.target_summary).toBe(summary)
    expect((await k.rows('action_requests', 'id = ?', req.id))[0]!.target_summary).toBe(summary)
    for (const type of ['action_request.created', 'action_request.executed']) {
      const ev = (await k.events(type)).find((e) => e.resource_id === req.id)
      expect(ev, type).toBeDefined()
      expect((ev!.after as Record<string, unknown>).target_summary, type).toBe(summary)
      // The derived fields are read-time and never in an event's record; the stored summary is.
      expect(Object.keys(ev!.after as object), type).not.toContain('proposer_kind')
      expect(Object.keys(ev!.after as object), type).not.toContain('sending_mailbox')
    }
  })

  it('a request stored without a summary (as before migration 0030) reads NULL on get and list, with its other fields intact', async () => {
    const id = uuidv7()
    const at = '2026-11-06T09:00:00.000Z'
    await k.d1
      .prepare(
        "insert into action_requests (id, created_at, updated_at, organization_id, created_by, operation, arguments, status, reason, evidence, expires_at) values (?, ?, ?, ?, ?, 'tasks.update', '{}', 'pending', 'old', '[]', '2026-12-01T09:00:00.000Z')",
      )
      .bind(id, at, at, k.organizationId, owner.id)
      .run()
    const got = await k.call(owner, 'GET', `${AR}/${id}`)
    expect(got.body).toMatchObject({ id, operation: 'tasks.update', reason: 'old', target_summary: null })
    const list = await k.call(owner, 'GET', AR)
    expect(list.body.data.find((r: any) => r.id === id).target_summary).toBeNull()
  })

  it('target_summary has no filter of its own and is not a sort (it is a column like reason, under the generic column filters, 588.26)', () => {
    const list = registry.get('action_requests.list') as any
    expect(Object.keys(list.request.query.shape)).not.toContain('sort_by')
    expect(String(list.request.query.shape.sort?.description ?? '')).not.toContain('target_summary')
    expect(Object.keys(actionRequests.filters ?? {})).not.toContain('target_summary')
    expect(actionRequests.sorts ?? []).not.toContain('target_summary')
  })
})

describe('the proposer, in words (D9)', () => {
  const named = async (req: Record<string, any>) => {
    const got = (await k.call(owner, 'GET', `${AR}/${req.id}`)).body
    const listed = (await k.call(owner, 'GET', AR)).body.data.find((r: any) => r.id === req.id)
    expect(listed).toMatchObject({
      proposer_kind: got.proposer_kind,
      proposer_name: got.proposer_name,
      proposer_acting_for: got.proposer_acting_for,
    })
    return got as Record<string, any>
  }
  it('a user is its name, else its email', async () => {
    const t = await make('tasks', { title: 't' })
    const human = await k.actor('human', 'user', ['tasks:request_approval'])
    await k.d1.prepare("update users set email = 'hana@example.test', name = null where id = ?").bind(human.id).run()
    let req = await propose('tasks.update', { id: t, title: 'a' }, human)
    expect(await named(req)).toMatchObject({
      proposer_kind: 'user',
      proposer_name: 'hana@example.test',
      proposer_acting_for: null,
    })
    await k.d1.prepare("update users set name = 'Hana H' where id = ?").bind(human.id).run()
    req = await propose('tasks.update', { id: t, title: 'b' }, human)
    expect(await named(req)).toMatchObject({
      proposer_kind: 'user',
      proposer_name: 'Hana H',
      proposer_acting_for: null,
    })
  })

  it('an agent is its name; a delegated agent also names the member it acts for (name, else email)', async () => {
    const t = await make('tasks', { title: 't' })
    const plain = await propose('tasks.update', { id: t, title: 'a' })
    expect(await named(plain)).toMatchObject({
      proposer_kind: 'agent',
      proposer_name: 'proposer',
      proposer_acting_for: null,
    })
    const member = await k.actor('member', 'user', [])
    await k.d1.prepare("update users set email = 'mia@example.test', name = null where id = ?").bind(member.id).run()
    const del = await k.actor('delegate', 'agent', ['tasks:request_approval', 'action_requests:read'])
    await k.d1
      .prepare(
        "update agents set auth_provider = 'better-auth', auth_client_id = 'client-1', delegated_by = ? where id = ?",
      )
      .bind(member.id, del.id)
      .run()
    let req = await propose('tasks.update', { id: t, title: 'b' }, del)
    expect(await named(req)).toMatchObject({
      proposer_kind: 'agent',
      proposer_name: 'delegate',
      proposer_acting_for: 'mia@example.test',
    })
    await k.d1.prepare("update users set name = 'Mia M' where id = ?").bind(member.id).run()
    req = await propose('tasks.update', { id: t, title: 'c' }, del)
    expect(await named(req)).toMatchObject({ proposer_acting_for: 'Mia M' })
  })

  it('the system principal is kind system with no name', async () => {
    const t = await make('tasks', { title: 't' })
    // An expiry takeover creates the system principal (D37); a request it proposed is seeded raw (no operation proposes as the system).
    const sys = uuidv7()
    const at = '2026-11-06T09:00:00.000Z'
    await k.d1.prepare("insert into principals (id, kind, created_at) values (?, 'system', ?)").bind(sys, at).run()
    const id = uuidv7()
    await k.d1
      .prepare(
        "insert into action_requests (id, created_at, updated_at, organization_id, created_by, operation, arguments, status, reason, evidence, expires_at) values (?, ?, ?, ?, ?, 'tasks.update', ?, 'pending', 'sys', '[]', '2026-12-01T09:00:00.000Z')",
      )
      .bind(id, at, at, k.organizationId, sys, JSON.stringify({ id: t }))
      .run()
    const got = (await k.call(owner, 'GET', `${AR}/${id}`)).body
    expect(got).toMatchObject({ proposer_kind: 'system', proposer_name: null, proposer_acting_for: null })
  })

  it('the three fields and the summary are in the served schema of get and list, so MCP carries them', () => {
    for (const name of ['action_requests.get', 'action_requests.list']) {
      const op = registry.get(name) as any
      const item = name.endsWith('list') ? op.response.schema.shape.data.element : op.response.schema
      const keys = Object.keys(item.shape)
      for (const f of ['target_summary', 'proposer_kind', 'proposer_name', 'proposer_acting_for', 'sending_mailbox'])
        expect(keys, `${name} ${f}`).toContain(f)
    }
  })
})

describe('the sending mailbox (D10) and the refusals that stay (D11)', () => {
  it("a send names its connection's address, also once the connection is suspended; other operations read NULL", async () => {
    const c = await prereq(k).connection()
    const send = await propose('messages.send', sendArgs(c))
    expect((await k.call(owner, 'GET', `${AR}/${send.id}`)).body.sending_mailbox).toBe(MAILBOX)
    await k.d1.prepare("update channel_connections set status = 'suspended' where id = ?").bind(c).run()
    const after = await k.call(owner, 'GET', `${AR}/${send.id}`)
    expect(after.body.sending_mailbox).toBe(MAILBOX)
    expect(after.body.target_summary).toContain(`from ${MAILBOX}`)
    const t = await make('tasks', { title: 't' })
    const upd = await propose('tasks.update', { id: t, title: 'x' })
    expect((await k.call(owner, 'GET', `${AR}/${upd.id}`)).body.sending_mailbox).toBeNull()
    const list = (await k.call(owner, 'GET', AR)).body.data
    expect(list.find((r: any) => r.id === send.id).sending_mailbox).toBe(MAILBOX)
    expect(list.find((r: any) => r.id === upd.id).sending_mailbox).toBeNull()
  })

  it('after the connection is disconnected (soft-deleted) or its row is gone, sending_mailbox is NULL and the request still reads', async () => {
    const c = await prereq(k).connection()
    const send = await propose('messages.send', sendArgs(c))
    await k.d1
      .prepare("update channel_connections set deleted_at = '2026-11-06T09:30:00.000Z' where id = ?")
      .bind(c)
      .run()
    expect((await k.call(owner, 'GET', `${AR}/${send.id}`)).body).toMatchObject({
      sending_mailbox: null,
      operation: 'messages.send',
    })
    await k.d1.prepare('update channel_connections set deleted_at = null where id = ?').bind(c).run()
    expect((await k.call(owner, 'GET', `${AR}/${send.id}`)).body.sending_mailbox).toBe(MAILBOX)
    for (const child of [
      'channel_credentials',
      'gmail_watches',
      'mail_sync_state',
      'mail_sync_cursors',
      'connection_capture_labels',
      'connection_blocked_senders',
      'message_sources',
      'thread_sources',
    ])
      await k.d1.prepare(`delete from ${child} where connection_id = ?`).bind(c).run()
    await k.d1.prepare('delete from channel_connections where id = ?').bind(c).run()
    const got = await k.call(owner, 'GET', `${AR}/${send.id}`)
    expect(got.status).toBe(200)
    expect(got.body.sending_mailbox).toBeNull()
  })

  it('a send whose connection does not exist yet still creates (authorisation is at approval): the summary leaves the mailbox out as unknown', async () => {
    const s = await summaryOf('messages.send', sendArgs(MISSING))
    expect(s).toBe('Send a new email from an unknown mailbox to ann@example.test: "Quarterly plan"')
  })

  it('create keeps its refusals and their order: a missing target is still 404 not_found, a foreign scope 403', async () => {
    const missing = await k.call(proposer, 'POST', AR, {
      operation: 'tasks.update',
      arguments: { id: MISSING, title: 'x' },
      reason: 'r',
    })
    expect([missing.status, missing.body.error.code]).toEqual([404, 'not_found'])
    const noScope = await k.call(await k.actor('weak', 'agent', ['tasks:read']), 'POST', AR, {
      operation: 'tasks.create',
      arguments: { title: 'x' },
      reason: 'r',
    })
    expect([noScope.status, noScope.body.error.code]).toEqual([403, 'insufficient_scope'])
  })
})
