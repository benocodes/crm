import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { execute, uuidv7 } from '@vibase/storage'
import { openActionKit, type ActionKit, type Actor } from '../test/action-kit.js'
import { connectOperation } from '../connections/connect.js'
import { memoryObjectStore } from '../objects/store.js'
import { ScopeSet } from '../scopes.js'
import { captureMessage } from '../test/capture-kit.js'
import { recordMessagesOperation } from '../messaging/capture.js'

// [[API516]] group 2 (D7, D8): the one matrix, operation x caller. Callers hold `messages:read_metadata` alone, `messages:read` alone (stored; the authenticator computes the closure) or neither.
// Everything else the rows need is held by all three, so the messages scope is the only difference between the columns.
let k: ActionKit
let connection: string
let message: string
let thread: string
const META_ONLY = 'messages:read_metadata'
const READ_ONLY = 'messages:read'
const COMMON = [
  'messages:write',
  'tasks:request_approval',
  'action_requests:read',
  'associations:read',
  'associations:write',
  'contacts:read',
  'contacts:write',
]
type Column = 'metadata' | 'read' | 'neither'
const SCOPES: Record<Column, string[]> = {
  metadata: [META_ONLY, ...COMMON],
  read: [READ_ONLY, ...COMMON],
  neither: [...COMMON],
}
const COLUMNS = Object.keys(SCOPES) as Column[]
const as: Record<Column, Actor> = {} as never

beforeAll(async () => {
  k = await openActionKit({ objects: memoryObjectStore() })
})
afterAll(() => k.close())
beforeEach(async () => {
  await k.reset()
  const env = {
    actor: { id: k.owner.id, kind: 'user' as const },
    organizationId: k.organizationId,
    scopes: ScopeSet.parse(k.owner.scopes),
    now: k.now(),
    newId: () => uuidv7(),
    randomBytes: (n: number) => crypto.getRandomValues(new Uint8Array(n)),
  }
  const tenant = { kind: 'tenant' as const, actorId: k.owner.id, organizationId: k.organizationId }
  connection = (
    await execute(
      k.binding,
      tenant,
      connectOperation(env, {
        google_sub: 'meta-owner',
        mailbox: 'owner@example.test',
        own_addresses: ['owner@example.test'],
        granted_scopes: [
          'https://www.googleapis.com/auth/gmail.readonly',
          'https://www.googleapis.com/auth/gmail.send',
        ],
        ciphertext: 'fake-encrypted-token',
        key_version: 1,
        history_id: '1000',
      }),
    )
  ).value.connection_id
  const msg = captureMessage(k.organizationId, { provider_thread_id: 'anchor-thread', attachments: 1 })
  const result = await execute(
    k.binding,
    tenant,
    recordMessagesOperation(env, {
      source: { kind: 'connection', id: connection },
      channel: 'email',
      messages: [msg],
    }),
  )
  message = result.value.captured[0]!.message_id
  thread = (await k.rows('messages', 'id = ?', message))[0]!.thread_id as string
  for (const c of COLUMNS) as[c] = await k.actor(`agent-${c}`, 'agent', SCOPES[c])
})

const call = (c: Column, method: string, path: string, body?: unknown) => k.call(as[c], method, path, body)
const code = (r: { body: any }) => r.body?.error?.code
const message$ = (r: { body: any }) => r.body?.error?.message

/** A lowered read: the metadata holder and the messages:read holder both succeed, with the message records projected for the first; neither is refused with the new text. */
type Row = {
  omitsForNeither?: true
  name: string
  run: (c: Column) => Promise<{ status: number; body: any }>
  records: (b: any) => any[]
}
const ROWS: Row[] = [
  { name: 'messages.list', run: (c) => call(c, 'GET', '/api/v1/messages'), records: (b) => b.data },
  {
    name: 'messages.list sorted (the keyset path)',
    run: (c) => call(c, 'GET', '/api/v1/messages?sort=occurred_at&order=desc'),
    records: (b) => b.data,
  },
  { name: 'messages.get', run: (c) => call(c, 'GET', `/api/v1/messages/${message}`), records: (b) => [b] },
  { name: 'threads.list', run: (c) => call(c, 'GET', '/api/v1/threads'), records: () => [] },
  { name: 'threads.get', run: (c) => call(c, 'GET', `/api/v1/threads/${thread}`), records: () => [] },
  {
    name: 'the thread association read (associations.list from a contact)',
    run: async (c) => {
      const contact = (await k.call(k.owner, 'POST', '/api/v1/contacts', { name: 'Jane' })).body.id
      await k.call(k.owner, 'POST', '/api/v1/associations', {
        a_type: 'contacts',
        a_id: contact,
        b_type: 'threads',
        b_id: thread,
      })
      return call(c, 'GET', `/api/v1/associations?type=contacts&id=${contact}&neighbour_type=threads`)
    },
    records: () => [],
    omitsForNeither: true,
  },
  {
    name: 'the thread association link (associations.create)',
    run: async (c) => {
      const contact = (await k.call(k.owner, 'POST', '/api/v1/contacts', { name: 'Jane' })).body.id
      return call(c, 'POST', '/api/v1/associations', {
        a_type: 'contacts',
        a_id: contact,
        b_type: 'threads',
        b_id: thread,
      })
    },
    records: () => [],
  },
  {
    name: 'an MCP tool of the lowered reads (messages_list)',
    run: async (c) => {
      const token = (await import('../test/user-auth.js')).mintTestUserToken({
        userId: as[c].id,
        organizationId: k.organizationId,
        scopes: as[c].scopes,
        kind: 'agent',
      })
      const res = await k.app.request('/mcp', {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name: 'messages_list', arguments: {} },
        }),
      })
      const rpc = (await res.json()) as any
      const text: string = rpc.result?.content?.[0]?.text ?? ''
      if (rpc.result?.isError === true || rpc.error)
        return { status: 403, body: { error: { code: 'insufficient_scope', message: text || rpc.error?.message } } }
      return { status: 200, body: JSON.parse(text) }
    },
    records: (b) => b.data,
  },
]

describe('the lowered reads (D7): operation x caller', () => {
  for (const row of ROWS) {
    describe(row.name, () => {
      it('a messages:read_metadata holder succeeds, with message records lacking preview and attachments', async () => {
        const r = await row.run('metadata')
        expect([200, 201], JSON.stringify(r.body)).toContain(r.status)
        const records = row.records(r.body)
        for (const rec of records) {
          expect('preview' in rec, 'preview absent').toBe(false)
          expect('attachments' in rec, 'attachments absent').toBe(false)
          expect(rec.thread_id).toBeTypeOf('string')
        }
      })
      it('a messages:read holder (stored) gets today’s answer, records whole', async () => {
        const r = await row.run('read')
        expect([200, 201], JSON.stringify(r.body)).toContain(r.status)
        for (const rec of row.records(r.body)) {
          expect(rec.preview).toBeTypeOf('string')
          expect(rec.attachments).toHaveLength(1)
        }
      })
      it('a caller with neither is refused: requires messages:read_metadata', async () => {
        const r = await row.run('neither')
        // An association list omits a neighbour of a type the caller cannot read (CORE62): an empty page, never a refusal.
        if (row.omitsForNeither) return expect([r.status, r.body.data]).toEqual([200, []])
        expect([r.status, code(r)]).toEqual([403, 'insufficient_scope'])
        expect(message$(r)).toContain('requires messages:read_metadata')
      })
    })
  }
  it('the thread association read lists the thread neighbour to both holders and omits it for neither', async () => {
    const row = ROWS.find((r) => r.omitsForNeither)!
    expect((await row.run('metadata')).body.data).toHaveLength(1)
    expect((await row.run('read')).body.data).toHaveLength(1)
    expect((await row.run('neither')).body.data).toHaveLength(0)
  })
  it('threads are whole for a metadata holder (subject and channel present)', async () => {
    const r = await call('metadata', 'GET', `/api/v1/threads/${thread}`)
    expect(r.body).toMatchObject({ id: thread, channel: 'email' })
    expect(r.body.subject).toBeTypeOf('string')
  })
})

describe('every explicit messages:read requirement is unchanged (D8)', () => {
  const refusal = (r: { status: number; body: any }) => [r.status, code(r), message$(r)]
  const NOT_REFUSED = (r: { status: number; body: any }) => !(r.status === 403 && code(r) === 'insufficient_scope')
  const SEND = {
    connection_id: undefined as string | undefined,
    mode: 'reply',
    thread_id: undefined as string | undefined,
    body: 'hello',
    to: ['jane@acme.test'],
    idempotency_key: 'k-1',
  }
  const reply = (c: Column) =>
    call(c, 'POST', '/api/v1/messages/send', { ...SEND, connection_id: connection, thread_id: thread })

  it('the content operation', async () => {
    const meta = await call('metadata', 'GET', `/api/v1/messages/${message}/content`)
    expect(refusal(meta)).toEqual([403, 'insufficient_scope', 'requires messages:read'])
    expect(NOT_REFUSED(await call('read', 'GET', `/api/v1/messages/${message}/content`))).toBe(true)
  })
  it('messages.send in reply mode', async () => {
    expect(refusal(await reply('metadata'))).toEqual([403, 'insufficient_scope', 'requires messages:read'])
    expect(NOT_REFUSED(await reply('read'))).toBe(true)
  })
  it('the executions of messages.send are listed to messages:read holders only', async () => {
    const sent = await call('read', 'POST', '/api/v1/messages/send', {
      connection_id: connection,
      mode: 'new',
      subject: 'Hi',
      to: ['x@example.test'],
      body: 'b',
      idempotency_key: 'k-2',
    })
    expect(sent.status, JSON.stringify(sent.body)).toBe(202)
    const ids = async (c: Column) => (await call(c, 'GET', '/api/v1/action-executions')).body.data.map((e: any) => e.id)
    expect(await ids('read')).toEqual([sent.body.id])
    expect(await ids('metadata')).toEqual([])
    expect(await ids('neither')).toEqual([])
  })
  it('an action request’s thread_id context and message evidence', async () => {
    const body = (extra: Record<string, unknown>) => ({
      operation: 'tasks.create',
      arguments: { title: 'follow up' },
      reason: 'because',
      ...extra,
    })
    for (const extra of [{ thread_id: thread }, { evidence: [{ type: 'message', id: message }] }]) {
      const meta = await call('metadata', 'POST', '/api/v1/action-requests', body(extra))
      expect(refusal(meta), JSON.stringify(extra)).toEqual([403, 'insufficient_scope', 'requires messages:read'])
      const read = await call('read', 'POST', '/api/v1/action-requests', body(extra))
      expect(read.status, JSON.stringify(read.body)).toBe(201)
    }
  })
})
