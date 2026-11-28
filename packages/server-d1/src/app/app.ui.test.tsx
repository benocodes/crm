// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import axe from 'axe-core'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { MemoryRouter } from 'react-router'
import { App } from './app.js'
import { AGENTS_UNREADABLE, type AppState } from './state.js'

// [[UI460]] D4, D7, D8, D10 (groups 3, 4, 5), P5: the app's views for each state, on real React in the `page-ui` project. The shell renders in `ready` only.
afterEach(cleanup)

const READY: AppState = {
  kind: 'ready',
  who: { name: 'Ann', email: 'ann@x.test', role: 'owner', workspaceName: 'Acme', userId: 'u1' },
  scopes: [],
  manageAccountHref: null,
  connectAgent: { status: 'hidden' },
  connectEmail: { status: 'hidden' },
}
const SHOW: AppState = { ...READY, connectAgent: { status: 'show' } } as AppState
const NO_API = { connections: vi.fn(), identityAddress: vi.fn(), authorizeGmail: vi.fn() } as never
const handlers = () => ({ onSignIn: vi.fn(), onSignOut: vi.fn(), onRetry: vi.fn(), onCheckAgain: vi.fn() })
const show = (
  state: AppState,
  over: { provider?: string | null; path?: string; mcpUrl?: string | null; origin?: string } = {},
) => {
  const h = handlers()
  render(
    <MemoryRouter initialEntries={[over.path ?? '/app/home']}>
      <App
        state={state}
        provider={over.provider === undefined ? 'better-auth' : over.provider}
        origin={over.origin ?? 'https://w.test'}
        mcpUrl={over.mcpUrl === undefined ? null : over.mcpUrl}
        api={NO_API}
        {...h}
      />
    </MemoryRouter>,
  )
  return h
}
const noShell = () => {
  expect(screen.queryByRole('navigation')).toBeNull()
  expect(document.querySelector('aside')).toBeNull()
}

describe('ready: the shell and Home (D7, D8, P5)', () => {
  it('renders the shell with Home aria-current, the one h1 "Welcome to your CRM" and Who you are', () => {
    show(READY)
    const nav = screen.getByRole('navigation', { name: 'Workspace' })
    const home = within(nav).getByRole('link', { name: 'Home' })
    expect(home.getAttribute('href')).toBe('/app/home')
    expect(home.getAttribute('aria-current')).toBe('page')
    expect(
      within(nav)
        .getAllByRole('link')
        .filter((l) => l.getAttribute('aria-current')),
    ).toHaveLength(1)
    const h1 = screen.getAllByRole('heading', { level: 1 })
    expect(h1.map((h) => h.textContent)).toEqual(['Welcome to your CRM'])
    const who = screen.getByRole('region', { name: 'Who you are' })
    const dl = who.querySelector('dl')!
    const text = (term: string) =>
      [...dl.querySelectorAll('dt')].find((t) => t.textContent === term)?.nextElementSibling?.textContent
    expect(text('Name')).toBe('Ann')
    expect(text('Email')).toBe('ann@x.test')
    expect(text('Role')).toBe('owner')
    expect(text('Workspace')).toBe('Acme')
    expect(screen.getByText('Acme', { selector: 'aside span' })).toBeTruthy() // the shell names the workspace too
  })

  it('with an enabled agent connected there is no Get started section and no Connect prompt', () => {
    show(READY)
    expect(screen.queryByText(/get started/i)).toBeNull()
    expect(screen.queryByText(/connect an agent/i)).toBeNull()
  })

  it('Manage account only when the SDK gave a profile URL', () => {
    show({ ...READY, manageAccountHref: 'https://acc.test/user' } as AppState, { provider: 'clerk' })
    expect(screen.getByRole('link', { name: 'Manage account' }).getAttribute('href')).toBe('https://acc.test/user')
    cleanup()
    show(READY)
    expect(screen.queryByRole('link', { name: 'Manage account' })).toBeNull()
  })

  it('Sign out is a button that calls the handler', async () => {
    const h = show(READY)
    await userEvent.setup().click(screen.getByRole('button', { name: 'Sign out' }))
    expect(h.onSignOut).toHaveBeenCalledTimes(1)
  })

  it('a refused sign-out shows its error in the page', () => {
    show({ ...READY, signOutError: 'Sign-out did not complete. Reload the page and try again.' } as AppState)
    expect(screen.getByRole('alert').textContent).toContain('Sign-out did not complete')
    expect(screen.getByRole('navigation', { name: 'Workspace' })).toBeTruthy()
  })

  it('values holding markup are text: no element is created', () => {
    show({
      ...READY,
      who: { name: '<img src=x onerror=1>', email: '<b>e</b>@x.test', role: 'owner', workspaceName: '<i>W</i>' },
    } as AppState)
    expect(document.querySelector('main img, main b, main i')).toBeNull()
  })

  it('axe is clean', async () => {
    show(READY)
    const r = await axe.run(document.body, { rules: { 'color-contrast': { enabled: false } } })
    expect(r.violations.map((v) => v.id)).toEqual([])
  })
})

describe('ready on /accounts (UI467 D1)', () => {
  it('draws the Connected accounts page, not Home, with its nav entry current and Home not', () => {
    show({ ...READY, scopes: ['connections:read'] }, { path: '/app/accounts' })
    expect(screen.getAllByRole('heading', { level: 1 }).map((h) => h.textContent)).toEqual(['Connected accounts'])
    const nav = screen.getByRole('navigation', { name: 'Workspace' })
    expect(within(nav).getByRole('link', { name: 'Connected accounts' }).getAttribute('aria-current')).toBe('page')
    expect(within(nav).getByRole('link', { name: 'Home' }).getAttribute('aria-current')).toBeNull()
  })
  it('the nav row is absent without connections:read', () => {
    show(READY)
    expect(screen.queryByRole('link', { name: 'Connected accounts' })).toBeNull()
  })
})

describe('ready on /agents (UI459 D1, D2, D8)', () => {
  const API = { agents: vi.fn(async () => ({ status: 200, body: [] })), forms: vi.fn(), setDisabled: vi.fn() }
  const showAgents = (scopes: string[]) => {
    const h = handlers()
    render(
      <MemoryRouter initialEntries={['/app/agents']}>
        <App
          state={{ ...READY, scopes }}
          provider="better-auth"
          origin="https://w.test"
          mcpUrl={null}
          api={{ ...(NO_API as object), ...API } as never}
          {...h}
        />
      </MemoryRouter>,
    )
  }
  it('draws the Agents page, not Home, with its nav entry current; Connect an agent is always on it', async () => {
    showAgents(['agents:read'])
    expect(screen.getAllByRole('heading', { level: 1 }).map((h) => h.textContent)).toEqual(['Agents'])
    const nav = screen.getByRole('navigation', { name: 'Workspace' })
    expect(within(nav).getByRole('link', { name: 'Agents' }).getAttribute('aria-current')).toBe('page')
    expect(within(nav).getByRole('link', { name: 'Home' }).getAttribute('aria-current')).toBeNull()
    expect(await screen.findByText('vibase login --server https://w.test')).toBeTruthy()
  })
  it('the nav row is absent without agents:read, and the page says so', () => {
    showAgents([])
    expect(screen.queryByRole('link', { name: 'Agents' })).toBeNull()
    expect(screen.getByText("You don't have access to the agents list.")).toBeTruthy()
  })
})

describe('the states without a shell (D4)', () => {
  it('signed-out: one Sign in button, a heading, no sidebar; the button calls the handler', async () => {
    const h = show({ kind: 'signed-out' })
    noShell()
    expect(screen.getAllByRole('button')).toHaveLength(1)
    await userEvent.setup().click(screen.getByRole('button', { name: 'Sign in' }))
    expect(h.onSignIn).toHaveBeenCalledTimes(1)
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1)
  })

  it('unavailable: says so, no shell and no Sign in', () => {
    show({ kind: 'unavailable' })
    noShell()
    expect(screen.getByText(/sign-in is unavailable/i)).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Sign in' })).toBeNull()
  })

  it('no-access: says so with Sign out, and no shell', async () => {
    const h = show({ kind: 'no-access' })
    noShell()
    expect(screen.getByText(/no access|not a member|do not have access/i)).toBeTruthy()
    await userEvent.setup().click(screen.getByRole('button', { name: 'Sign out' }))
    expect(h.onSignOut).toHaveBeenCalledTimes(1)
  })

  it('no-access tells an agent to use the MCP, the CLI or the SDK instead (UI479, 479.12)', () => {
    show({ kind: 'no-access' })
    expect(screen.getByText(/agents?.*MCP.*CLI.*SDK/i)).toBeTruthy()
  })

  it('no-access for an agent says the account is ready, keeps the MCP/SDK pointer, and never "ask an owner" (CORE697, AGT707)', async () => {
    const h = show({ kind: 'no-access', agent: true })
    noShell()
    expect(screen.getByRole('heading', { name: 'Your agent account is ready' })).toBeTruthy()
    expect(screen.getByText(/vibase login/)).toBeTruthy()
    expect(screen.getByText(/MCP.*SDK/)).toBeTruthy()
    expect(screen.queryByText(/ask an owner/i)).toBeNull()
    expect(screen.queryByText(/no access/i)).toBeNull()
    await userEvent.setup().click(screen.getByRole('button', { name: 'Sign out' }))
    expect(h.onSignOut).toHaveBeenCalledTimes(1)
  })

  it('the agent card shows the login command for this instance and Copy writes exactly it (AGT707 D1, D2)', async () => {
    const writeText = vi.fn(async () => {})
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    show({ kind: 'no-access', agent: true }, { origin: 'https://agents.example.test' })
    expect(screen.getByText('vibase login --server https://agents.example.test')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Copy login command' })) // userEvent replaces navigator.clipboard with its own stub
    expect(writeText).toHaveBeenCalledWith('vibase login --server https://agents.example.test')
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe('Copied'))
  })

  it('the agent card speaks to both readers, in order, and is accessible (AGT707 D1)', async () => {
    show({ kind: 'no-access', agent: true })
    const text = document.body.textContent ?? ''
    const at = [
      /New here\?/,
      /vibase login --server https:\/\/w\.test/,
      /--profile/,
      /Already signed in through the CLI/,
      /MCP or the SDK/,
    ].map((re) => text.search(re))
    expect(at.every((i) => i >= 0)).toBe(true)
    expect([...at].sort((a, b) => a - b)).toEqual(at)
    expect(screen.getByText(/approve the sign-in/i)).toBeTruthy()
    expect(screen.getByText(/nothing to do here/i)).toBeTruthy()
    const r = await axe.run(document.body, { rules: { 'color-contrast': { enabled: false } } })
    expect(r.violations.map((v) => v.id)).toEqual([])
  })

  it("the person's no-access card has no command block and no Copy button (AGT707)", () => {
    for (const state of [{ kind: 'no-access' }, { kind: 'no-access', who: 'ann@x.test' }] as AppState[]) {
      show(state)
      expect(screen.queryByRole('button', { name: /copy/i })).toBeNull()
      expect(screen.queryByText(/vibase login/)).toBeNull()
      expect(screen.getByText(/has not given your account a role/)).toBeTruthy()
      cleanup()
    }
  })

  it('no-access with who: the card shows the signed-in person, and a refused sign-out error', async () => {
    show({
      kind: 'no-access',
      who: 'ann@x.test',
      signOutError: 'Sign-out did not complete. Reload the page and try again.',
    })
    noShell()
    expect(screen.getByText(/ann@x\.test/)).toBeTruthy()
    expect(screen.getByRole('alert').textContent).toContain('Sign-out did not complete')
    const r = await axe.run(document.body, { rules: { 'color-contrast': { enabled: false } } })
    expect(r.violations.map((v) => v.id)).toEqual([])
  })

  it('error: the message and a Retry button that calls the handler, no shell', async () => {
    const h = show({ kind: 'error', message: 'The workspace could not be read (500).' })
    noShell()
    expect(screen.getByRole('alert').textContent).toContain('could not be read (500)')
    await userEvent.setup().click(screen.getByRole('button', { name: 'Retry' }))
    expect(h.onRetry).toHaveBeenCalledTimes(1)
  })

  it('loading: a status line and no shell', () => {
    show({ kind: 'loading' })
    noShell()
    expect(screen.getByRole('status').textContent).toMatch(/loading/i)
  })

  it.each([
    ['signed-out', { kind: 'signed-out' }],
    ['unavailable', { kind: 'unavailable' }],
    ['no-access', { kind: 'no-access' }],
    ['error', { kind: 'error', message: 'x' }],
    ['loading', { kind: 'loading' }],
  ] as [string, AppState][])('axe is clean in %s', async (_n, state) => {
    show(state)
    const r = await axe.run(document.body, { rules: { 'color-contrast': { enabled: false } } })
    expect(r.violations.map((v) => v.id)).toEqual([])
  })
})

// [[UI461]] D9, D10, D11 (group 5): Home with the Connect an agent prompt.
describe('Home: Get started (D9, D10)', () => {
  it('Get started comes before Who you are, with Connect an agent holding the instructions and Check again', async () => {
    const h = show(SHOW, { mcpUrl: 'https://w.test/mcp' })
    const regions = screen
      .getAllByRole('region')
      .map((r) => r.getAttribute('aria-label') ?? r.querySelector('h2,h3')?.textContent)
    expect(regions.indexOf('Get started')).toBeGreaterThanOrEqual(0)
    expect(regions.indexOf('Get started')).toBeLessThan(regions.indexOf('Who you are'))
    const prompt = screen.getByRole('region', { name: 'Connect an agent' })
    expect([...prompt.querySelectorAll('pre code')].map((c) => c.textContent)).toContain(
      'vibase login --server https://w.test',
    )
    expect([...prompt.querySelectorAll('pre code')].map((c) => c.textContent)).toContain('https://w.test/mcp')
    await userEvent.setup().click(screen.getByRole('button', { name: 'Check again' }))
    expect(h.onCheckAgain).toHaveBeenCalledTimes(1)
  })

  it('no provider: no login command; the API-key line stays', () => {
    show(SHOW, { provider: null })
    expect(document.body.textContent).not.toContain('vibase login --server https')
    expect(screen.getByText(/VIBASE_API_KEY/)).toBeTruthy()
  })

  it('a failed read shows its one line in Get started and no prompt', () => {
    show({ ...READY, connectAgent: { status: 'error', message: 'The agents could not be read (500).' } } as AppState)
    expect(screen.getByRole('region', { name: 'Get started' })).toBeTruthy()
    expect(screen.getByRole('alert').textContent).toContain('could not be read (500)')
    expect(screen.queryByRole('region', { name: 'Connect an agent' })).toBeNull()
  })

  it('the real unreadable-agents message offers no Check again, and Home has no such button in the error state', () => {
    expect(AGENTS_UNREADABLE).not.toMatch(/check again/i)
    show({ ...READY, connectAgent: { status: 'error', message: AGENTS_UNREADABLE } } as AppState)
    expect(screen.getByRole('alert').textContent).toBe(AGENTS_UNREADABLE)
    expect(screen.queryByRole('button', { name: /check again/i })).toBeNull()
  })

  it('an owner and a member with the same lists see the same Home', () => {
    // Everything but the Role value is the same.
    const text = () => {
      const main = document.querySelector('main')!.cloneNode(true) as HTMLElement
      for (const dt of main.querySelectorAll('dt')) if (dt.textContent === 'Role') dt.nextElementSibling?.remove()
      return main.textContent
    }
    show(SHOW)
    const owner = text()
    cleanup()
    show({ ...SHOW, who: { ...(SHOW as { who: object }).who, role: 'member' } } as AppState)
    expect(text()).toBe(owner)
  })

  it.each(['light', 'dark'])('axe is clean with the prompt in the %s theme', async (theme) => {
    document.documentElement.classList.toggle('dark', theme === 'dark')
    show(SHOW, { mcpUrl: 'https://w.test/mcp' })
    const r = await axe.run(document.body, { rules: { 'color-contrast': { enabled: false } } })
    document.documentElement.classList.remove('dark')
    expect(r.violations.map((v) => v.id)).toEqual([])
  })

  it('Home imports no bare shadcn primitive: the shared composites only', () => {
    const src = readFileSync(join(process.cwd(), 'src/app/home.tsx'), 'utf8')
    expect(src).not.toMatch(/components\/ui\//)
    expect(src).toMatch(/PromptCard/)
  })
})

// [[UI469]] D13, P5 (group 4): Home's Connect your email prompt.
describe('Home: Connect your email (D13, P5)', () => {
  const EMAIL = { ...SHOW, connectEmail: { status: 'show' } } as AppState
  const EMAIL_ONLY = { ...READY, connectEmail: { status: 'show' } } as AppState
  const EMAIL_UNREADABLE = 'The mailbox list could not be read. Reload the page to try again.'

  it('the prompt comes before Connect an agent, with its text and a Connect Gmail link to /accounts', () => {
    show(EMAIL)
    const email = screen.getByRole('region', { name: 'Connect your email' })
    const agent = screen.getByRole('region', { name: 'Connect an agent' })
    expect(email.compareDocumentPosition(agent) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(email.textContent).toContain('Connect your Gmail so your conversations land in your CRM.')
    const link = within(email).getByRole('link', { name: 'Connect Gmail' })
    expect(link.getAttribute('href')).toBe('/app/accounts')
    expect(within(email).queryByRole('button')).toBeNull()
  })

  it('Home never calls connections.authorize, in any state', () => {
    const authorizeGmail = vi.fn()
    const handlersLocal = handlers()
    for (const state of [
      EMAIL,
      EMAIL_ONLY,
      READY,
      { ...EMAIL, connectEmail: { status: 'error', message: EMAIL_UNREADABLE } },
    ]) {
      render(
        <MemoryRouter initialEntries={['/app/home']}>
          <App
            state={state as AppState}
            provider="better-auth"
            origin="https://w.test"
            mcpUrl={null}
            api={{ connections: vi.fn(), identityAddress: vi.fn(), authorizeGmail } as never}
            {...handlersLocal}
          />
        </MemoryRouter>,
      )
      cleanup()
    }
    expect(authorizeGmail).not.toHaveBeenCalled()
  })

  it('a failed read shows its line in place of the prompt, and the agent prompt stays', () => {
    show({ ...EMAIL, connectEmail: { status: 'error', message: EMAIL_UNREADABLE } } as AppState)
    expect(screen.getByRole('alert').textContent).toBe(EMAIL_UNREADABLE)
    expect(screen.queryByRole('region', { name: 'Connect your email' })).toBeNull()
    expect(screen.getByRole('region', { name: 'Connect an agent' })).toBeTruthy()
  })

  it('Get started renders for the email prompt alone, and is absent when both checks are hidden', () => {
    show(EMAIL_ONLY)
    expect(screen.getByRole('region', { name: 'Get started' })).toBeTruthy()
    expect(screen.queryByRole('region', { name: 'Connect an agent' })).toBeNull()
    cleanup()
    show(READY)
    expect(screen.queryByRole('region', { name: 'Get started' })).toBeNull()
  })

  it.each([
    ['both prompts', EMAIL],
    [
      'an error beside a prompt',
      { ...EMAIL, connectEmail: { status: 'error', message: EMAIL_UNREADABLE } } as AppState,
    ],
  ] as [string, AppState][])('axe is clean with %s', async (_n, state) => {
    show(state, { mcpUrl: 'https://w.test/mcp' })
    const r = await axe.run(document.body, { rules: { 'color-contrast': { enabled: false } } })
    expect(r.violations.map((v) => v.id)).toEqual([])
  })
})
