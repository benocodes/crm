// Red-commit stub: the Better Auth composition is implemented in the green commit.
export interface AuthRuntimeConfig {
  secret: string
  baseURL: string
}
export interface AuthDatabaseLike {
  prepare(query: string): unknown
}
export interface CreateAuthOptions {
  /** TEST ONLY: admit sign-up and dynamic client registration (the shipped composition refuses both, [[CORE243]] P1). */
  unsafeOpenAdmissionForTests?: boolean
  generateId?: () => string
}
export const AUTH_TABLES: readonly string[] = []
export function authOptions(_db: AuthDatabaseLike, _config: AuthRuntimeConfig, _opts: CreateAuthOptions = {}): Record<string, unknown> {
  throw new Error('not implemented')
}
export function createAuthHandler(_db: AuthDatabaseLike, _config: AuthRuntimeConfig, _opts: CreateAuthOptions = {}): (req: Request) => Promise<Response> {
  throw new Error('not implemented')
}
