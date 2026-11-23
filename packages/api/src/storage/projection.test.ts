import { describe, expect, it } from 'vitest'
import { messages } from '../resources/messages.js'
import { threads } from '../resources/threads.js'
import { ScopeSet } from '../scopes.js'
import { contentLevel, projectRecord, type Caller } from './projection.js'

// API514 D5, D6: the content declaration and the one projection function (group 1). Pure: no database.
const caller = (...scopes: string[]): Caller => ({
  scopes: ScopeSet.parse(scopes),
  actor: { id: '0190b2c4-0000-7000-8000-0000000000a1', kind: 'user' },
})
const EVERYTHING = caller('messages:read')
const SUBJECT = caller('threads:read') // holds no revealing scope
const message = {
  id: '0190b2c4-0000-7000-8000-000000000001',
  thread_id: '0190b2c4-0000-7000-8000-000000000002',
  channel: 'email',
  kind: 'message',
  external_id: 'x@y',
  in_reply_to: null,
  author: { user_id: 'a@b.c', user_name: 'a@b.c', full_name: 'A', is_bot: false },
  occurred_at: '2026-10-22T09:00:00.000Z',
  preview: 'the body excerpt',
  version: 1,
  retracted_at: null,
  attachments: [{ id: '0190b2c4-0000-7000-8000-000000000003', name: 'a.pdf' }],
  created_by: '0190b2c4-0000-7000-8000-0000000000a1',
  created_at: '2026-10-22T09:00:00.000Z',
}
const thread = {
  id: '0190b2c4-0000-7000-8000-000000000002',
  channel: 'email',
  subject: 'Hello',
  created_by: '0190b2c4-0000-7000-8000-0000000000a1',
  created_at: '2026-10-22T09:00:00.000Z',
}

describe('the content declaration (D5)', () => {
  it('messages declares preview and attachments, revealed by messages:read; threads declares none', () => {
    expect(messages.content).toEqual({
      fields: ['preview', 'attachments'],
      requires: { resource: 'messages', action: 'read' },
    })
    expect(threads.content).toBeUndefined()
  })
})

describe('the projection function (D6)', () => {
  it('below everything: preview and attachments are absent as keys, every other field is untouched', () => {
    const out = projectRecord(messages, SUBJECT, message)
    expect('preview' in out).toBe(false)
    expect('attachments' in out).toBe(false)
    const { preview: _p, attachments: _a, ...rest } = message
    expect(out).toEqual(rest)
  })

  it('at everything: the record is returned as is', () => {
    expect(projectRecord(messages, EVERYTHING, message)).toEqual(message)
  })

  it('a thread record is whole at both levels', () => {
    expect(projectRecord(threads, SUBJECT, thread)).toEqual(thread)
    expect(projectRecord(threads, EVERYTHING, thread)).toEqual(thread)
  })

  it('does not mutate its input', () => {
    const copy = structuredClone(message)
    projectRecord(messages, SUBJECT, copy)
    expect(copy).toEqual(message)
  })

  it('decides the level from the caller and the record: everything with the revealing scope, subject without; a definition with no content is always everything', () => {
    expect(contentLevel(messages, EVERYTHING, message)).toBe('everything')
    expect(contentLevel(messages, SUBJECT, message)).toBe('subject')
    expect(contentLevel(threads, SUBJECT, thread)).toBe('everything')
  })
})
