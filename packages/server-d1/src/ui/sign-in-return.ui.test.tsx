// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { fakeFetch } from './fake-fetch.js'
import { MESSAGES, genericFailure } from './messages.js'
import { SignInPage } from './sign-in-page.js'

// [[UI255]] D8, P2 (group 4, page): a cross-origin absolute `return_to` (https, or http://localhost) is never followed by the page itself. It is sent as `callbackURL` on the password and Google requests, and the page navigates only
// to the `url` a successful answer returns; Better Auth's origin check (server side) is what decides. The same-origin allow-list (/device, /connect) is sign-in-page.test.tsx's and stays unchanged.
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})
const APP = 'https://app.example.com/orders?tab=open'
const at = (returnTo: string) => history.replaceState(null, '', `/sign-in?return_to=${encodeURIComponent(returnTo)}`)
beforeEach(() => history.replaceState(null, '', '/sign-in'))

const NO_SESSION = { status: 200, json: null }
const signInWith = async () => {
  const user = userEvent.setup()
  await user.type(await screen.findByLabelText('Email'), 'ann@x.test')
  await user.type(screen.getByLabelText('Password'), 'a long enough password')
  await user.click(screen.getByRole('button', { name: /sign in/i }))
}
const post = (f: ReturnType<typeof fakeFetch>, path: string) =>
  f.calls.filter((c) => c.method === 'POST' && c.path === path)

describe("a cross-origin return_to is a callbackURL, never a navigation of the page's own", () => {
  it.each([[APP], ['http://localhost:8788/'], ['http://localhost/x']])(
    'password sign-in with return_to=%s sends it as callbackURL and navigates to the url the answer returns',
    async (target) => {
      at(target)
      const f = fakeFetch({
        'GET /auth/get-session': NO_SESSION,
        'POST /auth/sign-in/email': {
          status: 200,
          json: { redirect: true, url: target, user: { email: 'ann@x.test' } },
        },
      })
      const go = vi.fn()
      render(<SignInPage navigate={go} />)
      await signInWith()
      await waitFor(() => expect(go).toHaveBeenCalledWith(target))
      expect(post(f, '/auth/sign-in/email')[0]!.body).toMatchObject({ email: 'ann@x.test', callbackURL: target })
    },
  )

  it('navigates only to the response url: a success that returns none goes to /connect, never to return_to', async () => {
    at(APP)
    fakeFetch({
      'GET /auth/get-session': NO_SESSION,
      'POST /auth/sign-in/email': { status: 200, json: { user: { email: 'ann@x.test' } } },
    })
    const go = vi.fn()
    render(<SignInPage navigate={go} />)
    await signInWith()
    await waitFor(() => expect(go).toHaveBeenCalledWith('/connect'))
    expect(go).toHaveBeenCalledTimes(1)
  })

  it('Google sign-in sends the cross-origin return_to as callbackURL', async () => {
    at(APP)
    const f = fakeFetch({
      'GET /auth/get-session': NO_SESSION,
      'GET /.well-known/vibase': { status: 200, json: { auth: { sign_in_methods: ['password', 'google'] } } },
      'POST /auth/sign-in/social': { status: 200, json: { url: 'https://accounts.google.com/x', redirect: true } },
    })
    const go = vi.fn()
    render(<SignInPage navigate={go} />)
    await userEvent.setup().click(await screen.findByRole('button', { name: MESSAGES.googleButton }))
    await waitFor(() => expect(post(f, '/auth/sign-in/social')).toHaveLength(1))
    expect(post(f, '/auth/sign-in/social')[0]!.body).toMatchObject({
      provider: 'google',
      callbackURL: APP,
      errorCallbackURL: '/sign-in',
    })
    expect(go).toHaveBeenCalledWith('https://accounts.google.com/x')
  })
})

describe('P2: the failure paths', () => {
  it('a refused callbackURL (403) shows the ordinary sign-in error, stays on the page, and the error clears on the next submit', async () => {
    at(APP)
    let n = 0
    fakeFetch({
      'GET /auth/get-session': NO_SESSION,
      'POST /auth/sign-in/email': () =>
        ++n === 1
          ? { status: 403, json: { code: 'INVALID_CALLBACK_URL', message: 'Invalid callbackURL' } }
          : { status: 200, json: { redirect: true, url: APP, user: { email: 'ann@x.test' } } },
    })
    const go = vi.fn()
    render(<SignInPage navigate={go} />)
    await signInWith()
    expect(await screen.findByText(genericFailure(403))).toBeTruthy()
    expect(go).not.toHaveBeenCalled()
    expect(document.body.textContent).not.toContain('Invalid callbackURL')
    await userEvent.setup().click(screen.getByRole('button', { name: /sign in/i }))
    await waitFor(() => expect(go).toHaveBeenCalledWith(APP))
    expect(screen.queryByText(genericFailure(403))).toBeNull()
  })

  it('a signed-in person with a cross-origin return_to sees the signed-in state and is not redirected', async () => {
    at(APP)
    fakeFetch({
      'GET /auth/get-session': {
        status: 200,
        json: { user: { id: 'u1', email: 'ann@x.test' }, session: { id: 's1' } },
      },
    })
    const go = vi.fn()
    render(<SignInPage navigate={go} />)
    expect(await screen.findByText('Signed in as ann@x.test')).toBeTruthy()
    expect(go).not.toHaveBeenCalled()
    for (const a of document.querySelectorAll('a')) expect(a.getAttribute('href')).not.toContain('app.example.com')
  })

  it.each([
    ['javascript:alert(1)'],
    ['data:text/html,<b>x</b>'],
    ['http://app.example.com/'],
    ['ftp://app.example.com/'],
    ['https://user:pw@app.example.com/'],
  ])('return_to=%s is ignored: no callbackURL is sent', async (target) => {
    at(target)
    const f = fakeFetch({
      'GET /auth/get-session': NO_SESSION,
      'POST /auth/sign-in/email': { status: 200, json: { user: { email: 'ann@x.test' } } },
    })
    const go = vi.fn()
    render(<SignInPage navigate={go} />)
    await signInWith()
    await waitFor(() => expect(go).toHaveBeenCalledWith('/connect'))
    expect(post(f, '/auth/sign-in/email')[0]!.body).not.toHaveProperty('callbackURL')
  })
})
