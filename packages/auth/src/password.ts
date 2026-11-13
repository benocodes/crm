// Red-commit stub: the hasher is implemented in the green commit.
export const PBKDF2_ITERATIONS = 100_000
export const PBKDF2_PREFIX = 'pbkdf2-sha256'
export async function hashPassword(_password: string, _opts: { iterations?: number } = {}): Promise<string> {
  throw new Error('not implemented')
}
export async function verifyPassword(_i: { hash: string; password: string }): Promise<boolean> {
  throw new Error('not implemented')
}
