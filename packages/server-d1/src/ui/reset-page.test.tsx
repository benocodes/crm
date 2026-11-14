// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/preact'
import userEvent from '@testing-library/user-event'
import { fakeFetch } from './fake-fetch.js'
import { MESSAGES, genericFailure } from './messages.js'
import { ResetPage } from './reset-page.js'

// [[UI246]] D6: the reset page. Fragment read and removed, no token no form, a mismatch is refused before any request, the body is { newPassword, token }, INVALID_TOKEN and a bad length map to the page's own text, success goes to /sign-in with a notice.
const TOKEN = 'reset_tok-123'
const GOOD = 'a brand new password'
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})
beforeEach(() => history.replaceState(null, '', `/reset-password#token=${TOKEN}`))

const fill = async (a = GOOD, b = a) => {
  const user = userEvent.setup()
  await user.type(screen.getByLabelText('New password'), a)
  await user.type(screen.getByLabelText('Confirm new password'), b)
  return user
}
const submit = (user: ReturnType<typeof userEvent.setup>) => user.click(screen.getByRole('button', { name: /set new password/i }))

describe('the fragment token', () => {
  it('is read and removed from the address before the form renders', () => {
    render(<ResetPage />)
    expect(screen.getByLabelText('New password')).toBeTruthy()
    expect(location.hash).toBe('')
    expect(location.href).not.toContain(TOKEN)
    expect(location.pathname).toBe('/reset-password')
  })

  it.each(['/reset-password', '/reset-password#token=', '/reset-password#x=1'])('%s: an explanation and no form', (url) => {
    history.replaceState(null, '', url)
    render(<ResetPage />)
    expect(screen.getByText(MESSAGES.resetNoToken)).toBeTruthy()
    expect(screen.queryByLabelText('New password')).toBeNull()
  })

  it('both fields are new-password', () => {
    render(<ResetPage />)
    expect(screen.getByLabelText('New password').getAttribute('autocomplete')).toBe('new-password')
    expect(screen.getByLabelText('Confirm new password').getAttribute('autocomplete')).toBe('new-password')
  })
})

describe('validation sends nothing', () => {
  it('a mismatch is refused with no request, in a focused alert and a field error', async () => {
    const f = fakeFetch({})
    render(<ResetPage />)
    await submit(await fill(GOOD, `${GOOD}x`))
    expect(await screen.findByText(MESSAGES.passwordMismatch)).toBeTruthy()
    const alert = screen.getByRole('alert')
    expect(alert.textContent).toBe(MESSAGES.fixFields)
    expect(document.activeElement).toBe(alert)
    expect(f.calls).toEqual([])
  })

  it.each([
    ['7 characters', '1234567', MESSAGES.passwordTooShort],
    ['129 characters', 'x'.repeat(129), MESSAGES.passwordTooLong],
  ])('%s: a field error and no request', async (_n, pw, message) => {
    const f = fakeFetch({})
    render(<ResetPage />)
    await submit(await fill(pw))
    expect(await screen.findByText(message)).toBeTruthy()
    expect(f.calls).toEqual([])
  })
})

describe('the request and its outcomes', () => {
  it('posts exactly { newPassword, token } to /auth/reset-password; success navigates to /sign-in with the notice', async () => {
    const f = fakeFetch({ 'POST /auth/reset-password': { status: 200, json: { status: true } } })
    const go = vi.fn()
    render(<ResetPage navigate={go} />)
    await submit(await fill())
    await waitFor(() => expect(go).toHaveBeenCalledWith('/sign-in?notice=password-reset'))
    expect(f.calls).toHaveLength(1)
    expect(f.calls[0]!.body).toEqual({ newPassword: GOOD, token: TOKEN })
  })

  const cases: Array<[string, { status: number; json?: unknown; text?: string }, string]> = [
    ['INVALID_TOKEN', { status: 400, json: { code: 'INVALID_TOKEN', message: 'Invalid token' } }, MESSAGES.resetInvalidLink],
    ['PASSWORD_TOO_SHORT from the server', { status: 400, json: { code: 'PASSWORD_TOO_SHORT', message: 'Password too short' } }, MESSAGES.passwordTooShort],
    ['PASSWORD_TOO_LONG from the server', { status: 400, json: { code: 'PASSWORD_TOO_LONG', message: 'Password too long' } }, MESSAGES.passwordTooLong],
    ['429', { status: 429, json: {} }, MESSAGES.rateLimited],
    ['an unknown status', { status: 500, text: 'boom' }, genericFailure(500)],
  ]
  it.each(cases)('%s reaches its message and no navigation happens', async (_n, reply, message) => {
    fakeFetch({ 'POST /auth/reset-password': reply })
    const go = vi.fn()
    render(<ResetPage navigate={go} />)
    await submit(await fill())
    await waitFor(() => expect(document.body.textContent).toContain(message))
    expect(go).not.toHaveBeenCalled()
    // The alert (or the field error beside it) carries the page's text, and a failed submit moves focus to the alert.
    const alert = screen.getByRole('alert')
    await waitFor(() => expect(document.activeElement).toBe(alert))
  })

  it('a server message with markup is never rendered', async () => {
    fakeFetch({ 'POST /auth/reset-password': { status: 400, json: { code: 'INVALID_TOKEN', message: '<img src=x><b id="injected">hi</b>' } } })
    render(<ResetPage navigate={() => {}} />)
    await submit(await fill())
    expect((await screen.findByRole('alert')).textContent).toBe(MESSAGES.resetInvalidLink)
    expect(document.getElementById('injected')).toBeNull()
    expect(document.querySelector('img')).toBeNull()
  })
})
