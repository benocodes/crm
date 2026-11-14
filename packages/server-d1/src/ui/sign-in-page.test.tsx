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

describe('no continuation (D5)', () => {
  it('a signed query or return_to in the address changes nothing: no navigation, no extra request', async () => {
    history.replaceState(null, '', '/sign-in?return_to=https%3A%2F%2Fevil.test&oauth_query=abc&sig=1')
    const f = fakeFetch({ 'GET /auth/get-session': session({ email: 'ann@x.test' }) })
    const go = vi.fn()
    render(<SignInPage navigate={go} />)
    await screen.findByText('Signed in as ann@x.test')
    expect(go).not.toHaveBeenCalled()
    expect(f.requests()).toEqual(['GET /auth/get-session'])
  })
})
