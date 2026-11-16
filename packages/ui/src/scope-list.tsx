export interface ScopeItem {
  name: string
  description: string
}

/** [[UI381]] D10: tight rows in a capped-height region that scrolls on its own, named and keyboard focusable, so the page's primary button stays in view. Read-only scope names and their registry descriptions. Every value is a text child, never markup: names and descriptions can be attacker-chosen. */
export function ScopeList({ scopes }: { scopes: readonly ScopeItem[] }) {
  return (
    <div className="vb-scope-list__region" role="region" aria-label="Requested permissions" tabIndex={0}>
      <ul className="vb-scope-list">
        {scopes.map((scope) => (
          <li key={scope.name} className="vb-scope-list__item">
            <code className="vb-scope-list__name">{scope.name}</code>
            <span className="vb-scope-list__description">{scope.description}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}
