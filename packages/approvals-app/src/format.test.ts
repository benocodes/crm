import { describe, expect, it } from 'vitest'
import { csp, resolveConfig } from './config.js'
import { operationTitle, relativeTime, type ActionRequest, effectiveArguments } from './format.js'

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
