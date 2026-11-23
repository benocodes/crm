import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { ApiError } from '../errors.js'
import { createApp } from '../rest/app.js'
import { messages } from '../resources/messages.js'
import { ScopeSet } from '../scopes.js'
import { captureMessage, runCapture } from '../test/capture-kit.js'
import { openD1Engine, type Engine } from '../test/engines.js'
import { createVibaseRegistry } from '../operations.js'
import { fakeUserAuthenticator, mintTestUserToken } from '../test/user-auth.js'
import { listOperation } from './crud.js'

// API514 D9, group 3: a filter or sort on a content field needs the revealing scope, refused before any query; schema discovery marks the fields.
// The seam is the one of content-projection.integration.d1.test.ts: the reveal scope is declared as `messages:write` for the test.
const C1 = '0190b2c4-0000-7000-8000-0000000000c1'
const REVEAL = { resource: 'messages', action: 'write' } as const
const BELOW = ['messages:read']
const AT = ['messages:read', 'messages:write']

let e: Engine
let executed: string[]
let app: ReturnType<typeof createApp>
beforeAll(async () => {
  e = await openD1Engine()
})
afterAll(() => e.close())
beforeEach(async () => {
  await e.reset()
  executed = []
  const base = e.binding
  const binding = {
    ...base,
    runtime: {
      ...base.runtime,
      execute: async (identity: any, prepared: any) => {
        executed.push(prepared.name)
        return base.runtime.execute(identity, prepared)
      },
    },
  } as typeof base
  app = createApp({
    registry: createVibaseRegistry(),
    storage: () => binding,
    userAuthenticator: fakeUserAuthenticator(),
  })
  await runCapture(e, {
    source: { kind: 'connection', id: C1 },
    channel: 'email',
    messages: [captureMessage(e.organizationId, { preview: 'the quarterly numbers', attachments: 1 })],
  })
})
const original = messages.content
const reveal = (on: boolean) => {
  ;(messages as { content?: unknown }).content = on ? { ...original!, requires: REVEAL } : original
}
afterEach(() => reveal(false))

const get = async (scopes: string[], path: string) => {
  const token = mintTestUserToken({ userId: e.userId, organizationId: e.organizationId, scopes, kind: 'user' })
  const res = await app.request(path, { headers: { authorization: `Bearer ${token}` } })
  const text = await res.text()
  return { status: res.status, text, body: text ? JSON.parse(text) : null }
}
const FORMS = [
  'quarterly',
  'like.*quarterly*',
  'ilike.*QUARTERLY*',
  'not.like.*quarterly*',
  'not.eq.quarterly',
  'neq.x',
]

describe('the filter oracle is closed (D9)', () => {
  it.each(FORMS)(
    'preview=%s from a caller below everything is 403 insufficient_scope naming the revealing scope, and no list runs',
    async (form) => {
      reveal(true)
      const r = await get(BELOW, `/api/v1/messages?preview=${form}`)
      expect(r.status, r.text).toBe(403)
      expect(r.body.error.code ?? r.body.code).toBe('insufficient_scope')
      expect(r.text).toContain('requires messages:write')
      expect(executed).not.toContain('messages.list')
    },
  )

  it('the refusal is thrown while the operation is built: no query can have been issued', () => {
    reveal(true)
    const env = e.env({ scopes: ScopeSet.parse(BELOW) })
    for (const form of FORMS) {
      expect(() => listOperation(messages, env, { filters: { preview: form } })).toThrowError(ApiError)
    }
  })

  it('a caller at everything still filters as today', async () => {
    reveal(true)
    const hit = await get(AT, '/api/v1/messages?preview=like.*quarterly*')
    expect(hit.status, hit.text).toBe(200)
    expect(hit.body.data).toHaveLength(1)
    const miss = await get(AT, '/api/v1/messages?preview=like.*nothing*')
    expect(miss.body.data).toHaveLength(0)
    expect(executed).toContain('messages.list')
  })

  it('a filter on a field that is not content is not refused below everything', async () => {
    reveal(true)
    const r = await get(BELOW, '/api/v1/messages?channel=email')
    expect(r.status, r.text).toBe(200)
    expect(r.body.data).toHaveLength(1)
  })

  it('a sort on a content field is refused the same way (the check is generic over sort keys)', () => {
    reveal(true)
    const sorted = { ...messages, sorts: ['preview'], sortKinds: { preview: 'text' as const } }
    const env = e.env({ scopes: ScopeSet.parse(BELOW) })
    expect(() => listOperation(sorted as never, env, { sort: 'preview' })).toThrowError(/requires messages:write/)
    expect(() =>
      listOperation(sorted as never, e.env({ scopes: ScopeSet.parse(AT) }), { sort: 'preview' }),
    ).not.toThrow()
  })
})

describe('schema discovery marks the content fields (D9, D10)', () => {
  it('the messages resource lists its content fields and the scope that reveals them; threads has none', async () => {
    const r = await get(['schema:read', 'messages:read'], '/meta/v1/schema')
    expect(r.status, r.text).toBe(200)
    const table = (name: string) => r.body.tables.find((t: any) => t.name === name)
    expect(table('messages').resource.content).toEqual({
      fields: ['preview', 'attachments'],
      requires: 'messages:read',
    })
    expect(table('threads').resource.content).toBeNull()
  })
})
