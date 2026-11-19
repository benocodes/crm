import { describe, expect, it, vi } from 'vitest'
import { checkConnectEmail, CONNECT_EMAIL_UNREADABLE, getStarted, type ConnectAgentCheck } from './first-steps.js'
import { createApi, type ApiResult } from './session/api.js'
import type { ConnectionRecord } from './session/types.js'

const ME_ID = 'u-me'
const conn = (over: Partial<ConnectionRecord> = {}): ConnectionRecord => ({
  id: 'c1',
  owner_id: ME_ID,
  identity_id: 'i1',
  status: 'active',
  ...over,
})
const ok = (rows: ConnectionRecord[]): ApiResult<ConnectionRecord[]> => ({ status: 200, body: rows })
const W = ['connections:read', 'connections:write']
const check = (scopes: string[], rows: ApiResult<ConnectionRecord[]> | 'signed-out') => {
  const read = vi.fn(async () => rows)
  return { read, result: checkConnectEmail(scopes, ME_ID, read) }
}

// [[UI469]] D13, P3 (group 3): the Connect your email check, pure over an injected read.
describe('checkConnectEmail', () => {
  it('show: write and no connection at all', async () => {
    const { result } = check(W, ok([]))
    expect(await result).toEqual({ status: 'show' })
  })
  it("show: only others' connections", async () => {
    const { result } = check(
      W,
      ok([conn({ owner_id: 'someone-else' }), conn({ id: 'c2', owner_id: 'x', status: 'suspended' })]),
    )
    expect(await result).toEqual({ status: 'show' })
  })
  it.each(['active', 'reauth_required', 'suspended'])('hidden: an own connection with status %s', async (status) => {
    const { result } = check(W, ok([conn({ status })]))
    expect(await result).toEqual({ status: 'hidden' })
  })
  it('hidden: an own connection found only on a later page (the real client follows pages)', async () => {
    const pages = [
      { data: [conn({ id: 'a', owner_id: 'o' })], next_cursor: 'p2' },
      { data: [conn({ id: 'b' })], next_cursor: null },
    ]
    const fetchSpy = vi.fn(async () => new Response(JSON.stringify(pages.shift())))
    const api = createApi({ origin: 'https://w.test', getToken: async () => 't', fetch: fetchSpy as never })
    expect(await checkConnectEmail(W, ME_ID, () => api.connections())).toEqual({ status: 'hidden' })
    expect(fetchSpy).toHaveBeenCalledTimes(2)
  })
  it('without connections:write: hidden, and the list is never read', async () => {
    const { read, result } = check(['connections:read'], ok([]))
    expect(await result).toEqual({ status: 'hidden' })
    expect(read).not.toHaveBeenCalled()
  })
  it('a failed read (status, null body, throw) is the error with the exact sentence', async () => {
    expect(await check(W, { status: 500, body: null }).result).toEqual({
      status: 'error',
      message: CONNECT_EMAIL_UNREADABLE,
    })
    expect(CONNECT_EMAIL_UNREADABLE).toBe('The mailbox list could not be read. Reload the page to try again.')
    const thrown = await checkConnectEmail(W, ME_ID, async () => {
      throw new Error('net')
    })
    expect(thrown).toEqual({ status: 'error', message: CONNECT_EMAIL_UNREADABLE })
  })
  it('signed-out passes through', async () => {
    expect(await check(W, 'signed-out').result).toBe('signed-out')
  })
})

// P5: every pair of checks.
describe('getStarted', () => {
  const SHOW = { status: 'show' } as const
  const HIDDEN = { status: 'hidden' } as const
  const errored = (message: string) => ({ status: 'error', message }) as const
  const E = 'The mailbox list could not be read. Reload the page to try again.'
  const A = 'The agents list could not be read. Reload the page to try again.'
  const pair = (e: Parameters<typeof getStarted>[0], a: ConnectAgentCheck) => getStarted(e, a)
  it('both hidden: no Get started', () => {
    expect(pair(HIDDEN, HIDDEN)).toBeNull()
  })
  it('one shows', () => {
    expect(pair(SHOW, HIDDEN)).toEqual({ emailPrompt: true, emailError: null, agentPrompt: false, agentError: null })
    expect(pair(HIDDEN, SHOW)).toEqual({ emailPrompt: false, emailError: null, agentPrompt: true, agentError: null })
  })
  it('both show', () => {
    expect(pair(SHOW, SHOW)).toEqual({ emailPrompt: true, emailError: null, agentPrompt: true, agentError: null })
  })
  it('an error replaces its own prompt only', () => {
    expect(pair(errored(E), SHOW)).toEqual({ emailPrompt: false, emailError: E, agentPrompt: true, agentError: null })
    expect(pair(SHOW, errored(A))).toEqual({ emailPrompt: true, emailError: null, agentPrompt: false, agentError: A })
    expect(pair(errored(E), errored(A))).toEqual({
      emailPrompt: false,
      emailError: E,
      agentPrompt: false,
      agentError: A,
    })
  })
  it('an error beside a hidden check still renders the section', () => {
    expect(pair(errored(E), HIDDEN)).toEqual({
      emailPrompt: false,
      emailError: E,
      agentPrompt: false,
      agentError: null,
    })
    expect(pair(HIDDEN, errored(A))).toEqual({
      emailPrompt: false,
      emailError: null,
      agentPrompt: false,
      agentError: A,
    })
  })
})
