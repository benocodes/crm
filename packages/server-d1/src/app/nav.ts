// [[UI460]] D7, D8 ([[UI443]]): the sidebar as a table. A row is added with its page and shown by `visible(ctx)` over the provider and the active organisation's scopes (the page's read scope, and the provider for rows that
// exist on one provider only). Home has no `visible`: everyone sees it. Icons are imported by name (`lucide-react`), so the bundle holds only these.
import type { AppNavEntry } from '@vibase/ui/components'
import { House } from 'lucide-react'

export interface NavContext {
  /** `clerk` or `better-auth`, from discovery; `null` when there is none. */
  provider: string | null
  /** The active organisation's scopes (`me.get`). */
  scopes: readonly string[]
}

export interface NavRow {
  label: string
  /** The page's exact path: a plain link, a full page load (UI443 D7). */
  href: string
  icon?: AppNavEntry['icon']
  /** Absent means always visible. */
  visible?: (ctx: NavContext) => boolean
}

export const NAV: readonly NavRow[] = [{ label: 'Home', href: '/home', icon: House }]

/** The rows `ctx` may see, as the shell's entries; `current` is true for the one whose path is the page being shown. */
export function visibleNav(rows: readonly NavRow[], ctx: NavContext, currentPath: string): AppNavEntry[] {
  return rows
    .filter((r) => !r.visible || r.visible(ctx))
    .map(({ label, href, icon }) => ({ label, href, ...(icon ? { icon } : {}), current: href === currentPath }))
}
