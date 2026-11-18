import { describe, expect, it } from 'vitest'
import { NAV, visibleNav, type NavRow } from './nav.js'

// [[UI460]] D7, D8 (group 5): the sidebar is a table whose rows are added with their pages and shown by `visible(ctx)` over { provider, scopes }.
const CTXS = [
  { provider: 'clerk', scopes: [] as string[] },
  { provider: 'better-auth', scopes: [] as string[] },
  { provider: null, scopes: [] as string[] },
  { provider: 'better-auth', scopes: ['connections:read'] },
]

describe('NAV', () => {
  it('has the Home row first, to /home, and it is visible for every context, including no scopes', () => {
    expect(NAV[0]).toMatchObject({ label: 'Home', href: '/home' })
    for (const ctx of CTXS) expect(visibleNav(NAV, ctx, '/home').map((e) => e.label)).toContain('Home')
  })

  it('Home carries an icon and the entry is a plain link to its path', () => {
    const [home] = visibleNav(NAV, CTXS[0]!, '/home')
    expect(home).toMatchObject({ label: 'Home', href: '/home', current: true })
    expect(home!.icon).toBeDefined()
  })
})

describe('visible(ctx) on rows other than Home', () => {
  const rows: NavRow[] = [
    { label: 'Home', href: '/home' },
    { label: 'Accounts', href: '/accounts', visible: (ctx) => ctx.scopes.includes('connections:read') },
    { label: 'Clerk only', href: '/clerk-only', visible: (ctx) => ctx.provider === 'clerk' },
  ]
  const labels = (ctx: (typeof CTXS)[number]) => visibleNav(rows, ctx, '/home').map((e) => e.label)
  it('a row needing connections:read is hidden without it and shown with it', () => {
    expect(labels(CTXS[1]!)).not.toContain('Accounts')
    expect(labels(CTXS[3]!)).toContain('Accounts')
  })
  it('a row gated on provider is shown for that provider only', () => {
    expect(labels(CTXS[0]!)).toContain('Clerk only')
    expect(labels(CTXS[1]!)).not.toContain('Clerk only')
    expect(labels(CTXS[2]!)).not.toContain('Clerk only')
  })
  it('only the row whose path is the current page is current', () => {
    const all = visibleNav(rows, { provider: 'clerk', scopes: ['connections:read'] }, '/accounts')
    expect(all.filter((e) => e.current).map((e) => e.label)).toEqual(['Accounts'])
  })
})
