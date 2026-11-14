// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/preact'
import userEvent from '@testing-library/user-event'
import { fakeFetch } from './fake-fetch.js'
import { MESSAGES, genericFailure } from './messages.js'
import { SignInPage } from './sign-in-page.js'

// [[UI246]] D5: the sign-in page reads the session first: a session is the signed-in view (email as text) with sign-out; no session is the form. One message for a wrong email or password; no sign-up link; no continuation.
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})
beforeEach(() => history.replaceState(null, '', '/sign-in'))

const NO_SESSION = { status: 200, json: null }
const session = (user: { email: string; name?: string }) => ({ status: 200, json: { user: { id: 'u1', ...user }, session: { id: 's1' } } })
const signInWith = async (email = 'ann@x.test', password = 'a long enough password') => {
  const user = userEvent.setup()
  await user.type(await screen.findByLabelText('Email'), email)
  await user.type(screen.getByLabelText('Password'), password)
  await user.click(screen.getByRole('button', { name: /sign in/i }))
}

describe('the session on load', () => {
  it('a session shows "Signed in as <email>" and a sign-out button, not the form', async () => {
    fakeFetch({ 'GET /auth/get-session': session({ email: 'ann@x.test', name: 'Ann' }) })
    render(<SignInPage />)
    expect(await screen.findByText('Signed in as ann@x.test')).toBeTruthy()
    expect(screen.getByRole('button', { name: /sign out/i })).toBeTruthy()
    expect(screen.queryByLabelText('Email')).toBeNull()
  })

  it('an email or name holding markup is rendered as text: no element is created', async () => {
    const email = '<img src=x onerror="window.__pwned=1">@x.test'
    fakeFetch({ 'GET /auth/get-session': session({ email, name: '<b id="n">Bold</b>' }) })
    render(<SignInPage />)
    await screen.findByText(`Signed in as ${email}`)
    expect(document.querySelector('img')).toBeNull()
    expect(document.getElementById('n')).toBeNull()
    expect(document.body.textContent).not.toContain('Bold')
  })

  it('no session shows the form with its autocomplete values, the reset hint and no sign-up link', async () => {
    fakeFetch({ 'GET /auth/get-session': NO_SESSION })
    render(<SignInPage />)
    expect((await screen.findByLabelText('Email')).getAttribute('autocomplete')).toBe('email')
    expect(screen.getByLabelText('Password').getAttribute('autocomplete')).toBe('current-password')
    expect(screen.getByText(MESSAGES.signInHelp)).toBeTruthy()
    expect(screen.queryByRole('link')).toBeNull()
    expect(document.querySelector('a')).toBeNull()
    expect(document.body.textContent).not.toMatch(/sign up|create an account|register/i)
  })

  it('a failing session read (a 500, the network) falls back to the form', async () => {
    fakeFetch({ 'GET /auth/get-session': { status: 500, text: 'boom' } })
    render(<SignInPage />)
    expect(await screen.findByLabelText('Email')).toBeTruthy()
    cleanup()
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch') }))
    render(<SignInPage />)
    expect(await screen.findByLabelText('Email')).toBeTruthy()
  })

  it('?notice=password-reset shows the reset notice above the form; without it there is none', async () => {
    history.replaceState(null, '', '/sign-in?notice=password-reset')
    fakeFetch({ 'GET /auth/get-session': NO_SESSION })
    render(<SignInPage />)
    expect((await screen.findByRole('status')).textContent).toBe(MESSAGES.passwordResetDone)
    cleanup()
    history.replaceState(null, '', '/sign-in')
    render(<SignInPage />)
    await screen.findByLabelText('Email')
    expect(screen.queryByText(MESSAGES.passwordResetDone)).toBeNull()
  })
})

describe('signing in', () => {
  it('posts { email, password } to /auth/sign-in/email and shows the signed-in view from the answer', async () => {
    const f = fakeFetch({ 'GET /auth/get-session': NO_SESSION, 'POST /auth/sign-in/email': { status: 200, json: { redirect: false, user: { email: 'ann@x.test', name: 'Ann' } } } })
    render(<SignInPage />)
    await signInWith()
    expect(await screen.findByText('Signed in as ann@x.test')).toBeTruthy()
    expect(f.calls.find((c) => c.method === 'POST')!.body).toEqual({ email: 'ann@x.test', password: 'a long enough password' })
    expect(screen.queryByLabelText('Password')).toBeNull()
  })

  it('empty fields and a malformed email send nothing', async () => {
    const f = fakeFetch({ 'GET /auth/get-session': NO_SESSION })
    render(<SignInPage />)
    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: /sign in/i }))
    expect(await screen.findByText(MESSAGES.emailRequired)).toBeTruthy()
    expect(screen.getByText(MESSAGES.passwordRequired)).toBeTruthy()
    await user.type(screen.getByLabelText('Email'), 'nope')
    await user.type(screen.getByLabelText('Password'), 'x')
    await user.click(screen.getByRole('button', { name: /sign in/i }))
    expect(await screen.findByText(MESSAGES.emailInvalid)).toBeTruthy()
    expect(f.requests()).toEqual(['GET /auth/get-session'])
  })

  const cases: Array<[string, { status: number; json?: unknown; text?: string }, string]> = [
    ['401', { status: 401, json: { code: 'INVALID_EMAIL_OR_PASSWORD', message: 'Invalid email or password' } }, MESSAGES.wrongCredentials],
    ['a 401 without a body', { status: 401, text: '' }, MESSAGES.wrongCredentials],
    ['429', { status: 429, json: { message: 'Too many requests. Please try again later.' } }, MESSAGES.rateLimited],
    ['invitation_acceptance_failed', { status: 500, json: { code: 'invitation_acceptance_failed', message: 'the account could not be settled' } }, MESSAGES.signInAcceptanceFailed],
    ['an unknown status', { status: 503, json: { code: 'WHO_KNOWS' } }, genericFailure(503)],
  ]
  it.each(cases)('%s maps to its message in a focused alert', async (_n, reply, message) => {
    fakeFetch({ 'GET /auth/get-session': NO_SESSION, 'POST /auth/sign-in/email': reply })
    render(<SignInPage />)
    await signInWith()
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toBe(message)
    await waitFor(() => expect(document.activeElement).toBe(alert))
  })

  it('a wrong email and a wrong password get the very same message', async () => {
    const seen: string[] = []
    for (const code of ['USER_NOT_FOUND', 'INVALID_EMAIL_OR_PASSWORD', 'INVALID_PASSWORD']) {
      cleanup()
      fakeFetch({ 'GET /auth/get-session': NO_SESSION, 'POST /auth/sign-in/email': { status: 401, json: { code } } })
      render(<SignInPage />)
      await signInWith()
      seen.push((await screen.findByRole('alert')).textContent ?? '')
    }
    expect(new Set(seen)).toEqual(new Set([MESSAGES.wrongCredentials]))
  })

  it('a server message with markup is never rendered', async () => {
    fakeFetch({ 'GET /auth/get-session': NO_SESSION, 'POST /auth/sign-in/email': { status: 401, json: { code: 'INVALID_EMAIL_OR_PASSWORD', message: '<b id="injected">hi</b>' } } })
    render(<SignInPage />)
    await signInWith()
    expect((await screen.findByRole('alert')).textContent).toBe(MESSAGES.wrongCredentials)
    expect(document.getElementById('injected')).toBeNull()
  })
})

describe('signing out', () => {
  it('POST /auth/sign-out, then the form', async () => {
    const f = fakeFetch({ 'GET /auth/get-session': session({ email: 'ann@x.test' }), 'POST /auth/sign-out': { status: 200, json: { success: true } } })
    render(<SignInPage />)
    await userEvent.setup().click(await screen.findByRole('button', { name: /sign out/i }))
    expect(await screen.findByLabelText('Email')).toBeTruthy()
    expect(screen.queryByText(/Signed in as/)).toBeNull()
    expect(f.requests()).toEqual(['GET /auth/get-session', 'POST /auth/sign-out'])
  })

  it('a failed sign-out stays on the signed-in view with an alert', async () => {
    fakeFetch({ 'GET /auth/get-session': session({ email: 'ann@x.test' }), 'POST /auth/sign-out': { status: 500, text: 'boom' } })
    render(<SignInPage />)
    await userEvent.setup().click(await screen.findByRole('button', { name: /sign out/i }))
    expect((await screen.findByRole('alert')).textContent).toBe(genericFailure(500))
    expect(screen.getByText('Signed in as ann@x.test')).toBeTruthy()
  })
})

const SIGNED = 'client_id=app-1&redirect_uri=http%3A%2F%2F127.0.0.1%3A33418%2Fcb&scope=openid+contacts%3Aread&state=a%20b&exp=1999999999&sig=AbC%2Fdef%3D'

// [[UI247]] D6 closes UI246 D5's deferral: a signed OAuth query resumes the flow; a return_to of /device or /connect goes back there; nothing else is followed.
describe('the OAuth continuation (D6 a)', () => {
  beforeEach(() => history.replaceState(null, '', `/sign-in?${SIGNED}`))

  it('with sig the sign-in body carries oauth_query (the query verbatim) and the answered redirect is followed', async () => {
    const f = fakeFetch({ 'POST /auth/sign-in/email': { status: 200, json: { redirect: true, url: '/consent?client_id=app-1&sig=Z' } } })
    const go = vi.fn()
    render(<SignInPage navigate={go} />)
    await signInWith()
    await waitFor(() => expect(go).toHaveBeenCalledWith('/consent?client_id=app-1&sig=Z'))
    expect(f.calls.find((c) => c.method === 'POST')!.body).toEqual({ email: 'ann@x.test', password: 'a long enough password', oauth_query: SIGNED })
  })

  it('the form shows even with a live session (the provider sent the person here to sign in), and the session is not even read', async () => {
    const f = fakeFetch({ 'GET /auth/get-session': session({ email: 'ann@x.test' }) })
    render(<SignInPage />)
    expect(await screen.findByLabelText('Email')).toBeTruthy()
    expect(screen.queryByText(/Signed in as/)).toBeNull()
    expect(f.requests().filter((r) => r.startsWith('POST'))).toEqual([])
  })

  it('a success without a redirect shows the signed-in view', async () => {
    fakeFetch({ 'POST /auth/sign-in/email': { status: 200, json: { redirect: false, user: { email: 'ann@x.test' } } } })
    const go = vi.fn()
    render(<SignInPage navigate={go} />)
    await signInWith()
    expect(await screen.findByText('Signed in as ann@x.test')).toBeTruthy()
    expect(go).not.toHaveBeenCalled()
  })

  it.each(['javascript:alert(1)', 'data:text/html,x'])('a redirect to %s is never followed: a generic error is shown', async (url) => {
    fakeFetch({ 'POST /auth/sign-in/email': { status: 200, json: { redirect: true, url } } })
    const go = vi.fn()
    render(<SignInPage navigate={go} />)
    await signInWith()
    expect((await screen.findByRole('alert')).textContent).toBe(genericFailure(200))
    expect(go).not.toHaveBeenCalled()
  })

  it('without sig an oauth_query-looking parameter is not forwarded', async () => {
    history.replaceState(null, '', '/sign-in?client_id=app-1')
    const f = fakeFetch({ 'GET /auth/get-session': NO_SESSION, 'POST /auth/sign-in/email': { status: 200, json: { user: { email: 'ann@x.test' } } } })
    render(<SignInPage />)
    await signInWith()
    await screen.findByText('Signed in as ann@x.test')
    expect(f.calls.find((c) => c.method === 'POST')!.body).toEqual({ email: 'ann@x.test', password: 'a long enough password' })
  })
})

describe('return_to (D6 b)', () => {
  it.each(['/device?user_code=ABCDEFGH', '/connect'])('a signed-out person who signs in goes to %s', async (target) => {
    history.replaceState(null, '', `/sign-in?return_to=${encodeURIComponent(target)}`)
    fakeFetch({ 'GET /auth/get-session': NO_SESSION, 'POST /auth/sign-in/email': { status: 200, json: { user: { email: 'ann@x.test' } } } })
    const go = vi.fn()
    render(<SignInPage navigate={go} />)
    await signInWith()
    await waitFor(() => expect(go).toHaveBeenCalledWith(target))
  })

  it('a signed-in visitor is offered a Continue link to an allowed target', async () => {
    history.replaceState(null, '', '/sign-in?return_to=%2Fdevice%3Fuser_code%3DABCDEFGH')
    fakeFetch({ 'GET /auth/get-session': session({ email: 'ann@x.test' }) })
    render(<SignInPage />)
    const link = await screen.findByRole('link', { name: /continue/i })
    expect(link.getAttribute('href')).toBe('/device?user_code=ABCDEFGH')
  })

  it.each([
    'https://evil.example/device',
    '//evil.example/device',
    '/device/../x',
    '/devices',
    'javascript:alert(1)',
  ])('return_to=%s is ignored: no navigation after sign-in, no Continue link', async (target) => {
    history.replaceState(null, '', `/sign-in?return_to=${encodeURIComponent(target)}`)
    fakeFetch({ 'GET /auth/get-session': NO_SESSION, 'POST /auth/sign-in/email': { status: 200, json: { user: { email: 'ann@x.test' } } } })
    const go = vi.fn()
    render(<SignInPage navigate={go} />)
    await signInWith()
    await screen.findByText('Signed in as ann@x.test')
    expect(go).not.toHaveBeenCalled()
    expect(screen.queryByRole('link')).toBeNull()
  })
})
