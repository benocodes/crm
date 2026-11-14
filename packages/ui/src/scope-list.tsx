export interface ScopeItem {
  name: string
  description: string
}

/** Read-only scope names and their registry descriptions. Every value is a text child, never markup: names and descriptions can be attacker-chosen. */
export function ScopeList({ scopes }: { scopes: readonly ScopeItem[] }) {
  return (
    <ul className="vb-scope-list">
      {scopes.map((scope) => (
        <li key={scope.name} className="vb-scope-list__item">
          <code className="vb-scope-list__name">{scope.name}</code>
          <span className="vb-scope-list__description">{scope.description}</span>
        </li>
      ))}
    </ul>
  )
}
