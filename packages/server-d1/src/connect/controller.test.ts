// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest'
import { createApi } from './api.js'
import { createPage } from './controller.js'
import { FakeClerk } from './test/fake-clerk.js'
import type { AgentRecord, Discovery, Me } from './types.js'

// [[UI30]] D4, D6, D8: the page's state machine over a fake Clerk and a fake API. No network, no Clerk instance.

const ORIGIN = 'http://localhost:8787'
const ID = (n: number) => `0190b2c4-0000-7000-8000-${String(n).padStart(12, '0')}`
const DISCOVERY: Discovery = { auth: { provider: 'clerk', issuer: 'https://x.clerk.accounts.dev', cli_client_id: 'cli', publishable_key: ['pk', 'test', btoa('x.clerk.accounts.dev$')].join('_') } }

const me = (kind: 'user' | 'agent', scopes: string[], role: 'owner' | 'member' | null = 'owner'): Me => ({
  principal: { id: ID(1), kind },
  user: kind === 'user' ? { id: ID(1), email: 'o@x.test', name: null, email_verified: true } : null,
  agent: kind === 'agent' ? { id: ID(1), name: 'g', delegated_by: null, auth_client_id: null, auth_subject: 'user_g' } : null,
  client_id: null,
  memberships: [],
  active_organization: { id: ID(9), role, scopes },
})
const agent = (n: number, over: Partial<AgentRecord> = {}): AgentRecord => ({ id: ID(n), name: `a${n}`, scopes: [], disabled_at: null, created_at: 'c', auth_subject: null, auth_client_id: null, delegated_by: null, ...over })
const OWNER = me('user', ['agents:read', 'agents:write'])

interface Seen {
  method: string
  url: string
  headers: Record<string, string>
  body: string | null
}
/** A fake vibase API: a script of responses per `METHOD path`, each consumed in order (the last repeats). Records every request. */
function fakeVibase(script: Record<string, (Response | (() => Response))[]>) {
  const seen: Seen[] = []
  const used: Record<string, number> = {}
  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
    const method = init?.method ?? 'GET'
    const headers = Object.fromEntries(new Headers(init?.headers).entries())
    seen.push({ method, url: url.pathname + url.search, headers, body: typeof init?.body === 'string' ? init.body : null })
    const key = `${method} ${url.pathname}`
    const list = script[key]
    if (!list) return new Response('{}', { status: 599 })
    const i = Math.min(used[key] ?? 0, list.length - 1)
    used[key] = (used[key] ?? 0) + 1
    const r = list[i]!
    return typeof r === 'function' ? r() : r.clone()
  }) as typeof fetch
  return { fetchFn, seen, calls: (key: string) => seen.filter((s) => `${s.method} ${s.url.split('?')[0]}` === key) }
}
const ok = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
const err = (status: number) => ok({ error: { code: 'x', message: 'y' } }, status)

const setup = (clerk: FakeClerk, vibase: ReturnType<typeof fakeVibase>, discovery: Discovery = DISCOVERY) => {
  const api = createApi({ origin: ORIGIN, getToken: () => clerk.getToken(), fetch: vibase.fetchFn })
  const states: string[] = []
  const page = createPage({ clerk, api, discovery, origin: ORIGIN, onChange: (s) => states.push(s.kind) })
  return { page, states }
}

// D10 (tokens): whatever a test does, no token is in a URL or in browser storage, and a token is never sent twice.
let current: { clerk: FakeClerk; vibase: ReturnType<typeof fakeVibase> } | undefined
afterEach(() => {
  if (current) {
    const { clerk, vibase } = current
    for (const s of vibase.seen) {
      for (const t of clerk.issued) expect(s.url, 'token in a URL').not.toContain(t)
      expect(s.headers.authorization, 'bearer only').toMatch(/^Bearer tok\./)
    }
    const sent = vibase.seen.map((s) => s.headers.authorization)
    expect(new Set(sent).size, 'a token was reused across requests').toBe(sent.length)
    expect(vibase.seen.length).toBe(clerk.tokens)
  }
  expect(localStorage.length).toBe(0)
  expect(sessionStorage.length).toBe(0)
  current = undefined
})
const run = (clerk: FakeClerk, script: Record<string, (Response | (() => Response))[]>, discovery?: Discovery) => {
  const vibase = fakeVibase(script)
  current = { clerk, vibase }
  return { vibase, ...setup(clerk, vibase, discovery) }
}

describe('start', () => {
  it('starts in loading', () => {
    const { page } = run(new FakeClerk(), {})
    expect(page.state().kind).toBe('loading')
  })

  it.each([
    ['no auth in discovery', { auth: null } as Discovery],
    ['no publishable key', { auth: { ...DISCOVERY.auth!, publishable_key: null } } as Discovery],
  ])('%s: sign-in unavailable, Clerk is never loaded and the API is never called', async (_n, discovery) => {
    const clerk = new FakeClerk()
    const { page, vibase } = run(clerk, {}, discovery)
    await page.start()
    expect(page.state().kind).toBe('unavailable')
    expect(clerk.loads).toBe(0)
    expect(vibase.seen).toEqual([])
    current = undefined
  })

  it('signed out: loads Clerk, calls nothing, and sign-in redirects back to this page', async () => {
    const clerk = new FakeClerk(false)
    const { page, vibase } = run(clerk, {})
    await page.start()
    expect(clerk.loads).toBe(1)
    expect(page.state().kind).toBe('signed-out')
    expect(vibase.seen).toEqual([])
    await page.signIn()
    expect(clerk.redirects).toEqual([`${ORIGIN}/connect`])
  })

  it('owner: me.get, then the agents list; the state carries both', async () => {
    const clerk = new FakeClerk()
    const { page, vibase, states } = run(clerk, { 'GET /meta/v1/me': [ok(OWNER)], 'GET /meta/v1/agents': [ok({ data: [agent(10)], next_cursor: null })] })
    await page.start()
    const s = page.state()
    expect(s.kind === 'signed-in' && s.agents?.map((a) => a.id)).toEqual([ID(10)])
    expect(states).toEqual(['loading', 'signed-in'].slice(1))
    expect(vibase.seen.map((x) => `${x.method} ${x.url.split('?')[0]}`)).toEqual(['GET /meta/v1/me', 'GET /meta/v1/agents'])
  })

  it('a member lists agents; an agent role (no agents:read) calls me only', async () => {
    const m = run(new FakeClerk(), { 'GET /meta/v1/me': [ok(me('user', ['agents:read'], 'member'))], 'GET /meta/v1/agents': [ok({ data: [], next_cursor: null })] })
    await m.page.start()
    expect(m.vibase.calls('GET /meta/v1/agents')).toHaveLength(1)
    const g = run(new FakeClerk(), { 'GET /meta/v1/me': [ok(me('agent', [], null))] })
    await g.page.start()
    expect(g.vibase.seen).toHaveLength(1)
    const s = g.page.state()
    expect(s.kind === 'signed-in' && s.agents).toBeNull()
  })

  it('403 from me.get: refused 403, no list', async () => {
    const { page, vibase } = run(new FakeClerk(), { 'GET /meta/v1/me': [err(403)] })
    await page.start()
    expect(page.state()).toEqual({ kind: 'refused', status: 403 })
    expect(vibase.seen).toHaveLength(1)
  })
})

describe('pagination', () => {
  it('agents.list follows next_cursor until it is null (two pages)', async () => {
    const { page, vibase } = run(new FakeClerk(), {
      'GET /meta/v1/me': [ok(OWNER)],
      'GET /meta/v1/agents': [ok({ data: [agent(10), agent(11)], next_cursor: ID(11) }), ok({ data: [agent(12)], next_cursor: null })],
    })
    await page.start()
    const s = page.state()
    expect(s.kind === 'signed-in' && s.agents?.map((a) => a.id)).toEqual([ID(10), ID(11), ID(12)])
    const list = vibase.calls('GET /meta/v1/agents')
    expect(list).toHaveLength(2)
    expect(list[0]!.url).not.toContain('after=')
    expect(list[1]!.url).toContain(`after=${ID(11)}`)
  })
})

describe('the 401 path', () => {
  it('the session is gone: exactly one re-check, no retry, signed out', async () => {
    const clerk = new FakeClerk(true, false)
    const { page, vibase } = run(clerk, { 'GET /meta/v1/me': [err(401)] })
    await page.start()
    expect(clerk.rechecks).toBe(1)
    expect(vibase.calls('GET /meta/v1/me')).toHaveLength(1)
    expect(page.state().kind).toBe('signed-out')
  })

  it('the session is still active: one re-check, one retry with a fresh token; a second 401 is refused 401, no loop', async () => {
    const clerk = new FakeClerk(true, true)
    const { page, vibase } = run(clerk, { 'GET /meta/v1/me': [err(401)] })
    await page.start()
    expect(clerk.rechecks).toBe(1)
    expect(vibase.calls('GET /meta/v1/me')).toHaveLength(2)
    expect(page.state()).toEqual({ kind: 'refused', status: 401 })
  })

  it('a transient 401 that the retry clears carries on to the data', async () => {
    const { page, vibase } = run(new FakeClerk(), { 'GET /meta/v1/me': [err(401), ok(OWNER)], 'GET /meta/v1/agents': [ok({ data: [], next_cursor: null })] })
    await page.start()
    expect(page.state().kind).toBe('signed-in')
    expect(vibase.calls('GET /meta/v1/me')).toHaveLength(2)
  })

  it('a 401 on the list re-checks once too (session still active: refused 401)', async () => {
    const clerk = new FakeClerk(true, true)
    const { page } = run(clerk, { 'GET /meta/v1/me': [ok(OWNER)], 'GET /meta/v1/agents': [err(401)] })
    clerk.stillActive = true
    await page.start()
    expect(clerk.rechecks).toBe(1)
    expect(page.state()).toEqual({ kind: 'refused', status: 401 })
  })
})

describe('tokens', () => {
  it('every request gets its own token from Clerk, sent only as Authorization: Bearer', async () => {
    const clerk = new FakeClerk()
    const { page, vibase } = run(clerk, { 'GET /meta/v1/me': [ok(OWNER)], 'GET /meta/v1/agents': [ok({ data: [agent(10)], next_cursor: ID(10) }), ok({ data: [], next_cursor: null })], ['PATCH /meta/v1/agents/' + ID(10)]: [ok(agent(10, { disabled_at: 'd' }))] })
    await page.start()
    await page.setDisabled(ID(10), true)
    expect(clerk.tokens).toBe(4)
    expect(vibase.seen).toHaveLength(4)
    // the afterEach holds the rest: distinct tokens, none in a URL, bearer only, no storage
  })

  it('no token (Clerk returns null) means no request: signed out', async () => {
    const clerk = new FakeClerk(true, true)
    const { page, vibase } = run(clerk, { 'GET /meta/v1/me': [ok(OWNER)] })
    clerk.signedIn = true
    clerk.getToken = async () => null
    await page.start()
    expect(vibase.seen).toEqual([])
    expect(page.state().kind).toBe('signed-out')
    current = undefined
  })
})

describe('agents.update', () => {
  it('Disable PATCHes {disabled:true}, and the row becomes the answer; Enable sends {disabled:false}', async () => {
    const { page, vibase } = run(new FakeClerk(), {
      'GET /meta/v1/me': [ok(OWNER)],
      'GET /meta/v1/agents': [ok({ data: [agent(10), agent(11)], next_cursor: null })],
      ['PATCH /meta/v1/agents/' + ID(10)]: [ok(agent(10, { disabled_at: '2026-11-03T12:00:00.000Z' })), ok(agent(10))],
    })
    await page.start()
    await page.setDisabled(ID(10), true)
    let s = page.state()
    expect(s.kind === 'signed-in' && s.agents?.map((a) => a.disabled_at)).toEqual(['2026-11-03T12:00:00.000Z', null])
    await page.setDisabled(ID(10), false)
    s = page.state()
    expect(s.kind === 'signed-in' && s.agents?.map((a) => a.disabled_at)).toEqual([null, null])
    const patches = vibase.calls(`PATCH /meta/v1/agents/${ID(10)}`)
    expect(patches.map((p) => JSON.parse(p.body!))).toEqual([{ disabled: true }, { disabled: false }])
    expect(patches[0]!.headers['content-type']).toBe('application/json')
  })

  it('a refusal (403) leaves the list as it was and shows an error', async () => {
    const { page } = run(new FakeClerk(), {
      'GET /meta/v1/me': [ok(OWNER)],
      'GET /meta/v1/agents': [ok({ data: [agent(10)], next_cursor: null })],
      ['PATCH /meta/v1/agents/' + ID(10)]: [err(403)],
    })
    await page.start()
    await page.setDisabled(ID(10), true)
    const s = page.state()
    expect(s.kind).toBe('signed-in')
    expect(s.kind === 'signed-in' && s.agents?.[0]!.disabled_at).toBeNull()
    expect(s.kind === 'signed-in' && s.error).toMatch(/403/)
  })

  it('a network failure is an error line, not a crash', async () => {
    const clerk = new FakeClerk()
    const vibase = fakeVibase({ 'GET /meta/v1/me': [ok(OWNER)], 'GET /meta/v1/agents': [ok({ data: [agent(10)], next_cursor: null })] })
    current = { clerk, vibase }
    let down = false
    const flaky = ((i: RequestInfo | URL, init?: RequestInit) => (down ? Promise.reject(new TypeError('network')) : vibase.fetchFn(i, init))) as typeof fetch
    const page = createPage({ clerk, api: createApi({ origin: ORIGIN, getToken: () => clerk.getToken(), fetch: flaky }), discovery: DISCOVERY, origin: ORIGIN })
    await page.start()
    down = true
    await page.setDisabled(ID(10), true)
    const s = page.state()
    expect(s.kind === 'signed-in' && s.error).toBeTruthy()
    current = undefined
  })
})

describe('sign out', () => {
  it('calls Clerk and ends signed out', async () => {
    const clerk = new FakeClerk()
    const { page } = run(clerk, { 'GET /meta/v1/me': [ok(OWNER)], 'GET /meta/v1/agents': [ok({ data: [], next_cursor: null })] })
    await page.start()
    await page.signOut()
    expect(clerk.signOuts).toBe(1)
    expect(page.state().kind).toBe('signed-out')
  })
})
