// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/preact'
import userEvent from '@testing-library/user-event'
import { fakeFetch } from './fake-fetch.js'
import { InvitePage } from './invite-page.js'
import { MESSAGES } from './messages.js'
import { SignInPage } from './sign-in-page.js'

// [[CORE294]] D7, D8, P1, P2: the Google button on /sign-in and /invite exists only when discovery lists `google`; its body is the callback URLs (and, on /invite, the invitation token, read from a fragment that is
// already gone); a failed callback comes back as /sign-in?error=<code> and shows D4's message or one generic message, never the code or the description.
const TOKEN = 'tok_ABC-123_xyz'
const NO_SESSION = { status: 200, json: null }
const DISCOVERY = (methods: unknown) => ({ status: 200, json: { auth: { provider: 'better-auth', sign_in_methods: methods } } })
const GOOGLE_URL = 'https://accounts.google.com/o/oauth2/v2/auth?client_id=x&state=s'
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})
beforeEach(() => history.replaceState(null, '', '/sign-in'))
const button = () => screen.queryByRole('button', { name: MESSAGES.googleButton })

describe('the button follows discovery (D7, P2)', () => {
  it.each([
    ['password only', DISCOVERY(['password'])],
    ['no sign_in_methods field', { status: 200, json: { auth: { provider: 'better-auth' } } }],
    ['an unreadable discovery (a 500)', { status: 500, text: 'boom' }],
    ['a discovery that is not JSON', { status: 200, text: '<html>' }],
  ])('/sign-in with %s: no Google button', async (_n, discovery) => {
    fakeFetch({ 'GET /auth/get-session': NO_SESSION, 'GET /.well-known/vibase': discovery })
    render(<SignInPage />)
    await screen.findByLabelText('Email')
    await new Promise((r) => setTimeout(r, 20))
    expect(button()).toBeNull()
  })

  it('/sign-in with google listed: the button, and the password form is still there', async () => {
    fakeFetch({ 'GET /auth/get-session': NO_SESSION, 'GET /.well-known/vibase': DISCOVERY(['password', 'google']) })
    render(<SignInPage />)
    expect(await screen.findByRole('button', { name: MESSAGES.googleButton })).toBeTruthy()
    expect(screen.getByLabelText('Password')).toBeTruthy()
  })

  it('/invite with google listed shows the button; password only does not', async () => {
    history.replaceState(null, '', `/invite#token=${TOKEN}`)
    fakeFetch({ 'GET /.well-known/vibase': DISCOVERY(['password', 'google']) })
    render(<InvitePage />)
    expect(await screen.findByRole('button', { name: MESSAGES.googleButton })).toBeTruthy()
    cleanup()
    history.replaceState(null, '', `/invite#token=${TOKEN}`)
    fakeFetch({ 'GET /.well-known/vibase': DISCOVERY(['password']) })
    render(<InvitePage />)
    await screen.findByLabelText('Email')
    await new Promise((r) => setTimeout(r, 20))
    expect(button()).toBeNull()
  })
})

describe('starting Google sign-in (D8)', () => {
  it('/sign-in posts exactly { provider, callbackURL, errorCallbackURL } (no token) and follows the returned Google URL', async () => {
    const f = fakeFetch({ 'GET /auth/get-session': NO_SESSION, 'GET /.well-known/vibase': DISCOVERY(['password', 'google']), 'POST /auth/sign-in/social': { status: 200, json: { url: GOOGLE_URL, redirect: true } } })
    const navigate = vi.fn()
    render(<SignInPage navigate={navigate} />)
    await userEvent.setup().click(await screen.findByRole('button', { name: MESSAGES.googleButton }))
    await waitFor(() => expect(navigate).toHaveBeenCalledWith(GOOGLE_URL))
    expect(f.calls.find((c) => c.method === 'POST')!.body).toEqual({ provider: 'google', callbackURL: '/sign-in', errorCallbackURL: '/sign-in' })
  })

  it('/invite also sends invitation_token, and the fragment is already gone from the address', async () => {
    history.replaceState(null, '', `/invite#token=${TOKEN}`)
    const f = fakeFetch({ 'GET /.well-known/vibase': DISCOVERY(['password', 'google']), 'POST /auth/sign-in/social': { status: 200, json: { url: GOOGLE_URL, redirect: true } } })
    const navigate = vi.fn()
    render(<InvitePage navigate={navigate} />)
    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: MESSAGES.googleButton }))
    await waitFor(() => expect(navigate).toHaveBeenCalledWith(GOOGLE_URL))
    expect(location.hash).toBe('')
    expect(location.href).not.toContain(TOKEN)
    expect(f.calls.find((c) => c.method === 'POST')!.body).toEqual({ provider: 'google', callbackURL: '/sign-in', errorCallbackURL: '/sign-in', invitation_token: TOKEN })
  })

  it.each([
    ['a refusal', { status: 404, json: { code: 'PROVIDER_NOT_FOUND', message: 'Provider not found' } }],
    ['a server error', { status: 500, text: 'boom' }],
    ['an answer with a javascript: URL', { status: 200, json: { url: 'javascript:alert(1)', redirect: true } }],
    ['an answer with no URL', { status: 200, json: { redirect: true } }],
  ])('%s: navigates nowhere, shows the page text and never the server message', async (_n, reply) => {
    fakeFetch({ 'GET /auth/get-session': NO_SESSION, 'GET /.well-known/vibase': DISCOVERY(['password', 'google']), 'POST /auth/sign-in/social': reply })
    const navigate = vi.fn()
    render(<SignInPage navigate={navigate} />)
    await userEvent.setup().click(await screen.findByRole('button', { name: MESSAGES.googleButton }))
    expect((await screen.findByRole('alert')).textContent).toBe(MESSAGES.googleFailed)
    expect(navigate).not.toHaveBeenCalled()
    expect(document.body.textContent).not.toContain('Provider not found')
  })
})

describe('the callback error on /sign-in (P1)', () => {
  const open = async (search: string) => {
    history.replaceState(null, '', `/sign-in${search}`)
    fakeFetch({ 'GET /auth/get-session': NO_SESSION })
    render(<SignInPage />)
    await screen.findByLabelText('Email')
  }
  it('error=invitation_required shows D4\'s refusal message and the form stays', async () => {
    await open('?error=invitation_required')
    expect(screen.getByRole('alert').textContent).toBe(MESSAGES.invitationRefused)
    expect(screen.getByLabelText('Password')).toBeTruthy()
  })
  it.each(['account_not_linked', 'access_denied', 'x'])('any other error (%s) shows the one generic message', async (code) => {
    await open(`?error=${code}`)
    expect(screen.getByRole('alert').textContent).toBe(MESSAGES.googleFailed)
  })
  it('a crafted error and error_description never reach the DOM', async () => {
    await open(`?error=${encodeURIComponent('<b id="pwned">x</b>')}&error_description=${encodeURIComponent('<img src=x onerror="window.__pwned=1">pwned')}`)
    expect(screen.getByRole('alert').textContent).toBe(MESSAGES.googleFailed)
    expect(document.getElementById('pwned')).toBeNull()
    expect(document.querySelector('img')).toBeNull()
    expect(document.body.textContent).not.toMatch(/pwned|<b/)
  })
  it('the alert takes focus', async () => {
    await open('?error=invitation_required')
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('alert')))
  })
  it('no error parameter: no alert', async () => {
    await open('')
    expect(screen.queryByRole('alert')).toBeNull()
  })
})
