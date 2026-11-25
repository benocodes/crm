import { describe, expect, it } from 'vitest'
import { CONNECT_ERROR_TEXT as API_TEXT } from '@vibase/api'
import { CONNECT_ERROR_TEXT, describeReturn, takeConnectReturn } from './connect-return.js'

// [[UI467]] group 2 (D4, P2): the connect return, read, shown as text and removed from the query.
describe('takeConnectReturn', () => {
  it('reads connection_id and removes it, keeping the other parameters in order', () => {
    expect(takeConnectReturn('?x=1&connection_id=abc&y=2')).toEqual({
      ret: { kind: 'connected', connectionId: 'abc' },
      search: '?x=1&y=2',
    })
  })
  it('reads error and removes it; a lone parameter leaves an empty search', () => {
    expect(takeConnectReturn('?error=consent_denied')).toEqual({
      ret: { kind: 'error', code: 'consent_denied' },
      search: '',
    })
    expect(takeConnectReturn('?error=consent_denied&x=1').search).toBe('?x=1')
  })
  it('error wins when both are present, and both are removed', () => {
    expect(takeConnectReturn('?connection_id=abc&error=state_invalid&x=1')).toEqual({
      ret: { kind: 'error', code: 'state_invalid' },
      search: '?x=1',
    })
  })
  it('neither parameter: nothing to show and the search is unchanged', () => {
    expect(takeConnectReturn('?x=1')).toEqual({ ret: null, search: '?x=1' })
    expect(takeConnectReturn('')).toEqual({ ret: null, search: '' })
  })
  it('an empty value is no outcome, but the parameter is still removed', () => {
    expect(takeConnectReturn('?connection_id=&x=1')).toEqual({ ret: null, search: '?x=1' })
  })
})

describe('describeReturn', () => {
  it('success names the listed address, or says "Mailbox connected." when the id is not listed', () => {
    const ret = { kind: 'connected', connectionId: 'abc' } as const
    expect(describeReturn(ret, 'ann@x.test')).toEqual({ variant: 'success', text: 'Connected ann@x.test.' })
    expect(describeReturn(ret, null)).toEqual({ variant: 'success', text: 'Mailbox connected.' })
  })
  it.each(Object.entries(API_TEXT))('error %s reads the callback sentence and the code', (code, sentence) => {
    expect(describeReturn({ kind: 'error', code }, null)).toEqual({ variant: 'error', text: `${sentence} (${code})` })
  })
  it('an unknown code reads "The mailbox was not connected." and the code', () => {
    expect(describeReturn({ kind: 'error', code: 'brand_new' }, null)).toEqual({
      variant: 'error',
      text: 'The mailbox was not connected. (brand_new)',
    })
  })
})

describe('session_mismatch (CORE572 P3)', () => {
  const TEXT = 'Sign in to this workspace in this browser as the person who started the connection, then start again.'
  it('is in both tables with the one sentence, and /app/accounts?error=session_mismatch shows it once', () => {
    expect(API_TEXT['session_mismatch']).toBe(TEXT)
    expect(CONNECT_ERROR_TEXT['session_mismatch']).toBe(TEXT)
    const { ret } = takeConnectReturn('?error=session_mismatch')
    expect(describeReturn(ret!, null)).toEqual({ variant: 'error', text: `${TEXT} (session_mismatch)` })
  })
})

describe("the app's text table equals @vibase/api's (P2)", () => {
  it('has exactly the same codes and the same sentences', () => {
    expect(CONNECT_ERROR_TEXT).toEqual(API_TEXT)
    expect(Object.keys(API_TEXT).sort()).toEqual([
      'consent_denied',
      'exchange_failed',
      'not_a_member',
      'scope_missing',
      'session_mismatch',
      'state_invalid',
      'temporarily_unavailable',
    ])
  })
})
