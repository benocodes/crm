// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import axe from 'axe-core'
import { App } from './app.js'
import type { AppState } from './state.js'

// [[UI460]] D4, D7, D8, D10 (groups 3, 4, 5), P5: the app's views for each state, on real React in the `page-ui` project. The shell renders in `ready` only.
afterEach(cleanup)

const READY: AppState = {
  kind: 'ready',
  who: { name: 'Ann', email: 'ann@x.test', role: 'owner', workspaceName: 'Acme' },
  scopes: [],
  manageAccountHref: null,
}
const handlers = () => ({ onSignIn: vi.fn(), onSignOut: vi.fn(), onRetry: vi.fn() })
const show = (state: AppState, over: { provider?: string | null; path?: string } = {}) => {
  const h = handlers()
  render(<App state={state} provider={over.provider ?? 'better-auth'} path={over.path ?? '/home'} {...h} />)
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
    expect(home.getAttribute('href')).toBe('/home')
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

  it('has no Get started section and no Connect prompt (those are UI461 and UI458)', () => {
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
