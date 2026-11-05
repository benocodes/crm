// STUB (red commit): replaced by the implementation.
export interface StateClaims {
  user_id: string
  nonce: string
  expires_at: number
}
export function signState(_secret: string, _claims: StateClaims): Promise<string> {
  throw new Error('not implemented')
}
export function verifyState(_secret: string, _state: string, _nowMs: number): Promise<StateClaims | null> {
  throw new Error('not implemented')
}
export function pkceVerifier(_secret: string, _nonce: string): Promise<string> {
  throw new Error('not implemented')
}
export function pkceChallenge(_verifier: string): Promise<string> {
  throw new Error('not implemented')
}
