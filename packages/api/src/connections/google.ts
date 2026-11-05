// STUB (red commit): replaced by the implementation.
export interface GoogleEndpoints {
  authorizeUrl: string
  tokenUrl: string
  jwksUrl: string
}
export const GOOGLE_ENDPOINTS: GoogleEndpoints = { authorizeUrl: '', tokenUrl: '', jwksUrl: '' }
export const REQUESTED_SCOPES: readonly string[] = []
export const GMAIL_READONLY = 'https://www.googleapis.com/auth/gmail.readonly'
export function buildAuthorizeUrl(_p: { endpoints: GoogleEndpoints; clientId: string; redirectUri: string; state: string; challenge: string }): string {
  throw new Error('not implemented')
}
export class GoogleExchangeError extends Error {}
export function exchangeCode(_p: {
  endpoints: GoogleEndpoints
  clientId: string
  clientSecret: string
  redirectUri: string
  code: string
  verifier: string
  fetch: typeof fetch
}): Promise<{ refreshToken: string; accessToken: string; idToken: string; scopes: string[] }> {
  throw new Error('not implemented')
}
export function verifyIdToken(_idToken: string, _p: { endpoints: GoogleEndpoints; clientId: string; fetch: typeof fetch; nowMs: number }): Promise<{ sub: string; email: string }> {
  throw new Error('not implemented')
}
