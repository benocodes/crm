// The SettingsSection composite ([[UI443]] D11): an `<h2>` title, an optional description and the content, in the Card look. `readOnly`
// makes its rows a `<dl>` (see `SettingsRow`).
import type { ReactNode } from 'react'
import { useId } from 'react'
import { ReadOnlyRowsContext } from './settings-row'
import { Card, CardContent, CardHeader, CardTitle } from './ui/card'

export interface SettingsSectionProps {
  title: string
  description?: string
  /** The children are read-only `SettingsRow`s, rendered as a `<dl>`. */
  readOnly?: boolean
  children: ReactNode
}

export function SettingsSection({ title, description, readOnly = false, children }: SettingsSectionProps) {
  const headingId = useId()
  return (
    <Card asChild>
      <section aria-labelledby={headingId}>
        <CardHeader>
          <CardTitle asChild>
            <h2 id={headingId} className="text-lg">
              {title}
            </h2>
          </CardTitle>
          {description ? <p className="text-sm text-muted-foreground">{description}</p> : null}
        </CardHeader>
        <CardContent>
          <ReadOnlyRowsContext.Provider value={readOnly}>
            {readOnly ? <dl className="m-0 flex flex-col gap-3">{children}</dl> : children}
          </ReadOnlyRowsContext.Provider>
        </CardContent>
      </section>
    </Card>
  )
}
