import { focusRing } from './ui/focus-ring'

export interface ScopeItem {
  name: string
  description: string
}

/** [[UI381]] D10: tight rows in a capped-height region that scrolls on its own, named and keyboard focusable, so the page's primary button stays in view. Read-only scope names and their registry descriptions. Every value is a text child, never markup: names and descriptions can be attacker-chosen. */
/** `label` names the region (default "Requested permissions"); several lists on one page ([[UI455]]'s disclosures) each pass their own so the landmark names stay unique. */
export function ScopeList({
  scopes,
  label = 'Requested permissions',
}: {
  scopes: readonly ScopeItem[]
  label?: string
}) {
  return (
    <section
      className={`max-h-48 overflow-y-auto rounded-md border p-3 ${focusRing}`}
      aria-label={label}
      // biome-ignore lint/a11y/noNoninteractiveTabindex: a scrollable region must be keyboard focusable (axe scrollable-region-focusable)
      tabIndex={0}
    >
      <ul className="flex flex-col gap-2">
        {scopes.map((scope) => (
          <li key={scope.name} className="flex flex-col gap-0.5">
            <code className="font-mono text-sm font-medium break-all">{scope.name}</code>
            <span className="text-sm text-muted-foreground">{scope.description}</span>
          </li>
        ))}
      </ul>
    </section>
  )
}
