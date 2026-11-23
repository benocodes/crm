// [[UI460]] D7, D8 ([[UI443]]): the sidebar as a table. A row is added with its page and shown by `visible(ctx)` over the provider and the active organisation's scopes (the page's read scope, and the provider for rows that
// exist on one provider only). Home has no `visible`: everyone sees it. Icons are imported by name (`lucide-react`), so the bundle holds only these.
import type { AppNavEntry } from '@vibase/ui/components'
import { Bot, House, Mail } from 'lucide-react'

export interface NavContext {
  /** `clerk` or `better-auth`, from discovery; `null` when there is none. */
  provider: string | null
  /** The active organisation's scopes (`me.get`). */
  scopes: readonly string[]
}

export interface NavRow {
  label: string
  /** The page's exact path: a client-routed link (react-router `NavLink`); the router marks the current row. */
  href: string
  icon?: AppNavEntry['icon']
  /** Absent means always visible. */
  visible?: (ctx: NavContext) => boolean
}

export const NAV: readonly NavRow[] = [
  { label: 'Home', href: '/app/home', icon: House },
  // [[UI467]] D1, D12: shown by the page's read scope.
  {
    label: 'Connected accounts',
    href: '/app/accounts',
    icon: Mail,
    visible: (ctx) => ctx.scopes.includes('connections:read'),
  },
  // [[UI459]] D1, D8: shown by the page's read scope.
  { label: 'Agents', href: '/app/agents', icon: Bot, visible: (ctx) => ctx.scopes.includes('agents:read') },
]

/** The rows `ctx` may see, as the shell's entries. Which one is current comes from the router's location (`NavLink`), not from here. */
export function visibleNav(rows: readonly NavRow[], ctx: NavContext): AppNavEntry[] {
  return rows
    .filter((r) => !r.visible || r.visible(ctx))
    .map(({ label, href, icon }) => ({ label, href, ...(icon ? { icon } : {}) }))
}
