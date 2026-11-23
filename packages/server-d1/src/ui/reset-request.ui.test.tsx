// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { fakeFetch } from './fake-fetch.js'
import { MESSAGES, genericFailure } from './messages.js'
import { SignInPage } from './sign-in-page.js'

// [[CORE304]] D7, D2, P4: "Forgot password?" on /sign-in exists only when discovery says `self_service_reset: true`; it posts { email } to /auth/request-password-reset and ends in one of five states, rendering no server text.
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})
beforeEach(() => history.replaceState(null, '', '/app/sign-in'))

const NO_SESSION = { status: 200, json: null }
const DISCOVERY = (flag: unknown) => ({
  status: 200,
  json: { auth: { provider: 'better-auth', sign_in_methods: ['password'], self_service_reset: flag } },
})
const REQUEST = 'POST /auth/request-password-reset'
const open = async (routes: Record<string, any> = {}, flag: unknown = true) => {
  const f = fakeFetch({ 'GET /auth/get-session': NO_SESSION, 'GET /.well-known/vibase': DISCOVERY(flag), ...routes })
  render(<SignInPage />)
  const user = userEvent.setup()
  await user.click(await screen.findByRole('button', { name: MESSAGES.forgotPassword }))
  return { f, user }
}
const submit = async (user: ReturnType<typeof userEvent.setup>, address = 'ann@x.test') => {
  const field = await screen.findByLabelText('Email')
  await user.clear(field)
  await user.type(field, address)
  await user.click(screen.getByRole('button', { name: MESSAGES.resetRequestSend }))
}

describe('the form follows discovery (D2, D7)', () => {
  it('self_service_reset true: the Forgot password button, and the ask-an-owner line is gone', async () => {
    fakeFetch({ 'GET /auth/get-session': NO_SESSION, 'GET /.well-known/vibase': DISCOVERY(true) })
    render(<SignInPage />)
    expect(await screen.findByRole('button', { name: 'Forgot password?' })).toBeTruthy()
    expect(screen.queryByText(MESSAGES.signInHelp)).toBeNull()
  })

  it.each([
    ['false', DISCOVERY(false)],
    ['absent', { status: 200, json: { auth: { provider: 'better-auth', sign_in_methods: ['password'] } } }],
    ['a non-boolean', DISCOVERY('true')],
    ['an unreadable discovery', { status: 500, text: 'boom' }],
  ])('%s: today\'s "ask an owner" line stays and there is no button', async (_n, discovery) => {
    fakeFetch({ 'GET /auth/get-session': NO_SESSION, 'GET /.well-known/vibase': discovery })
    render(<SignInPage />)
    await screen.findByText(MESSAGES.signInHelp)
    await new Promise((r) => setTimeout(r, 20))
    expect(screen.queryByRole('button', { name: MESSAGES.forgotPassword })).toBeNull()
    expect(screen.getByText(MESSAGES.signInHelp)).toBeTruthy()
  })
})

describe('the request (D7, P4)', () => {
  it('reveals an email field (autocomplete email) and posts exactly { email }', async () => {
    const { f, user } = await open({ [REQUEST]: { status: 200, json: { status: true } } })
    expect((await screen.findByLabelText('Email')).getAttribute('autocomplete')).toBe('email')
    expect(screen.queryByLabelText('Password')).toBeNull()
    await submit(user)
    await screen.findByText(MESSAGES.resetRequested)
    expect(f.calls.find((c) => c.method === 'POST')!.body).toEqual({ email: 'ann@x.test' })
  })

  it('an invalid address is a field error and sends nothing', async () => {
    const { f, user } = await open()
    await submit(user, 'not-an-address')
    expect(await screen.findByText(MESSAGES.emailInvalid)).toBeTruthy()
    expect(f.requests().filter((r) => r.startsWith('POST'))).toEqual([])
  })

  it('any 2xx (a known and an unknown address answer alike) shows the one confirmation and hides the form', async () => {
    for (const body of [
      { status: true, message: 'sent to ann' },
      { status: true, message: 'no such user' },
      undefined,
    ]) {
      cleanup()
      const { user } = await open({ [REQUEST]: { status: 200, ...(body ? { json: body } : {}) } })
      await submit(user)
      expect((await screen.findByText(MESSAGES.resetRequested)).textContent).toBe(
        'If an account exists for that address, a reset link is on its way.',
      )
      expect(screen.queryByLabelText('Email')).toBeNull()
      expect(screen.queryByRole('button', { name: MESSAGES.resetRequestSend })).toBeNull()
      expect(document.body.textContent).not.toMatch(/sent to ann|no such user/)
    }
  })

  it('a 204 is a success too', async () => {
    const { user } = await open({ [REQUEST]: { status: 204 } })
    await submit(user)
    expect(await screen.findByText(MESSAGES.resetRequested)).toBeTruthy()
  })

  it('429 asks to try again later and keeps the form', async () => {
    const { user } = await open({ [REQUEST]: { status: 429, json: { message: 'Too many requests.' } } })
    await submit(user)
    expect(await screen.findByText(MESSAGES.resetRateLimited)).toBeTruthy()
    expect(screen.getByLabelText('Email')).toBeTruthy()
    expect(screen.queryByText(MESSAGES.resetRequested)).toBeNull()
    expect(document.body.textContent).not.toContain('Too many requests.')
  })

  it.each([
    [500, { status: 500, json: { message: 'SERVER SECRET detail', code: 'X' } }],
    [400, { status: 400, json: { code: 'RESET_PASSWORD_DISABLED', message: 'SERVER SECRET detail' } }],
    [403, { status: 403, text: 'SERVER SECRET detail' }],
  ])('a %s shows the generic message, keeps the form and renders no server text', async (status, reply) => {
    const { user } = await open({ [REQUEST]: reply })
    await submit(user)
    expect(await screen.findByText(genericFailure(status))).toBeTruthy()
    expect(screen.getByLabelText('Email')).toBeTruthy()
    expect(document.body.textContent).not.toContain('SERVER SECRET')
    expect(document.body.textContent).not.toContain('RESET_PASSWORD_DISABLED')
  })

  it('a network error shows the network message and keeps the form', async () => {
    const { user } = await open({
      [REQUEST]: () => {
        throw new TypeError('Failed to fetch')
      },
    })
    await submit(user)
    expect(await screen.findByText(genericFailure(0))).toBeTruthy()
    expect(screen.getByLabelText('Email')).toBeTruthy()
  })

  it('a message clears on the next submit', async () => {
    let n = 0
    const { user } = await open({
      [REQUEST]: () => (++n === 1 ? { status: 429 } : { status: 200, json: { status: true } }),
    })
    await submit(user)
    await screen.findByText(MESSAGES.resetRateLimited)
    await user.click(screen.getByRole('button', { name: MESSAGES.resetRequestSend }))
    await screen.findByText(MESSAGES.resetRequested)
    expect(screen.queryByText(MESSAGES.resetRateLimited)).toBeNull()
  })

  it('toggling back to sign-in clears the message, and reopening shows a clean form', async () => {
    const { user } = await open({ [REQUEST]: { status: 429 } })
    await submit(user)
    await screen.findByText(MESSAGES.resetRateLimited)
    await user.click(screen.getByRole('button', { name: MESSAGES.resetRequestBack }))
    expect(await screen.findByLabelText('Password')).toBeTruthy()
    expect(screen.queryByText(MESSAGES.resetRateLimited)).toBeNull()
    await user.click(screen.getByRole('button', { name: MESSAGES.forgotPassword }))
    await screen.findByRole('button', { name: MESSAGES.resetRequestSend })
    expect(screen.queryByText(MESSAGES.resetRateLimited)).toBeNull()
  })

  it('after the confirmation the person can go back to sign-in', async () => {
    const { user } = await open({ [REQUEST]: { status: 200 } })
    await submit(user)
    await screen.findByText(MESSAGES.resetRequested)
    await user.click(screen.getByRole('button', { name: MESSAGES.resetRequestBack }))
    expect(await screen.findByLabelText('Password')).toBeTruthy()
    expect(screen.queryByText(MESSAGES.resetRequested)).toBeNull()
  })
})

void waitFor
