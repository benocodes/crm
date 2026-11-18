// @vitest-environment happy-dom
import { cleanup, render, within } from '@testing-library/preact'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentRecord, Me } from '../app/session/types.js'
import type { PageState } from './types.js'
import { buildView } from './view-model.js'
import { ConnectView, drawView, type Handlers } from './view.js'

// [[UI30]] D10, [[UI256]]: the connect page's view layer on @vibase/ui. Values from the API are text, never markup; every hook the E2Es select on stays.

const ORIGIN = 'https://api.acme.example'
const ID = (n: number) => `0190b2c4-0000-7000-8000-${String(n).padStart(12, '0')}`
const EVIL = '<img src=x onerror=alert(1)>'
const me = (name: string | null = 'o@x.test', scopes = ['agents:read', 'agents:write']): Me => ({
  principal: { id: ID(1), kind: 'user' },
  user: { id: ID(1), email: name ?? 'o@x.test', name, email_verified: true },
  agent: null,
  client_id: null,
  memberships: [],
  active_organization: { id: ID(9), role: 'owner', scopes },
})
const agent = (over: Partial<AgentRecord> = {}): AgentRecord => ({
  id: ID(10),
  name: 'a',
  scopes: [],
  disabled_at: null,
  created_at: 'c',
  auth_subject: null,
  auth_client_id: null,
  delegated_by: null,
  ...over,
})
const handlers = () => ({
  signIn: vi.fn<() => void>(),
  signOut: vi.fn<() => void>(),
  toggle: vi.fn<(id: string, disabled: boolean) => void>(),
})
type Ctx = { mcpUrl?: string | null; profileUrl?: string | null }
const view = (state: PageState, ctx: Ctx = {}) => buildView(state, { origin: ORIGIN, ...ctx })
const show = (state: PageState, ctx: Ctx = {}, h: Handlers = handlers()) => {
  const r = render(<ConnectView vm={view(state, ctx)} handlers={h} />)
  return { ...r, h, vm: (s: PageState, c: Ctx = {}) => r.rerender(<ConnectView vm={view(s, c)} handlers={h} />) }
}
const sections = (c: Element) => [...c.querySelectorAll('[data-section]')].map((s) => s.getAttribute('data-section'))
const headings = (c: Element) => [...c.querySelectorAll('h1, h2, h3')].map((h) => h.textContent)
const buttons = (c: Element) => [...c.querySelectorAll('button')].map((b) => b.textContent)

beforeEach(() => vi.clearAllMocks())
afterEach(cleanup)

describe('every view state renders its content (matrix)', () => {
  it('loading: the title and the Loading line, nothing else', () => {
    const { container } = show({ kind: 'loading' })
    expect(headings(container)).toEqual(['Connect to this Vibase'])
    expect(container.textContent).toContain('Loading')
    expect(sections(container)).toEqual([])
    expect(buttons(container)).toEqual([])
  })

  it('signed out: the sign-in line and one Sign in button (data-action), no sign-up, no sections', () => {
    const { container } = show({ kind: 'signed-out' })
    expect(container.textContent).toContain('Sign in to see who you are')
    expect(buttons(container)).toEqual(['Sign in'])
    expect(container.querySelectorAll('[data-action="sign-in"]').length).toBe(1)
    expect(container.textContent).not.toMatch(/sign.?up/i)
    expect(sections(container)).toEqual([])
  })

  it('unavailable: the message and the API-key directions only, no button, no MCP and no CLI', () => {
    const { container } = show({ kind: 'unavailable' })
    expect(container.textContent).toMatch(/not configured/i)
    expect(buttons(container)).toEqual([])
    expect(sections(container)).toEqual(['connect'])
    expect(headings(container)).toEqual(['Connect to this Vibase', 'Connect an agent', 'API key'])
    expect(container.textContent).toContain(`--api-key --server ${ORIGIN}`)
  })

  it('refused: the status message and Sign out, with the profile link only when a URL is given', () => {
    const { container } = show({ kind: 'refused', status: 403 }, { profileUrl: 'https://accounts.example/user' })
    expect(container.textContent).toContain('did not accept your session (403)')
    expect(sections(container)).toEqual(['account'])
    expect(buttons(container)).toEqual(['Sign out'])
    expect(container.querySelector('a')?.getAttribute('href')).toBe('https://accounts.example/user')
  })

  it('signed-in owner: every section, the person and role, the CLI and API-key commands, the agents', () => {
    const { container } = show({ kind: 'signed-in', me: me(), agents: [agent({ id: ID(10), scopes: ['x:read'] })] })
    expect(sections(container)).toEqual(['who', 'connect', 'agents', 'account'])
    expect(headings(container)).toEqual([
      'Connect to this Vibase',
      'Who you are',
      'Connect an agent',
      'Command line',
      'API key',
      'Connected agents',
      'Account',
    ])
    const who = container.querySelector('[data-section="who"]')!
    expect(who.textContent).toContain('o@x.test (role: owner)')
    expect(who.textContent).toContain('Scopes: agents:read, agents:write')
    expect(container.textContent).toContain(`vibase login --server ${ORIGIN}`)
    expect(container.textContent).toContain('Scopes: x:read')
    expect(container.textContent).toContain('Created c')
    expect(buttons(container)).toEqual(['Disable', 'Sign out'])
  })

  it('member: agents listed, no Disable/Enable, no grant command', () => {
    const { container } = show({ kind: 'signed-in', me: me('m@x.test', ['agents:read']), agents: [agent()] })
    expect(container.querySelectorAll('[data-action="toggle-agent"]').length).toBe(0)
    expect(container.querySelector('li.agent')?.textContent).toContain('Scopes: none')
    expect(container.textContent).not.toContain('vibase agents update')
  })

  it('an agent without scopes shows the exact grant command; a disabled agent says so and offers Enable', () => {
    const { container } = show({
      kind: 'signed-in',
      me: me(),
      agents: [agent({ id: ID(10) }), agent({ id: ID(11), disabled_at: 'D', scopes: ['a:b'] })],
    })
    const rows = [...container.querySelectorAll<HTMLElement>('li.agent')]
    expect(rows.map((r) => r.getAttribute('data-agent'))).toEqual([ID(10), ID(11)])
    expect(rows[0]!.textContent).toContain(
      `vibase agents update ${ID(10)} --scopes '["contacts:read","contacts:write"]'`,
    )
    expect(rows[0]!.classList.contains('disabled')).toBe(false)
    expect(rows[1]!.classList.contains('disabled')).toBe(true)
    expect(rows[1]!.textContent).toContain('Created c; disabled D')
    expect(within(rows[1]!).getByRole('button').textContent).toBe('Enable')
  })

  it('no agents yet; and without agents:read the agents section is absent', () => {
    const a = show({ kind: 'signed-in', me: me(), agents: [] })
    expect(a.container.textContent).toContain('No agents yet.')
    expect(a.container.querySelector('ul')).toBeNull()
    cleanup()
    const b = show({ kind: 'signed-in', me: me('x@x.test', []), agents: null })
    expect(sections(b.container)).not.toContain('agents')
  })

  it('the MCP section shows with a URL and is absent without one', () => {
    const a = show({ kind: 'signed-in', me: me(), agents: [] }, { mcpUrl: `${ORIGIN}/mcp` })
    const mcp = a.container.querySelector('[data-section="mcp"]')!
    expect(mcp.textContent).toContain(`${ORIGIN}/mcp`)
    expect(mcp.querySelector('h2')?.textContent).toBe('MCP')
    cleanup()
    const b = show({ kind: 'signed-in', me: me(), agents: [] })
    expect(b.container.querySelector('[data-section="mcp"]')).toBeNull()
  })

  it('the Clerk profile link renders from an https profile URL, and nothing names Clerk without one (UI297 R5)', () => {
    const a = show({ kind: 'signed-in', me: me(), agents: [] }, { profileUrl: 'https://accounts.example/user' })
    const link = a.container.querySelector('a[href="https://accounts.example/user"]')!
    expect(link.textContent).toBe('Your Clerk profile')
    expect(link.getAttribute('rel')).toBe('noopener noreferrer')
    cleanup()
    const b = show({ kind: 'signed-in', me: me(), agents: [] })
    expect(b.container.textContent).not.toMatch(/clerk/i)
  })

  it('the error line shows for a signed-in state that carries one', () => {
    const { container } = show({ kind: 'signed-in', me: me(), agents: [], error: 'Could not disable.' })
    expect(container.textContent).toContain('Could not disable.')
  })
})

describe('the handlers stay wired', () => {
  it('Sign in, Sign out and each agent toggle call their handler with the agent id and the new state', () => {
    const si = show({ kind: 'signed-out' })
    si.container.querySelector<HTMLButtonElement>('[data-action="sign-in"]')!.click()
    expect(si.h.signIn).toHaveBeenCalledOnce()
    cleanup()
    const h = handlers()
    const { container } = show(
      { kind: 'signed-in', me: me(), agents: [agent({ id: ID(10) }), agent({ id: ID(11), disabled_at: 'D' })] },
      {},
      h,
    )
    const toggles = [...container.querySelectorAll<HTMLButtonElement>('[data-action="toggle-agent"]')]
    expect(toggles.map((b) => b.textContent)).toEqual(['Disable', 'Enable'])
    toggles[0]!.click()
    toggles[1]!.click()
    expect(h.toggle.mock.calls).toEqual([
      [ID(10), true],
      [ID(11), false],
    ])
    container.querySelector<HTMLButtonElement>('[data-action="sign-out"]')!.click()
    expect(h.signOut).toHaveBeenCalledOnce()
  })

  it('after a re-render with a changed agent list, each button still names its own row', () => {
    const h = handlers()
    const r = show(
      { kind: 'signed-in', me: me(), agents: [agent({ id: ID(10), name: 'one' }), agent({ id: ID(11), name: 'two' })] },
      {},
      h,
    )
    // the first agent is gone, a new one is first; the DOM nodes of row 1 and 2 are reused by position
    r.vm({
      kind: 'signed-in',
      me: me(),
      agents: [agent({ id: ID(12), name: 'three' }), agent({ id: ID(11), name: 'two', disabled_at: 'D' })],
    })
    const rows = [...r.container.querySelectorAll<HTMLElement>('li.agent')]
    expect(rows.map((x) => x.getAttribute('data-agent'))).toEqual([ID(12), ID(11)])
    within(rows[0]!).getByRole('button').click()
    within(rows[1]!).getByRole('button').click()
    expect(h.toggle.mock.calls).toEqual([
      [ID(12), true],
      [ID(11), false],
    ])
  })

  it('a new view replaces the previous one: no stale section or button is left', () => {
    const r = show({ kind: 'signed-in', me: me(), agents: [agent()] }, { mcpUrl: `${ORIGIN}/mcp` })
    expect(sections(r.container)).toContain('agents')
    r.vm({ kind: 'signed-out' })
    expect(sections(r.container)).toEqual([])
    expect(buttons(r.container)).toEqual(['Sign in'])
    expect(r.container.querySelectorAll('h1').length).toBe(1)
    r.vm({ kind: 'signed-out' })
    expect(r.container.querySelectorAll('[data-action="sign-in"]').length).toBe(1)
  })
})

describe('text, never markup (UI30 D10)', () => {
  it('an agent name, a scope, an error, a message and a user name shaped like markup render as text and create no element', () => {
    const { container } = show({
      kind: 'signed-in',
      me: me(EVIL),
      agents: [agent({ name: EVIL, scopes: [EVIL], auth_subject: EVIL, delegated_by: EVIL, auth_client_id: 'c' })],
      error: EVIL,
    })
    expect(container.querySelectorAll('img').length).toBe(0)
    expect(container.querySelectorAll('[onerror]').length).toBe(0)
    // name, scope, kind label, error line, who
    expect(container.textContent!.split(EVIL).length - 1).toBeGreaterThanOrEqual(5)
  })

  it('a message shaped like markup is text too', () => {
    const vm = { ...view({ kind: 'signed-out' }), message: EVIL }
    const { container } = render(<ConnectView vm={vm} handlers={handlers()} />)
    expect(container.querySelectorAll('img').length).toBe(0)
    expect(container.textContent).toContain(EVIL)
  })

  it('the profile link is made only for an https URL', () => {
    for (const bad of ['javascript:alert(1)', 'http://accounts.example/user', 'data:text/html,x', 'not a url', '']) {
      const { container } = show({ kind: 'signed-in', me: me(), agents: [] }, { profileUrl: bad })
      expect(container.querySelectorAll('a').length, bad).toBe(0)
      cleanup()
    }
    const { container } = show(
      { kind: 'signed-in', me: me(), agents: [] },
      { profileUrl: 'https://accounts.example/user' },
    )
    expect(container.querySelectorAll('a').length).toBe(1)
  })
})

describe('the page works under style-src self (UI256 P3)', () => {
  it('no state renders an element with a style attribute or a <style> element', () => {
    const states: [PageState, Ctx][] = [
      [{ kind: 'loading' }, {}],
      [{ kind: 'signed-out' }, {}],
      [{ kind: 'unavailable' }, {}],
      [{ kind: 'refused', status: 0 }, { profileUrl: 'https://accounts.example/user' }],
      [
        {
          kind: 'signed-in',
          me: me(),
          agents: [agent(), agent({ id: ID(11), disabled_at: 'D', scopes: ['a:b'] })],
          error: 'oops',
        },
        { mcpUrl: `${ORIGIN}/mcp`, profileUrl: 'https://accounts.example/user' },
      ],
    ]
    for (const [s, c] of states) {
      const { container } = show(s, c)
      expect(container.querySelectorAll('[style]').length, s.kind).toBe(0)
      expect(container.querySelectorAll('style').length, s.kind).toBe(0)
      cleanup()
    }
  })
})

describe('the first draw replaces the HTML placeholder', () => {
  it('no stray Loading text remains once a signed-in view has drawn, and a later draw still replaces the view', () => {
    document.body.innerHTML = '<main id="app" aria-live="polite"><p>Loading</p></main>'
    const root = document.getElementById('app')!
    const h = handlers()
    drawView(root, view({ kind: 'signed-in', me: me(), agents: [] }), h)
    expect(root.textContent).not.toContain('Loading')
    expect(root.querySelectorAll('[data-section="account"]').length).toBe(1)
    expect(root.lastElementChild?.getAttribute('data-section')).toBe('account')
    drawView(root, view({ kind: 'signed-out' }), h)
    expect(sections(root)).toEqual([])
    expect(root.querySelectorAll('h1').length).toBe(1)
  })
})
