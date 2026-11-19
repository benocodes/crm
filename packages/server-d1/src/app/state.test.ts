// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest'
import type { Api, ApiResult } from './session/api.js'
import type { Me, SessionSeam } from './session/types.js'
import { createAppController } from './state.js'

// [[UI460]] D4 (group 3), P2, P3 (group 4): the app's state machine over the session seam and the API client, one state for each input. It stores nothing.

const ME = (over: Partial<Me> = {}): Me => ({
  principal: { id: 'p1', kind: 'user' },
  user: { id: 'u1', email: 'ann@x.test', name: 'Ann', email_verified: true },
  agent: null,
  client_id: null,
  memberships: [
    { organization_id: 'o1', organization_name: 'Other Co', role: 'member' },
    { organization_id: 'o2', organization_name: 'Acme', role: 'owner' },
  ],
  active_organization: { id: 'o2', role: 'owner', scopes: ['connections:read'] },
  ...over,
})
const ok = (body: Me): ApiResult<Me> => ({ status: 200, body })
const bad = (status: number, extra: Partial<ApiResult<Me>> = {}): ApiResult<Me> => ({ status, body: null, ...extra })

const seam = (over: Partial<SessionSeam> = {}) => {
  const s = {
    load: vi.fn(async () => {}),
    isSignedIn: vi.fn(() => true),
    getToken: vi.fn(async () => 't'),
    recheckSession: vi.fn(async () => true),
    redirectToSignIn: vi.fn(async (_u: string) => {}),
    signOut: vi.fn(async () => {}),
    profileUrl: vi.fn(() => null as string | null),
    ...over,
  }
  return s satisfies SessionSeam
}
const api = (...answers: (ApiResult<Me> | Error)[]) => {
  const me = vi.fn(async () => {
    const a = answers.length > 1 ? answers.shift()! : answers[0]!
    if (a instanceof Error) throw a
    return a
  })
  const hasEnabledAgent = vi.fn(async (): Promise<ApiResult<boolean>> => ({ status: 200, body: false }))
  return {
    me,
    agents: vi.fn(),
    hasEnabledAgent,
    setDisabled: vi.fn(),
    connections: vi.fn(),
    identityAddress: vi.fn(),
    authorizeGmail: vi.fn(),
    connection: vi.fn(),
    updateConnection: vi.fn(),
    syncConnection: vi.fn(),
    deleteConnection: vi.fn(),
  } satisfies Api
}
const make = (s: SessionSeam | null, a: Api, path = '/home') =>
  createAppController({ seam: s, api: a, origin: 'https://w.test', path })

describe('the states by input (D4)', () => {
  it('no provider (no seam): unavailable, and nothing is called', async () => {
    const a = api(ok(ME()))
    const c = make(null, a)
    expect(c.state().kind).toBe('loading')
    await c.start()
    expect(c.state().kind).toBe('unavailable')
    expect(a.me).not.toHaveBeenCalled()
  })

  it('no session: signed-out, no API call, and no navigation on load', async () => {
    const s = seam({ isSignedIn: vi.fn(() => false) })
    const a = api(ok(ME()))
    const c = make(s, a)
    await c.start()
    expect(c.state().kind).toBe('signed-out')
    expect(a.me).not.toHaveBeenCalled()
    expect(s.redirectToSignIn).not.toHaveBeenCalled()
  })

  it('a 200 with an active organisation: ready, with the name, email, role and the ACTIVE membership’s workspace name', async () => {
    const c = make(seam(), api(ok(ME())))
    await c.start()
    expect(c.state()).toEqual({
      kind: 'ready',
      who: { name: 'Ann', email: 'ann@x.test', role: 'owner', workspaceName: 'Acme', userId: 'u1' },
      scopes: ['connections:read'],
      manageAccountHref: null,
      connectAgent: { status: 'show' },
      connectEmail: { status: 'hidden' },
    })
  })

  it('a person with no name is shown by their email; Clerk’s profile URL is carried', async () => {
    const s = seam({ profileUrl: vi.fn(() => 'https://acc.test/user') })
    const c = make(s, api(ok(ME({ user: { id: 'u1', email: 'ann@x.test', name: null, email_verified: true } }))))
    await c.start()
    expect(c.state()).toMatchObject({
      kind: 'ready',
      who: { name: 'ann@x.test' },
      manageAccountHref: 'https://acc.test/user',
    })
  })

  it('with no role on the active organisation the membership role is shown; with no membership for it the workspace is named generically', async () => {
    const noRole = ME({ active_organization: { id: 'o2', role: null, scopes: [] } })
    const a = make(seam(), api(ok(noRole)))
    await a.start()
    expect(a.state()).toMatchObject({ kind: 'ready', who: { role: 'owner', workspaceName: 'Acme' } })
    const noMembership = ME({ memberships: [], active_organization: { id: 'o2', role: 'member', scopes: [] } })
    const b = make(seam(), api(ok(noMembership)))
    await b.start()
    expect(b.state()).toMatchObject({ kind: 'ready', who: { role: 'member', workspaceName: 'Your workspace' } })
  })

  it.each([
    ['a 403', bad(403), undefined],
    ['a 200 with no active organisation', ok(ME({ active_organization: null })), 'Ann'],
    [
      'a 200 for an agent principal (no user)',
      ok(ME({ user: null, principal: { id: 'a1', kind: 'agent' } })),
      undefined,
    ],
  ])('%s: no-access, with who only when a person is known', async (_n, answer, who) => {
    const c = make(seam(), api(answer))
    await c.start()
    expect(c.state().kind).toBe('no-access')
    expect((c.state() as { who?: string }).who).toBe(who)
  })

  it('no-access for a person with no name shows their email as who', async () => {
    const c = make(
      seam(),
      api(
        ok(
          ME({ active_organization: null, user: { id: 'u1', email: 'ann@x.test', name: null, email_verified: true } }),
        ),
      ),
    )
    await c.start()
    expect(c.state()).toMatchObject({ kind: 'no-access', who: 'ann@x.test' })
  })

  it('a refused sign-out from no-access keeps the card with an error that clears on the next attempt', async () => {
    const signOut = vi.fn().mockRejectedValueOnce(new Error('refused')).mockResolvedValueOnce(undefined)
    const c = make(seam({ signOut }), api(ok(ME({ active_organization: null }))))
    await c.start()
    await c.signOut()
    expect(c.state()).toMatchObject({
      kind: 'no-access',
      who: 'Ann',
      signOutError: expect.stringMatching(/sign.?out/i),
    })
    const during: unknown[] = []
    c.subscribe(() => during.push((c.state() as { signOutError?: string }).signOutError))
    await c.signOut()
    expect(during[0]).toBeUndefined()
    expect(c.state().kind).toBe('signed-out')
  })

  it.each([
    ['a 500', bad(500)],
    ['a 503 migrations_pending', bad(503)],
    ['a 404', bad(404)],
    ['a network failure', new Error('network down')],
  ])('%s: error', async (_n, answer) => {
    const c = make(seam(), api(answer))
    await c.start()
    expect(c.state().kind).toBe('error')
    expect((c.state() as { message: string }).message).toMatch(/\S/)
  })

  it('a session that cannot load is an error, not signed-out', async () => {
    const c = make(seam({ load: vi.fn(async () => Promise.reject(new Error('boom'))) }), api(ok(ME())))
    await c.start()
    expect(c.state().kind).toBe('error')
  })

  it('Retry re-reads: error becomes ready when the API answers, and the API is called again', async () => {
    const a = api(bad(500), ok(ME()))
    const s = seam()
    const c = make(s, a)
    await c.start()
    expect(c.state().kind).toBe('error')
    await c.retry()
    expect(a.me).toHaveBeenCalledTimes(2)
    expect(c.state().kind).toBe('ready')
    expect(s.load).toHaveBeenCalledTimes(1) // the session is already loaded; Retry re-reads the API, not the SDK
  })

  it('Retry after a failed load loads again', async () => {
    const load = vi.fn().mockRejectedValueOnce(new Error('x')).mockResolvedValue(undefined)
    const c = make(seam({ load }), api(ok(ME())))
    await c.start()
    expect(c.state().kind).toBe('error')
    await c.retry()
    expect(load).toHaveBeenCalledTimes(2)
    expect(c.state().kind).toBe('ready')
  })
})

describe('a 401 re-checks the session once and never loops (D4)', () => {
  it('the session is gone: signed-out after one re-check and one call', async () => {
    const s = seam({ recheckSession: vi.fn(async () => false) })
    const a = api(bad(401))
    const c = make(s, a)
    await c.start()
    expect(c.state().kind).toBe('signed-out')
    expect(s.recheckSession).toHaveBeenCalledTimes(1)
    expect(a.me).toHaveBeenCalledTimes(1)
  })

  it('the session is live: the call is retried once, and a second 401 ends in error with no third call', async () => {
    const s = seam()
    const a = api(bad(401))
    const c = make(s, a)
    await c.start()
    expect(c.state().kind).toBe('error')
    expect(s.recheckSession).toHaveBeenCalledTimes(1)
    expect(a.me).toHaveBeenCalledTimes(2)
  })

  it('the session is live and the retry succeeds: ready', async () => {
    const a = api(bad(401), ok(ME()))
    const c = make(seam(), a)
    await c.start()
    expect(c.state().kind).toBe('ready')
    expect(a.me).toHaveBeenCalledTimes(2)
  })

  it('no token to send: signed-out without a re-check', async () => {
    const s = seam()
    const c = make(s, api(bad(401, { noToken: true })))
    await c.start()
    expect(c.state().kind).toBe('signed-out')
    expect(s.recheckSession).not.toHaveBeenCalled()
  })
})

describe('signing in and out (D4, P2, P3, group 4)', () => {
  it('Sign in calls the seam with <origin><current page path>, never a query', async () => {
    const s = seam({ isSignedIn: vi.fn(() => false) })
    const c = make(s, api(ok(ME())), '/home')
    await c.start()
    await c.signIn()
    expect(s.redirectToSignIn).toHaveBeenCalledExactlyOnceWith('https://w.test/home')
  })

  it('a successful sign-out shows signed-out', async () => {
    const c = make(seam(), api(ok(ME())))
    await c.start()
    await c.signOut()
    expect(c.state().kind).toBe('signed-out')
  })

  it('a refused sign-out keeps the shell with an error, and the error clears on the next attempt', async () => {
    const signOut = vi.fn().mockRejectedValueOnce(new Error('refused')).mockResolvedValueOnce(undefined)
    const c = make(seam({ signOut }), api(ok(ME())))
    await c.start()
    await c.signOut()
    expect(c.state()).toMatchObject({ kind: 'ready', signOutError: expect.stringMatching(/sign.?out/i) })
    const during: unknown[] = []
    c.subscribe(() => during.push((c.state() as { signOutError?: string }).signOutError))
    await c.signOut()
    expect(during[0]).toBeUndefined() // cleared as the attempt begins
    expect(c.state().kind).toBe('signed-out')
  })
})

describe('nothing is stored (D4)', () => {
  it('a run through ready writes no localStorage, sessionStorage or cookie', async () => {
    document.cookie = ''
    const c = make(seam(), api(ok(ME())))
    await c.start()
    expect(c.state().kind).toBe('ready')
    expect(localStorage.length).toBe(0)
    expect(sessionStorage.length).toBe(0)
    expect(document.cookie).toBe('')
  })

  it('subscribers hear every change and can unsubscribe', async () => {
    const c = make(seam(), api(ok(ME())))
    const heard: string[] = []
    const off = c.subscribe(() => heard.push(c.state().kind))
    await c.start()
    expect(heard).toContain('ready')
    off()
    heard.length = 0
    await c.signOut()
    expect(heard).toEqual([])
  })
})

// [[UI461]] D10, P4 (group 3): when the Connect an agent prompt shows. The state carries the check's outcome; the view model (first-steps.test.ts) turns it into markup decisions.
describe('the Connect an agent check (D10, P4)', () => {
  const READER = ME({ active_organization: { id: 'o2', role: 'owner', scopes: ['agents:read'] } })
  const withAgents = (...answers: (ApiResult<boolean> | Error)[]) => {
    const a = api(ok(READER))
    a.hasEnabledAgent.mockImplementation(async () => {
      const x = answers.length > 1 ? answers.shift()! : answers[0]!
      if (x instanceof Error) throw x
      return x
    })
    return a
  }
  const found = (body: boolean): ApiResult<boolean> => ({ status: 200, body })

  it('an empty list (or only disabled agents) shows the prompt', async () => {
    const a = withAgents(found(false))
    const c = make(seam(), a)
    await c.start()
    expect(c.state()).toMatchObject({ kind: 'ready', connectAgent: { status: 'show' } })
    expect(a.hasEnabledAgent).toHaveBeenCalledTimes(1)
  })

  it('an enabled agent hides it', async () => {
    const c = make(seam(), withAgents(found(true)))
    await c.start()
    expect(c.state()).toMatchObject({ kind: 'ready', connectAgent: { status: 'hidden' } })
  })

  it('without agents:read no agents request is made and the prompt shows', async () => {
    const a = api(ok(ME()))
    const c = make(seam(), a)
    await c.start()
    expect(a.hasEnabledAgent).not.toHaveBeenCalled()
    expect(a.agents).not.toHaveBeenCalled()
    expect(c.state()).toMatchObject({ connectAgent: { status: 'show' } })
  })

  it.each([
    ['a non-2xx answer', { status: 500, body: null } as ApiResult<boolean>],
    ['a network failure', new Error('offline')],
  ])('%s is the one-line error, never the prompt; the page stays ready', async (_n, answer) => {
    const c = make(seam(), withAgents(answer))
    await c.start()
    const s = c.state()
    expect(s.kind).toBe('ready')
    expect((s as { connectAgent: { status: string; message?: string } }).connectAgent).toEqual({
      status: 'error',
      message: expect.stringMatching(/agents/i),
    })
  })

  it('Check again re-reads and hides the prompt when an enabled agent has appeared; it writes nothing', async () => {
    const a = withAgents(found(false), found(true))
    const c = make(seam(), a)
    await c.start()
    expect(c.state()).toMatchObject({ connectAgent: { status: 'show' } })
    await c.checkAgain()
    expect(a.hasEnabledAgent).toHaveBeenCalledTimes(2)
    expect(c.state()).toMatchObject({ kind: 'ready', connectAgent: { status: 'hidden' } })
    expect(a.setDisabled).not.toHaveBeenCalled()
  })

  it('Check again with still no agent keeps the prompt; a failed re-read shows the error', async () => {
    const c = make(seam(), withAgents(found(false), found(false), { status: 503, body: null }))
    await c.start()
    await c.checkAgain()
    expect(c.state()).toMatchObject({ connectAgent: { status: 'show' } })
    await c.checkAgain()
    expect(c.state()).toMatchObject({ connectAgent: { status: 'error' } })
  })

  it('a refused sign-out keeps the check as it was', async () => {
    const signOut = vi.fn().mockRejectedValueOnce(new Error('refused'))
    const c = make(seam({ signOut }), withAgents(found(true)))
    await c.start()
    await c.signOut()
    expect(c.state()).toMatchObject({
      kind: 'ready',
      connectAgent: { status: 'hidden' },
      signOutError: expect.any(String),
    })
    await c.signOut()
  })
})

// [[UI469]] D13, P3: the controller wires the Connect your email check with the person's id and scopes, and keeps it through Check again.
describe('the Connect your email check in the state (D13)', () => {
  const RW = ME({ active_organization: { id: 'o2', role: 'owner', scopes: ['connections:read', 'connections:write'] } })
  const own = (over: object = {}) => ({ id: 'c', owner_id: 'u1', identity_id: 'i', status: 'active', ...over })
  it('with write: one list read; no own connection shows the prompt, an own one hides it', async () => {
    const a = api(ok(RW))
    a.connections.mockResolvedValue({ status: 200, body: [own({ owner_id: 'other' })] })
    const c = make(seam(), a)
    await c.start()
    expect(a.connections).toHaveBeenCalledTimes(1)
    expect(c.state()).toMatchObject({ kind: 'ready', connectEmail: { status: 'show' } })
    const b = api(ok(RW))
    b.connections.mockResolvedValue({ status: 200, body: [own({ status: 'reauth_required' })] })
    const d = make(seam(), b)
    await d.start()
    expect(d.state()).toMatchObject({ connectEmail: { status: 'hidden' } })
  })
  it('without write: hidden and no connections call', async () => {
    const a = api(ok(ME()))
    const c = make(seam(), a)
    await c.start()
    expect(a.connections).not.toHaveBeenCalled()
    expect(c.state()).toMatchObject({ connectEmail: { status: 'hidden' } })
  })
  it('a failed list read is the error line and the page stays ready; Check again leaves it alone', async () => {
    const a = api(ok(RW))
    a.connections.mockResolvedValue({ status: 500, body: null })
    const c = make(seam(), a)
    await c.start()
    expect(c.state()).toMatchObject({
      kind: 'ready',
      connectEmail: { status: 'error', message: 'The mailbox list could not be read. Reload the page to try again.' },
    })
    await c.checkAgain()
    expect(a.connections).toHaveBeenCalledTimes(1)
    expect(c.state()).toMatchObject({ connectEmail: { status: 'error' } })
  })
  it('a 401 on the list re-checks the session once, then signed-out when it is gone', async () => {
    const a = api(ok(RW))
    a.connections.mockResolvedValue({ status: 401, body: null, noToken: true })
    const c = make(seam(), a)
    await c.start()
    expect(c.state().kind).toBe('signed-out')
  })
})
