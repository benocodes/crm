// The AppShell composite ([[UI443]] D8, D11): the workspace app's frame. "Vibase" and the workspace name at the top, the entries, the
// person with Sign out (and Manage account when given) at the bottom, a skip link first, a main region. One `<nav>`: below `md` the aside
// stacks above the page and the entries run as a row of links (no drawer, no dialog); from `md` it is a sidebar. The shell renders what it is
// given; which entries show is the app's decision ([[UI443]] P2).
import type { ComponentType, ReactNode } from 'react'
import { cn } from '../lib/utils'
import { Button } from './ui/button'
import { focusRing } from './ui/focus-ring'

export interface AppNavEntry {
  label: string
  href: string
  /** A decorative icon (lucide); hidden from the accessibility tree. */
  icon?: ComponentType<{ className?: string; 'aria-hidden'?: boolean | 'true' }>
  current?: boolean
}

export interface AppShellProps {
  productName?: string
  workspaceName: string
  nav: readonly AppNavEntry[]
  person: { name: string; email?: string }
  /** A button when `onClick` is given, a link when `href` is. */
  signOut: { onClick: () => void } | { href: string }
  manageAccountHref?: string
  children: ReactNode
}

const MAIN_ID = 'main-content'

export function AppShell({
  productName = 'Vibase',
  workspaceName,
  nav,
  person,
  signOut,
  manageAccountHref,
  children,
}: AppShellProps) {
  const skip = (event: React.MouseEvent<HTMLAnchorElement>) => {
    event.preventDefault()
    document.getElementById(MAIN_ID)?.focus()
  }
  return (
    <div className="flex min-h-screen flex-col bg-background text-foreground md:flex-row">
      <a
        href={`#${MAIN_ID}`}
        onClick={skip}
        className={cn(
          'sr-only focus:not-sr-only focus:absolute focus:top-2 focus:left-2 focus:z-10 focus:rounded-md focus:bg-background focus:px-3 focus:py-2 focus:text-sm',
          focusRing,
        )}
      >
        Skip to main content
      </a>
      <aside className="flex flex-col gap-4 border-b p-4 md:w-60 md:shrink-0 md:border-r md:border-b-0">
        <div className="flex flex-col">
          <span className="text-lg font-semibold">{productName}</span>
          <span className="text-sm text-muted-foreground">{workspaceName}</span>
        </div>
        <nav aria-label="Workspace" className="flex flex-row flex-wrap gap-1 md:flex-col">
          {nav.map((entry) => {
            const Icon = entry.icon
            return (
              <a
                key={entry.href}
                href={entry.href}
                aria-current={entry.current ? 'page' : undefined}
                className={cn(
                  'flex items-center gap-2 rounded-md px-3 py-2 text-sm font-medium hover:bg-accent hover:text-accent-foreground',
                  entry.current && 'bg-accent text-accent-foreground',
                  focusRing,
                )}
              >
                {Icon ? <Icon aria-hidden="true" className="size-4" /> : null}
                {entry.label}
              </a>
            )
          })}
        </nav>
        <div className="flex flex-col gap-2 md:mt-auto">
          <div className="flex flex-col text-sm">
            <span className="font-medium">{person.name}</span>
            {person.email ? <span className="break-all text-muted-foreground">{person.email}</span> : null}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {manageAccountHref ? (
              <Button asChild variant="link" size="sm">
                <a href={manageAccountHref}>Manage account</a>
              </Button>
            ) : null}
            {'href' in signOut ? (
              <Button asChild variant="outline" size="sm">
                <a href={signOut.href}>Sign out</a>
              </Button>
            ) : (
              <Button type="button" variant="outline" size="sm" onClick={signOut.onClick}>
                Sign out
              </Button>
            )}
          </div>
        </div>
      </aside>
      <main id={MAIN_ID} tabIndex={-1} className="min-w-0 flex-1 p-4 outline-none md:p-8">
        {children}
      </main>
    </div>
  )
}
