// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest'
import { windowClerk } from './clerk-window.js'

// [[UI30]] D4/D6: the real wrapper over `window.Clerk`, with a fake SDK. Sign-out must land back on this page: with no redirect Clerk sends
// the browser to the origin root, which is a 404 on the API.

const AUTH = {
  provider: 'clerk',
  issuer: 'https://x.clerk.accounts.dev',
  cli_client_id: null,
  publishable_key: ['pk', 'test', btoa('x.clerk.accounts.dev$')].join('_'),
}
afterEach(() => {
  delete (window as unknown as { Clerk?: unknown }).Clerk
})

describe('windowClerk', () => {
  it('signOut asks Clerk to come back to /connect', async () => {
    const calls: unknown[] = []
    ;(window as unknown as { Clerk: unknown }).Clerk = {
      load: async () => {},
      signOut: async (o?: unknown) => void calls.push(o),
    }
    const c = windowClerk(AUTH, { loadScript: async () => {} })
    await c.load()
    await c.signOut()
    expect(calls).toEqual([{ redirectUrl: '/connect' }])
  })
})

describe('windowClerk sign-out return (UI460 P3)', () => {
  const fake = () => {
    const calls: unknown[] = []
    ;(window as unknown as { Clerk: unknown }).Clerk = {
      load: async () => {},
      signOut: async (o?: unknown) => void calls.push(o),
    }
    return calls
  }
  it('the app returns to the URL its caller gave (<origin>/home)', async () => {
    const calls = fake()
    const c = windowClerk(AUTH, { loadScript: async () => {}, signOutReturn: 'https://w.test/home' })
    await c.load()
    await c.signOut()
    expect(calls).toEqual([{ redirectUrl: 'https://w.test/home' }])
  })
  it('with nothing given it still returns to /connect', async () => {
    const calls = fake()
    const c = windowClerk(AUTH, { loadScript: async () => {} })
    await c.load()
    await c.signOut()
    expect(calls).toEqual([{ redirectUrl: '/connect' }])
  })
  it('Sign in is redirectToSignIn with the URL it is given', async () => {
    const urls: unknown[] = []
    ;(window as unknown as { Clerk: unknown }).Clerk = {
      load: async () => {},
      redirectToSignIn: async (o: unknown) => void urls.push(o),
    }
    const c = windowClerk(AUTH, { loadScript: async () => {} })
    await c.load()
    await c.redirectToSignIn('https://w.test/home')
    expect(urls).toEqual([{ redirectUrl: 'https://w.test/home' }])
  })
})
