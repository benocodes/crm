export type ScopeAction = 'read' | 'write'
export type Scope = { resource: string; action: ScopeAction }

const SCOPE = /^([a-z][a-z0-9_]*):(read|write)$/

export function parseScope(s: string): Scope {
  const m = SCOPE.exec(s)
  if (!m) throw new Error(`invalid scope: ${s}`)
  return { resource: m[1]!, action: m[2] as ScopeAction }
}

export function formatScope(s: Scope): string {
  return `${s.resource}:${s.action}`
}

/** Exact-match grants; `write` does not imply `read`. */
export class ScopeSet {
  private constructor(private readonly granted: ReadonlySet<string>) {}

  static parse(strings: readonly string[]): ScopeSet {
    return new ScopeSet(new Set(strings.map((s) => formatScope(parseScope(s)))))
  }

  has(required: Scope): boolean {
    return this.granted.has(formatScope(required))
  }

  toStrings(): string[] {
    return [...this.granted].sort()
  }
}
