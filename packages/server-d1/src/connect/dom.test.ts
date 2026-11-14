// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render } from './dom.js'
import { buildView } from './view-model.js'
import type { AgentRecord, Me, PageState } from './types.js'

// [[UI30]] D10: values from the API are text, never markup. The DOM layer is the only place that touches the document.

const ORIGIN = 'https://api.acme.example'
const ID = (n: number) => `0190b2c4-0000-7000-8000-${String(n).padStart(12, '0')}`
const EVIL = '<img src=x onerror=alert(1)>'
const me = (name: string | null = 'o@x.test'): Me => ({
  principal: { id: ID(1), kind: 'user' },
  user: { id: ID(1), email: name ?? 'o@x.test', name, email_verified: true },
  agent: null,
  client_id: null,
  memberships: [],
  active_organization: { id: ID(9), role: 'owner', scopes: ['agents:read', 'agents:write', EVIL] },
})
const agent = (over: Partial<AgentRecord> = {}): AgentRecord => ({ id: ID(10), name: 'a', scopes: [], disabled_at: null, created_at: 'c', auth_subject: null, auth_client_id: null, delegated_by: null, ...over })
const noop = { signIn: vi.fn(), signOut: vi.fn(), toggle: vi.fn() }
let root: HTMLElement
beforeEach(() => {
  document.body.innerHTML = '<div id="app"></div>'
  root = document.getElementById('app')!
  vi.clearAllMocks()
})
const show = (state: PageState, extra: { mcpUrl?: string | null; profileUrl?: string | null } = {}) => render(root, buildView(state, { origin: ORIGIN, ...extra }), noop)

describe('the Clerk-only profile link (UI297 R5)', () => {
  it('renders from an https profile URL, and not at all without one', () => {
    show({ kind: 'signed-in', me: me(), agents: [] }, { profileUrl: 'https://accounts.example/user' })
    expect(root.querySelector('a[href="https://accounts.example/user"]')?.textContent).toBe('Your Clerk profile')
    show({ kind: 'signed-in', me: me(), agents: [] }, { profileUrl: null })
    expect(root.textContent).not.toMatch(/clerk/i)
  })
})

describe('text only (D10)', () => {
  it('an agent name, a scope, an error and a user email shaped like markup render as text: no element is created from them', () => {
    show({ kind: 'signed-in', me: me(EVIL), agents: [agent({ name: EVIL, scopes: [EVIL], auth_subject: EVIL, delegated_by: EVIL, auth_client_id: 'c' })], error: EVIL })
    expect(root.querySelectorAll('img').length).toBe(0)
    expect(root.querySelectorAll('[onerror]').length).toBe(0)
    expect(root.textContent).toContain(EVIL)
    // the literal text appears in every place it was supplied: name, scope, kind label, error line, who
    expect(root.textContent!.split(EVIL).length - 1).toBeGreaterThanOrEqual(5)
  })

  it('a link built from API data is not made: the profile link only takes an https URL', () => {
    show({ kind: 'signed-in', me: me(), agents: [] }, { profileUrl: 'javascript:alert(1)' })
    expect([...root.querySelectorAll('a')].some((a) => a.getAttribute('href')?.startsWith('javascript:'))).toBe(false)
    show({ kind: 'signed-in', me: me(), agents: [] }, { profileUrl: 'https://accounts.example/user' })
    expect([...root.querySelectorAll('a')].map((a) => a.getAttribute('href'))).toContain('https://accounts.example/user')
  })
})

describe('render', () => {
  it('replaces the previous view each time', () => {
    show({ kind: 'signed-out' })
    show({ kind: 'signed-out' })
    expect(root.querySelectorAll('[data-action="sign-in"]').length).toBe(1)
  })

  it('signed out: one Sign in button that calls the handler, no sign-up anywhere', () => {
    show({ kind: 'signed-out' })
    const b = root.querySelector<HTMLButtonElement>('[data-action="sign-in"]')!
    b.click()
    expect(noop.signIn).toHaveBeenCalledOnce()
    expect(root.textContent).not.toMatch(/sign.?up/i)
  })

  it('owner: Disable and Enable buttons call the handler with the agent id and the new state; sign out calls its handler', () => {
    show({ kind: 'signed-in', me: me(), agents: [agent({ id: ID(10) }), agent({ id: ID(11), disabled_at: 'D' })] })
    const buttons = [...root.querySelectorAll<HTMLButtonElement>('[data-action="toggle-agent"]')]
    expect(buttons.map((b) => b.textContent)).toEqual(['Disable', 'Enable'])
    buttons[0]!.click()
    buttons[1]!.click()
    expect(noop.toggle.mock.calls).toEqual([[ID(10), true], [ID(11), false]])
    root.querySelector<HTMLButtonElement>('[data-action="sign-out"]')!.click()
    expect(noop.signOut).toHaveBeenCalledOnce()
  })

  it('member: no toggle buttons', () => {
    const m = me()
    m.active_organization!.scopes = ['agents:read']
    show({ kind: 'signed-in', me: m, agents: [agent()] })
    expect(root.querySelectorAll('[data-action="toggle-agent"]').length).toBe(0)
    expect(root.textContent).toContain('a')
  })

  it('shows the CLI command, the API-key command, the MCP URL when given, and the grant command for an agent without scopes', () => {
    show({ kind: 'signed-in', me: me(), agents: [agent({ id: ID(10) })] }, { mcpUrl: `${ORIGIN}/mcp` })
    const text = root.textContent!
    expect(text).toContain(`vibase login --server ${ORIGIN}`)
    expect(text).toContain('--api-key')
    expect(text).toContain(`${ORIGIN}/mcp`)
    expect(text).toContain(`vibase agents update ${ID(10)} --scopes`)
  })

  it('omits the MCP section without a URL', () => {
    show({ kind: 'signed-in', me: me(), agents: [] })
    expect(root.querySelector('[data-section="mcp"]')).toBeNull()
  })

  it('unavailable: the message and the API-key directions, no button at all', () => {
    show({ kind: 'unavailable' })
    expect(root.textContent).toMatch(/not configured/i)
    expect(root.querySelectorAll('button').length).toBe(0)
  })
})
