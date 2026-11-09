import { describe, expect, it } from 'vitest'
import { csp, resolveConfig } from './config.js'
import { operationTitle, relativeTime, type ActionRequest, effectiveArguments, emailPreview, withFullArguments } from './format.js'

describe('format', () => {
  it('titles operations', () => {
    expect(operationTitle('tasks.update')).toBe('Update task')
    expect(operationTitle('messages.send')).toBe('Send message')
    expect(operationTitle('weird')).toBe('weird')
  })
  it('says relative times', () => {
    const now = Date.parse('2026-11-09T12:00:00Z')
    expect(relativeTime('2026-11-09T14:00:00Z', now)).toBe('in 2 h')
    expect(relativeTime('2026-11-08T12:00:00Z', now)).toBe('1 d ago')
    expect(relativeTime('2026-11-09T12:00:10Z', now)).toBe('just now')
  })
  it('prefers edited arguments', () => {
    const r = { arguments: { a: 1 }, edited_arguments: { a: 2 } } as unknown as ActionRequest
    expect(effectiveArguments(r)).toEqual({ a: 2 })
  })
})

describe('emailPreview', () => {
  const send = (over: Record<string, unknown> = {}) =>
    ({ operation: 'messages.send', arguments: { mode: 'new', subject: 'Hi', to: ['a@x.test'], cc: [], bcc: [], body: 'Hello there' }, edited_arguments: null, ...over }) as unknown as ActionRequest
  it('reads a send as an email', () => {
    expect(emailPreview(send())).toEqual({ mode: 'new', to: ['a@x.test'], cc: [], bcc: [], subject: 'Hi', body: 'Hello there' })
  })
  it('uses the edited arguments when there are some', () => {
    expect(emailPreview(send({ edited_arguments: { subject: 'Edited', to: ['b@x.test'], body: 'New text' } }))).toMatchObject({ subject: 'Edited', to: ['b@x.test'], body: 'New text' })
  })
  it('has no body text when only the descriptor came back', () => {
    expect(emailPreview(send({ arguments: { subject: 'Hi', to: ['a@x.test'], body: { sha256: 'a'.repeat(64), size_bytes: 2 } } }))?.body).toBeNull()
  })
  it('is null for other operations', () => {
    expect(emailPreview(send({ operation: 'tasks.create' }))).toBeNull()
  })
  it('takes arguments from the full record and the rest from the list', () => {
    const listed = send({ status: 'pending', arguments: { body: { sha256: 'a'.repeat(64), size_bytes: 2 } } })
    const full = send({ status: 'stale' })
    const merged = withFullArguments(listed, full)
    expect(merged.status).toBe('pending')
    expect(emailPreview(merged)?.body).toBe('Hello there')
  })
})

describe('config', () => {
  it('defaults to hq and refuses http', () => {
    expect(resolveConfig({}).apiOrigin).toBe('https://api.hq.vibase.ai')
    expect(() => resolveConfig({ APPROVALS_API_ORIGIN: 'http://evil.example' })).toThrow(/https/)
  })
  it('lets the page call only the API and Clerk', () => {
    const c = csp(resolveConfig({}))
    expect(c).toContain('connect-src \'self\' https://api.hq.vibase.ai https://clerk.hq.vibase.ai')
    expect(c).not.toMatch(/script-src[^;]*unsafe-inline/)
  })
})
