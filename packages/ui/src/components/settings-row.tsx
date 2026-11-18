// The SettingsRow composite ([[UI443]] D11): a label with an optional description beside a value or a control. Inside a read-only
// `SettingsSection` the rows form a `<dl>` (a `<div>` of `<dt>`/`<dd>`, valid HTML); elsewhere the label names the control (`htmlFor`).
import type { ReactNode } from 'react'
import { createContext, useContext } from 'react'
import { Label } from './ui/label'

/** Set by `SettingsSection`: true when its rows are a read-only definition list. */
export const ReadOnlyRowsContext = createContext(false)

export interface SettingsRowProps {
  label: string
  /** Secondary text under the label (control rows) or under the value (read-only rows). */
  description?: string
  /** A control row: the id of the control this label names. */
  htmlFor?: string
  /** The value (read-only) or the control. */
  children: ReactNode
}

export function SettingsRow({ label, description, htmlFor, children }: SettingsRowProps) {
  const readOnly = useContext(ReadOnlyRowsContext)
  if (readOnly) {
    return (
      <div className="flex flex-col gap-1 sm:flex-row sm:items-baseline sm:gap-6">
        <dt className="text-sm font-medium text-muted-foreground sm:w-40 sm:shrink-0">{label}</dt>
        <dd className="m-0 text-sm break-words">
          {children}
          {description ? <p className="text-xs text-muted-foreground">{description}</p> : null}
        </dd>
      </div>
    )
  }
  return (
    <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between sm:gap-6">
      <div className="flex flex-col gap-1">
        {htmlFor ? <Label htmlFor={htmlFor}>{label}</Label> : <span className="text-sm font-medium">{label}</span>}
        {description ? <p className="text-xs text-muted-foreground">{description}</p> : null}
      </div>
      <div className="text-sm">{children}</div>
    </div>
  )
}
