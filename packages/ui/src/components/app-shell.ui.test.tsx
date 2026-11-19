// [[UI443]] cycle 1, group 2 (D8, D11): AppShell is a navigable shell.
import axe from 'axe-core'
import { Home, Users } from 'lucide-react'
import { describe, expect, it, vi } from 'vitest'
import { render, screen, userEvent } from '#render'
import { AppShell } from './app-shell'

const NAV = [
  { label: 'Home', href: '/home', icon: Home, current: true },
  { label: 'Agents', href: '/agents', icon: Users },
]
const shell = (extra: Record<string, unknown> = {}) => (
  <AppShell
    workspaceName="Acme CRM"
    nav={NAV}
    person={{ name: 'Ada Lovelace', email: 'ada@example.com' }}
    signOut={{ onClick: () => {} }}
    {...extra}
  >
    <h1>Page</h1>
  </AppShell>
)

describe('AppShell', () => {
  it('has a named nav landmark and a main landmark holding the page', () => {
    render(shell())
    expect(screen.getByRole('navigation', { name: 'Workspace' })).toBeTruthy()
    expect(screen.getByRole('main').textContent).toContain('Page')
  })

  it('renders each entry as a link to its href', () => {
    render(shell())
    const nav = screen.getByRole('navigation', { name: 'Workspace' })
    const links = Array.from(nav.querySelectorAll('a'))
    expect(links.map((a) => [a.textContent, a.getAttribute('href')])).toEqual([
      ['Home', '/home'],
      ['Agents', '/agents'],
    ])
  })

  it('exactly the current entry carries aria-current="page"', () => {
    render(shell())
    const current = Array.from(document.querySelectorAll('[aria-current]'))
    expect(current.map((e) => [e.textContent, e.getAttribute('aria-current')])).toEqual([['Home', 'page']])
  })

  it('the skip link is the first focusable element and moves focus to the main region', async () => {
    render(shell())
    const user = userEvent.setup()
    await user.tab()
    const skip = document.activeElement as HTMLElement
    expect(skip.tagName).toBe('A')
    expect(skip.textContent).toBe('Skip to main content')
    await user.keyboard('{Enter}')
    expect(document.activeElement).toBe(screen.getByRole('main'))
  })

  it('shows the product name, the workspace name and the person', () => {
    render(shell())
    expect(screen.getByText('Vibase')).toBeTruthy()
    expect(screen.getByText('Acme CRM')).toBeTruthy()
    expect(screen.getByText('Ada Lovelace')).toBeTruthy()
    expect(screen.getByText('ada@example.com')).toBeTruthy()
  })

  it('Sign out is a reachable button that reports through its handler', async () => {
    const onClick = vi.fn()
    render(shell({ signOut: { onClick } }))
    await userEvent.setup().click(screen.getByRole('button', { name: 'Sign out' }))
    expect(onClick).toHaveBeenCalledTimes(1)
  })

  it('Sign out is a link when given an href', () => {
    render(shell({ signOut: { href: '/sign-out' } }))
    expect(screen.getByRole('link', { name: 'Sign out' }).getAttribute('href')).toBe('/sign-out')
  })

  it('Manage account renders only when given', () => {
    const { rerender } = render(shell())
    expect(screen.queryByRole('link', { name: 'Manage account' })).toBeNull()
    rerender(shell({ manageAccountHref: 'https://accounts.example.com' }))
    expect(screen.getByRole('link', { name: 'Manage account' }).getAttribute('href')).toBe(
      'https://accounts.example.com',
    )
  })

  it('decorative icons are hidden from the accessibility tree', () => {
    render(shell())
    const svgs = Array.from(document.querySelectorAll('nav svg'))
    expect(svgs).toHaveLength(2)
    for (const svg of svgs) expect(svg.getAttribute('aria-hidden')).toBe('true')
  })

  it('has axe zero violations, with and without Manage account', async () => {
    const { rerender } = render(shell())
    let results = await axe.run(document.body, { rules: { 'color-contrast': { enabled: false } } })
    expect(results.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.html).join(' ')}`)).toEqual([])
    rerender(shell({ manageAccountHref: '/account' }))
    results = await axe.run(document.body, { rules: { 'color-contrast': { enabled: false } } })
    expect(results.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.html).join(' ')}`)).toEqual([])
  })
})

// Router seam: the shell stays router-free; an app passes its own link component for the nav entries.
const seen: string[] = []
function Link({
  href,
  className,
  children,
}: {
  href: string
  className: (s: { isActive: boolean }) => string
  children: React.ReactNode
}) {
  seen.push(href)
  return (
    <a data-custom="1" href={href} className={className({ isActive: href === '/agents' })}>
      {children}
    </a>
  )
}

describe('AppShell navLink seam', () => {
  it('renders each nav entry through the given link component, with the entry href and a className function', () => {
    seen.length = 0
    render(shell({ navLink: Link }))
    const nav = screen.getByRole('navigation', { name: 'Workspace' })
    expect(Array.from(nav.querySelectorAll('a[data-custom]')).map((a) => a.getAttribute('href'))).toEqual([
      '/home',
      '/agents',
    ])
    expect(seen).toEqual(['/home', '/agents'])
    expect(nav.querySelectorAll('a')[1]!.className).toMatch(/(^| )bg-accent( |$)/)
    expect(nav.querySelectorAll('a')[0]!.className).not.toMatch(/(^| )bg-accent( |$)/)
  })
})
