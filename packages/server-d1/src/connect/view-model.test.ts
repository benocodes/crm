import { describe, expect, it } from 'vitest'
import { buildView } from './view-model.js'
import type { AgentRecord, Me, PageState } from './types.js'

// [[UI30]] D4, D8, D11, D12, D13: given the session and the API answers, what the page shows.

const ORIGIN = 'https://api.acme.example'
const ID = (n: number) => `0190b2c4-0000-7000-8000-${String(n).padStart(12, '0')}`
const OWNER_SCOPES = ['agents:read', 'agents:write', 'contacts:read']

const user = (role: 'owner' | 'member', scopes: string[], email = 'owner@acme.example'): Me => ({
  principal: { id: ID(1), kind: 'user' },
  user: { id: ID(1), email, name: null, email_verified: true },
  agent: null,
  client_id: null,
  memberships: [{ organization_id: ID(9), organization_name: 'Acme', role }],
  active_organization: { id: ID(9), role, scopes },
})
const agentMe = (name = 'g-agent'): Me => ({
  principal: { id: ID(2), kind: 'agent' },
  user: null,
  agent: { id: ID(2), name, delegated_by: null, auth_client_id: null, auth_subject: 'user_g' },
  client_id: null,
  memberships: [],
  active_organization: { id: ID(9), role: null, scopes: [] },
})
const rec = (over: Partial<AgentRecord>): AgentRecord => ({ id: ID(10), name: 'bot', scopes: ['contacts:read'], disabled_at: null, created_at: '2026-11-03T10:00:00.000Z', auth_subject: null, auth_client_id: null, delegated_by: null, ...over })
const signedIn = (me: Me, agents: AgentRecord[] | null, error?: string): PageState => ({ kind: 'signed-in', me, agents, ...(error ? { error } : {}) })
const view = (state: PageState, extra: { mcpUrl?: string | null; profileUrl?: string | null } = {}) => buildView(state, { origin: ORIGIN, ...extra })

describe('states without a session', () => {
  it('loading: a message, nothing else, no sign-in button', () => {
    const v = view({ kind: 'loading' })
    expect(v).toMatchObject({ state: 'loading', showSignIn: false, who: null, connect: null, agents: null, account: null })
    expect(v.message).toBeTruthy()
  })

  it('sign-in unavailable: says so, shows the API-key directions and no device command, no sign-in button', () => {
    const v = view({ kind: 'unavailable' })
    expect(v.state).toBe('unavailable')
    expect(v.message).toMatch(/not configured/i)
    expect(v.message).toMatch(/API keys/)
    expect(v.showSignIn).toBe(false)
    expect(v.connect?.cli).toBeNull()
    expect(v.connect?.apiKey.command).toBe(`printf %s "$VIBASE_API_KEY" | vibase login --api-key --server ${ORIGIN}`)
    expect(v.who).toBeNull()
    expect(v.agents).toBeNull()
  })

  it('signed out: a sign-in button and no sign-up, no who, no list', () => {
    const v = view({ kind: 'signed-out' })
    expect(v.showSignIn).toBe(true)
    expect(JSON.stringify(v)).not.toMatch(/sign.?up/i)
    expect(v).toMatchObject({ who: null, agents: null, account: null })
  })

  it.each([401, 403])('refused %i: says the server did not admit the session, offers sign out and no data', (status) => {
    const v = view({ kind: 'refused', status })
    expect(v.state).toBe('refused')
    expect(v.message).toContain(String(status))
    expect(v.who).toBeNull()
    expect(v.agents).toBeNull()
    expect(v.account).not.toBeNull()
  })
})

describe('signed in', () => {
  it('owner: who, the CLI command, the API-key fallback, the list with Disable and Enable, the account section', () => {
    const v = view(signedIn(user('owner', OWNER_SCOPES), [rec({ id: ID(10) }), rec({ id: ID(11), disabled_at: '2026-11-03T11:00:00.000Z' })]), { profileUrl: 'https://accounts.example/user' })
    expect(v.who).toEqual({ name: 'owner@acme.example', role: 'owner', scopes: OWNER_SCOPES })
    expect(v.connect?.cli?.command).toBe(`vibase login --server ${ORIGIN}`)
    expect(v.connect?.cli?.steps).toMatch(/link/i)
    expect(v.connect?.apiKey.note).toContain('vibase api-keys create')
    expect(v.agents?.canToggle).toBe(true)
    expect(v.agents?.rows.map((r) => r.action)).toEqual(['disable', 'enable'])
    expect(v.agents?.rows[1]!.disabledAt).toBe('2026-11-03T11:00:00.000Z')
    expect(v.agents?.note).toMatch(/consent screen/)
    expect(v.agents?.personalLoginNote).toMatch(/vibase logout/)
    expect(v.account).toEqual({ profileUrl: 'https://accounts.example/user' })
    expect(v.showSignIn).toBe(false)
  })

  it('member: the list, no buttons', () => {
    const v = view(signedIn(user('member', ['agents:read', 'contacts:read'], 'm@acme.example'), [rec({})]))
    expect(v.who?.role).toBe('member')
    expect(v.agents?.rows).toHaveLength(1)
    expect(v.agents?.canToggle).toBe(false)
    expect(v.agents?.rows.every((r) => r.action === null)).toBe(true)
  })

  it('agent role: who and the connect instructions, no list', () => {
    const v = view(signedIn(agentMe(), null))
    expect(v.who).toEqual({ name: 'g-agent', role: 'agent', scopes: [] })
    expect(v.connect?.cli).not.toBeNull()
    expect(v.agents).toBeNull()
  })

  it('a person\'s own role comes from the active organisation; no role at all reads as "none"', () => {
    const me = user('owner', OWNER_SCOPES)
    me.active_organization = null
    expect(view(signedIn(me, null)).who?.role).toBe('none')
  })

  it('an error from the last action is shown beside the data', () => {
    expect(view(signedIn(user('owner', OWNER_SCOPES), [], 'could not disable')).error).toBe('could not disable')
    expect(view(signedIn(user('owner', OWNER_SCOPES), [])).error).toBeNull()
  })
})

describe('D13 the MCP section', () => {
  it('is hidden while discovery has no mcp, and shows the URL from discovery when present', () => {
    expect(view(signedIn(user('owner', OWNER_SCOPES), [])).connect?.mcp).toBeNull()
    expect(view(signedIn(user('owner', OWNER_SCOPES), []), { mcpUrl: `${ORIGIN}/mcp` }).connect?.mcp).toEqual({ url: `${ORIGIN}/mcp` })
    expect(view(signedIn(user('owner', OWNER_SCOPES), []), { mcpUrl: '' }).connect?.mcp).toBeNull()
  })
  it('is not offered when sign-in is unavailable (no OAuth to run)', () => {
    expect(view({ kind: 'unavailable' }, { mcpUrl: `${ORIGIN}/mcp` }).connect?.mcp).toBeNull()
  })
})

describe('D11 agent rows', () => {
  const rows = (agents: AgentRecord[], me = user('owner', OWNER_SCOPES)) => view(signedIn(me, agents)).agents!.rows

  it('a delegated agent (delegated_by and auth_client_id): "delegated by you (<email>)" for the viewer, the id for anyone else', () => {
    const [mine, other] = rows([rec({ delegated_by: ID(1), auth_client_id: 'client_1' }), rec({ id: ID(12), delegated_by: ID(5), auth_client_id: 'client_2' })])
    expect(mine).toMatchObject({ kind: 'delegated', kindLabel: 'delegated by you (owner@acme.example)' })
    expect(other).toMatchObject({ kind: 'delegated', kindLabel: `delegated by ${ID(5)}` })
  })
  it('an agent account has auth_subject and no delegate: "agent account"', () => {
    expect(rows([rec({ auth_subject: 'user_g' })])[0]).toMatchObject({ kind: 'agent-account', kindLabel: 'agent account' })
  })
  it('no provider link at all: "API-key agent"', () => {
    expect(rows([rec({})])[0]).toMatchObject({ kind: 'api-key', kindLabel: 'API-key agent' })
  })
  it('delegation wins over auth_subject when a record carries both', () => {
    expect(rows([rec({ auth_subject: 'user_g', delegated_by: ID(5), auth_client_id: 'c' })])[0]!.kind).toBe('delegated')
  })
  it('an agent with no scopes gets the exact grant command (owner); one with scopes, a viewer who cannot write, and none else', () => {
    const [none, some] = rows([rec({ id: ID(20), scopes: [], auth_subject: 'user_g' }), rec({ id: ID(21), scopes: ['contacts:read'] })])
    expect(none!.grantCommand).toBe(`vibase agents update ${ID(20)} --scopes '["contacts:read","contacts:write"]'`)
    expect(some!.grantCommand).toBeNull()
    expect(rows([rec({ id: ID(20), scopes: [] })], user('member', ['agents:read']))[0]!.grantCommand).toBeNull()
  })
  it('carries scopes, created and disabled times as the record has them', () => {
    expect(rows([rec({ scopes: ['a:read', 'b:read'], created_at: 'C', disabled_at: 'D' })])[0]).toMatchObject({ scopes: ['a:read', 'b:read'], createdAt: 'C', disabledAt: 'D', action: 'enable' })
  })
})
