// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/preact'
import userEvent from '@testing-library/user-event'
import { SCOPE_DESCRIPTIONS } from '@vibase/api/scope-descriptions'
import { ConsentPage } from './consent-page.js'
import { fakeFetch } from './fake-fetch.js'
import { MESSAGES, consentReturnsTo, genericFailure } from './messages.js'

// [[UI247]] D4: the consent page. The signed query goes back verbatim; the page never builds or edits one.
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})
// Encoded characters, a repeated key and an order the page must not touch.
const QUERY = 'state=a%20b%2Bc&sig=Ab%2Fc%3D%3D&scope=openid+contacts%3Aread&client_id=app-1&redirect_uri=https%3A%2F%2Fclient.test%2Fcb%3Fx%3D1&exp=1999999999&scope=dup'
const at = (q: string) => history.replaceState(null, '', q === '' ? '/consent' : `/consent?${q}`)
beforeEach(() => at(QUERY))

const NO_SESSION = { status: 200, json: null }
const SESSION = { status: 200, json: { user: { id: 'u1', email: 'ann@x.test' }, session: { id: 's1' } } }
const CLIENT = { status: 200, json: { client_id: 'app-1', client_name: 'Claude Desktop' } }
const routes = (over: Record<string, { status: number; json?: unknown; text?: string }> = {}) => ({
  'GET /auth/get-session': SESSION,
  'GET /auth/oauth2/public-client': CLIENT,
  'POST /auth/oauth2/consent': { status: 200, json: { redirect: true, url: 'https://client.test/cb?code=c&state=a%20b%2Bc' } },
  ...over,
})
const allow = async () => userEvent.setup().click(await screen.findByRole('button', { name: /allow/i }))
const deny = async () => userEvent.setup().click(await screen.findByRole('button', { name: /deny/i }))

describe('a request that is not an authorization request', () => {
  it.each([
    ['no query at all', ''],
    ['no sig', 'client_id=app-1&scope=openid'],
    ['no client_id', 'sig=abc&scope=openid'],
  ])('%s: an explanation, no buttons, nothing sent', async (_n, q) => {
    at(q)
    const f = fakeFetch(routes())
    render(<ConsentPage />)
    expect(await screen.findByText(MESSAGES.consentNoRequest)).toBeTruthy()
    expect(screen.queryByRole('button')).toBeNull()
    expect(f.requests()).toEqual([])
  })
})

describe('no session', () => {
  it('goes to /sign-in with the very same query', async () => {
    fakeFetch(routes({ 'GET /auth/get-session': NO_SESSION }))
    const go = vi.fn()
    render(<ConsentPage navigate={go} />)
    await waitFor(() => expect(go).toHaveBeenCalledWith(`/sign-in?${QUERY}`))
    expect(screen.queryByRole('button', { name: /allow/i })).toBeNull()
  })
})

describe('signed in', () => {
  it('shows the email, the app\'s name with the unverified line, the redirect host and the scopes as text', async () => {
    fakeFetch(routes())
    render(<ConsentPage />)
    expect(await screen.findByText('Signed in as ann@x.test')).toBeTruthy()
    expect(await screen.findByText('Claude Desktop')).toBeTruthy()
    expect(screen.getByText(MESSAGES.consentUnverified)).toBeTruthy()
    expect(screen.getByText(consentReturnsTo('client.test'))).toBeTruthy()
    expect(screen.getByText('contacts:read')).toBeTruthy()
    expect(screen.getByText(SCOPE_DESCRIPTIONS['contacts:read']!)).toBeTruthy()
    expect(screen.getByText('openid')).toBeTruthy()
  })

  it('the redirect host includes a port', async () => {
    at(QUERY.replace('https%3A%2F%2Fclient.test%2Fcb%3Fx%3D1', 'http%3A%2F%2F127.0.0.1%3A33418%2Fcb'))
    fakeFetch(routes())
    render(<ConsentPage />)
    expect(await screen.findByText(consentReturnsTo('127.0.0.1:33418'))).toBeTruthy()
  })

  it('a missing or unparsable redirect_uri shows no "go back to" line, and the buttons stay', async () => {
    at('client_id=app-1&scope=openid&sig=s&redirect_uri=not%20a%20url')
    fakeFetch(routes())
    render(<ConsentPage />)
    await screen.findByText('Claude Desktop')
    expect(document.body.textContent).not.toContain('After you allow')
    expect(screen.getByRole('button', { name: /allow/i })).toBeTruthy()
  })

  it('an app name, email and scope holding markup are text: no element is created', async () => {
    at('client_id=app-1&scope=%3Cu+id%3D%22s%22%3Ex%3C%2Fu%3E&sig=s&redirect_uri=https%3A%2F%2Fclient.test%2Fcb')
    fakeFetch(
      routes({
        'GET /auth/get-session': { status: 200, json: { user: { id: 'u', email: '<i id="e">a</i>@x.test' } } },
        'GET /auth/oauth2/public-client': { status: 200, json: { client_name: '<b id="n">Evil</b>' } },
      }),
    )
    render(<ConsentPage />)
    await screen.findByText('<b id="n">Evil</b>')
    expect(screen.getByText('Signed in as <i id="e">a</i>@x.test')).toBeTruthy()
    expect(screen.getByText('<u id="s">x</u>')).toBeTruthy()
    for (const id of ['n', 'e', 's']) expect(document.getElementById(id), id).toBeNull()
  })

  it('a failed name lookup falls back to the client id as text', async () => {
    fakeFetch(routes({ 'GET /auth/oauth2/public-client': { status: 404, json: { error: 'not_found' } } }))
    render(<ConsentPage />)
    expect(await screen.findByText('app-1')).toBeTruthy()
  })

  it('"Use another account" signs out and goes to /sign-in with the same query', async () => {
    const f = fakeFetch({ ...routes(), 'POST /auth/sign-out': { status: 200, json: { success: true } } })
    const go = vi.fn()
    render(<ConsentPage navigate={go} />)
    await userEvent.setup().click(await screen.findByRole('button', { name: MESSAGES.useAnotherAccount }))
    await waitFor(() => expect(go).toHaveBeenCalledWith(`/sign-in?${QUERY}`))
    expect(f.requests()).toContain('POST /auth/sign-out')
  })
})

describe('Allow and Deny', () => {
  it('oauth_query is location.search without "?", byte for byte, and no scope is sent', async () => {
    const f = fakeFetch(routes())
    render(<ConsentPage navigate={vi.fn()} />)
    await allow()
    await waitFor(() => expect(f.calls.some((c) => c.path === '/auth/oauth2/consent')).toBe(true))
    const body = f.calls.find((c) => c.path === '/auth/oauth2/consent')!.body as Record<string, unknown>
    expect(body).toEqual({ accept: true, oauth_query: location.search.slice(1) })
    expect(body.oauth_query).toBe(QUERY)
    expect('scope' in body).toBe(false)
  })

  it('Deny sends accept: false with the same query and follows the answered redirect', async () => {
    const f = fakeFetch(routes({ 'POST /auth/oauth2/consent': { status: 200, json: { redirect: true, url: 'https://client.test/cb?error=access_denied' } } }))
    const go = vi.fn()
    render(<ConsentPage navigate={go} />)
    await deny()
    await waitFor(() => expect(go).toHaveBeenCalledWith('https://client.test/cb?error=access_denied'))
    expect(f.calls.find((c) => c.path === '/auth/oauth2/consent')!.body).toEqual({ accept: false, oauth_query: QUERY })
  })

  it.each(['https://client.test/cb?code=c', 'http://127.0.0.1:33418/cb?code=c', '/consent?x=1'])('the redirect %s is followed', async (url) => {
    fakeFetch(routes({ 'POST /auth/oauth2/consent': { status: 200, json: { redirect: true, url } } }))
    const go = vi.fn()
    render(<ConsentPage navigate={go} />)
    await allow()
    await waitFor(() => expect(go).toHaveBeenCalledWith(url))
  })

  it.each(['javascript:alert(1)', 'data:text/html,<b>x</b>'])('the redirect %s is refused: nothing navigates and a generic error shows', async (url) => {
    fakeFetch(routes({ 'POST /auth/oauth2/consent': { status: 200, json: { redirect: true, url } } }))
    const go = vi.fn()
    render(<ConsentPage navigate={go} />)
    await allow()
    expect((await screen.findByRole('alert')).textContent).toBe(genericFailure(200))
    expect(go).not.toHaveBeenCalled()
  })

  it('an answer without a redirect is the generic error, not a navigation', async () => {
    fakeFetch(routes({ 'POST /auth/oauth2/consent': { status: 200, json: { ok: true } } }))
    const go = vi.fn()
    render(<ConsentPage navigate={go} />)
    await allow()
    expect((await screen.findByRole('alert')).textContent).toBe(genericFailure(200))
    expect(go).not.toHaveBeenCalled()
  })

  const failures: Array<[string, { status: number; json?: unknown; text?: string }, string]> = [
    ['invalid_signature', { status: 400, json: { error: 'invalid_signature' } }, MESSAGES.consentInvalid],
    ['an expired or lost query (400 invalid_request)', { status: 400, json: { error: 'invalid_request', error_description: 'missing oauth query' } }, MESSAGES.consentInvalid],
    ['429', { status: 429, json: {} }, MESSAGES.rateLimited],
    ['a generic failure', { status: 500, text: 'boom' }, genericFailure(500)],
  ]
  it.each(failures)('%s gets its message, not the server\'s', async (_n, reply, message) => {
    fakeFetch(routes({ 'POST /auth/oauth2/consent': reply }))
    const go = vi.fn()
    render(<ConsentPage navigate={go} />)
    await allow()
    expect((await screen.findByRole('alert')).textContent).toBe(message)
    expect(go).not.toHaveBeenCalled()
  })

  it('a 401 sends the person to /sign-in with the same query', async () => {
    fakeFetch(routes({ 'POST /auth/oauth2/consent': { status: 401, json: { message: 'Unauthorized' } } }))
    const go = vi.fn()
    render(<ConsentPage navigate={go} />)
    await allow()
    await waitFor(() => expect(go).toHaveBeenCalledWith(`/sign-in?${QUERY}`))
  })
})
