export type ScopeAction = 'read' | 'read_metadata' | 'request_approval' | 'write'
export type Scope = { resource: string; action: ScopeAction }

const SCOPE = /^([a-z][a-z0-9_]*):(read|read_metadata|request_approval|write)$/

export function parseScope(s: string): Scope {
  const m = SCOPE.exec(s)
  if (!m) throw new Error(`invalid scope: ${s}`)
  return { resource: m[1]!, action: m[2] as ScopeAction }
}

export function formatScope(s: Scope): string {
  return `${s.resource}:${s.action}`
}

/**
 * [[AGT8]] D31: the closure of a scope list under `write => request_approval` ([[API518]] D3 adds `read => read_metadata`, only where
 * `declared` is given and contains it), the implications between actions (`read` is independent of `write`, `write` implies nothing
 * about it, and `read_metadata` implies nothing). Every authentication path closes a set BEFORE it meets it with another
 * (token, owner cap, role, agent-grantable) and before a requirement is checked, so exact-string intersection stays correct:
 * a `request_approval` token over a `write` cap keeps `request_approval` only, a `write` token over a `request_approval` cap
 * likewise. Computed, never stored: a stored grant keeps what was granted. `declared`, when given, limits the added scopes to
 * ones the vault declares (a resource with nothing proposable has no `request_approval`).
 */
export function closeScopes(strings: readonly string[], declared?: ReadonlySet<string> | readonly string[]): string[] {
  const allowed = declared === undefined ? null : new Set(declared)
  const out = new Set(strings)
  for (const s of strings) {
    const m = /^([a-z][a-z0-9_]*):(write|read)$/.exec(s)
    if (!m) continue
    if (m[2] === 'write') {
      const implied = `${m[1]}:request_approval`
      if (allowed === null || allowed.has(implied)) out.add(implied)
    } else {
      // [[API518]] D3, P1: `read => read_metadata` only where the vault declares it; with `declared` absent nothing is added (the grammar has no resource list).
      const implied = `${m[1]}:read_metadata`
      if (allowed !== null && allowed.has(implied)) out.add(implied)
    }
  }
  return [...out]
}

/** Exact-match grants; `write` does not imply `read`. Closure under `write => request_approval` is applied by `closed`, never by `parse`. */
export class ScopeSet {
  private constructor(private readonly granted: ReadonlySet<string>) {}

  static parse(strings: readonly string[]): ScopeSet {
    return new ScopeSet(new Set(strings.map((s) => formatScope(parseScope(s)))))
  }

  /** [[AGT8]] D31: parses `strings` closed under `write => request_approval` ([[closeScopes]]). */
  static closed(strings: readonly string[], declared?: ReadonlySet<string> | readonly string[]): ScopeSet {
    return ScopeSet.parse(
      closeScopes(
        strings.map((s) => formatScope(parseScope(s))),
        declared,
      ),
    )
  }

  has(required: Scope): boolean {
    return this.granted.has(formatScope(required))
  }

  toStrings(): string[] {
    return [...this.granted].sort()
  }
}
