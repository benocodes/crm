// The ResourceList composite ([[UI458]] D11): rows with a title, meta lines, a status slot and row actions, an empty state and a loading state.
// It renders what it is given and carries no page wording ([[UI458]] P2). Every action's accessible name is its label plus the row's title
// (`aria-label="Sync now: ada@example.com"`, which still starts with the visible text), so two rows with the same action are told apart.
// A button action takes an `onClick` closure over its row; a link action takes an `href`.
import type { ReactNode } from 'react'
import { cn } from '../lib/utils'
import { buttonVariants } from './ui/button'

export interface ResourceRowAction {
  label: string
  /** A button action: called when clicked (close over the row). */
  onClick?: () => void
  /** A link action: navigates here. Wins over `onClick`. */
  href?: string
  destructive?: boolean
}

export interface ResourceListItem {
  id: string
  title: string
  /** Secondary lines under the title. */
  meta?: string[]
  /** A slot beside the title, usually a `StatusBadge`. */
  status?: ReactNode
  actions?: ResourceRowAction[]
  /** [[UI459]] D7: content under the meta lines, inside the row (a command to run, a note). Absent: nothing is rendered. */
  detail?: ReactNode
}

export interface ResourceListProps {
  /** The list's accessible name. */
  label: string
  items: ResourceListItem[]
  emptyText: string
  emptyAction?: ReactNode
  loading?: boolean
  loadingText?: string
}

export function ResourceList({
  label,
  items,
  emptyText,
  emptyAction,
  loading = false,
  loadingText,
}: ResourceListProps) {
  return (
    <div aria-busy={loading ? true : undefined}>
      {loading ? (
        <p className="text-sm text-muted-foreground">{loadingText ?? ''}</p>
      ) : items.length === 0 ? (
        <div className="flex flex-col items-start gap-3">
          <p className="text-sm text-muted-foreground">{emptyText}</p>
          {emptyAction}
        </div>
      ) : (
        <ul aria-label={label} className="flex flex-col divide-y divide-border rounded-lg border">
          {items.map((item) => (
            <li key={item.id} className="flex flex-wrap items-center justify-between gap-3 p-4">
              <div className="flex min-w-0 flex-1 flex-col gap-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-medium break-all">{item.title}</span>
                  {item.status}
                </div>
                {item.meta?.map((line) => (
                  <p key={line} className="text-xs text-muted-foreground">
                    {line}
                  </p>
                ))}
                {item.detail ? (
                  <div data-slot="detail" className="mt-1 flex flex-col gap-2 text-sm">
                    {item.detail}
                  </div>
                ) : null}
              </div>
              {item.actions?.length ? (
                <div className="flex flex-wrap items-center gap-2">
                  {item.actions.map((action) => {
                    const name = `${action.label}: ${item.title}`
                    const className = buttonVariants({
                      variant: action.destructive ? 'destructive' : 'secondary',
                      size: 'sm',
                    })
                    return action.href !== undefined ? (
                      <a key={action.label} href={action.href} aria-label={name} className={cn(className)}>
                        {action.label}
                      </a>
                    ) : (
                      <button
                        key={action.label}
                        type="button"
                        aria-label={name}
                        className={className}
                        onClick={action.onClick}
                      >
                        {action.label}
                      </button>
                    )
                  })}
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
