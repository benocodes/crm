// What must never be in the release package ([[OPS210]] D8).
export type ForbiddenKind = 'env-file' | 'dev-vars' | 'wrangler-config' | 'env-key' | 'sk_live_' | 'sk_test_' | 'pem' | 'database-id'
export interface Finding {
  file: string
  kind: ForbiddenKind
}
export const envDatabaseIds = (_wranglerJsonc: string): string[] => {
  throw new Error('not implemented')
}
export const scanForbidden = (_dir: string, _opts: { databaseIds: readonly string[] }): Finding[] => {
  throw new Error('not implemented')
}
export const assertNoForbidden = (_dir: string, _opts: { databaseIds: readonly string[] }): void => {
  throw new Error('not implemented')
}
