// Stub for the red run ([[UI449]] D2): the real catalogue lands in the green commit.
export type ScopeArea = { key: string; name: string; sentence: string; resources: readonly string[] }
export const SCOPE_AREAS: readonly ScopeArea[] = []
export const NOT_DEFAULT_GRANT: readonly string[] = ['audit:read']
export function areaOfScope(_scope: string): string | null {
  return null
}
