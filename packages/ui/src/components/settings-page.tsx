// The SettingsPage composite ([[UI443]] D11): the page frame. One `<h1>`, an optional description and actions, a page error in an error Alert
// that takes focus when it appears and again when it changes (FormLayout's rule), and a loading state (`aria-busy` on the region).
import type { ReactNode } from 'react'
import { useId, useLayoutEffect, useRef } from 'react'
import { Alert } from './alert'

export interface SettingsPageProps {
  title: string
  description?: string
  /** An actions slot beside the title (buttons or links). */
  actions?: ReactNode
  /** A page-level error (a failed read); shown in an error Alert that takes focus. */
  error?: string
  /** While true the region is `aria-busy` and the children give way to a loading line. */
  loading?: boolean
  children: ReactNode
}

export function SettingsPage({ title, description, actions, error, loading = false, children }: SettingsPageProps) {
  const headingId = useId()
  const alertRef = useRef<HTMLDivElement>(null)
  const lastError = useRef<string | undefined>(undefined)
  useLayoutEffect(() => {
    const changed = error !== undefined && error !== lastError.current
    lastError.current = error
    if (changed) alertRef.current?.focus()
  })
  return (
    <section aria-labelledby={headingId} aria-busy={loading ? true : undefined} className="flex flex-col gap-6">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex flex-col gap-1">
          <h1 id={headingId} className="text-2xl font-semibold">
            {title}
          </h1>
          {description ? <p className="text-sm text-muted-foreground">{description}</p> : null}
        </div>
        {actions ? <div className="flex items-center gap-2">{actions}</div> : null}
      </header>
      {error ? (
        <Alert variant="error" ref={alertRef}>
          {error}
        </Alert>
      ) : null}
      {loading ? <p className="text-sm text-muted-foreground">Loading…</p> : children}
    </section>
  )
}
