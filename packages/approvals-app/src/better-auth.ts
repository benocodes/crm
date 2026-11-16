// Better Auth in the browser, through its client SDK against the API origin's /auth ([[UI255]] D2, [[UI388]]): cookie session, the JWT from /auth/token as the API bearer.
// Needs the app and the API on one registrable domain (the session cookie is credentialed cross-origin; README, D5).
import { createAuthClient } from 'better-auth/client'
import { jwtClient } from 'better-auth/client/plugins'
import type { AppConfig } from './config.js'
import type { Env, Session } from './session.js'

export async function loadSession(config: AppConfig, env: Env): Promise<Session> {
  const client = createAuthClient({
    baseURL: `${config.apiOrigin}/auth`,
    plugins: [jwtClient()],
    fetchOptions: { credentials: 'include', customFetchImpl: env.fetch },
  })
  // The SDK returns { data, error } for an HTTP failure and throws for a network one: both are "unavailable" here (P2).
  const got = await client.getSession()
  if (got.error) throw new Error(got.error.message || `the session check failed (${got.error.status})`)
  const user = got.data?.user ?? null
  return {
    signedIn: user !== null,
    email: user?.email ?? null,
    token: async () => {
      if (!user) return null
      try {
        const r = await client.token()
        return r.error ? null : (r.data?.token ?? null)
      } catch {
        return null
      }
    },
    signIn: async () => {
      const back = new URL(env.location.href)
      back.hash = ''
      env.location.assign(`${config.apiOrigin}/sign-in?return_to=${encodeURIComponent(back.href)}`)
    },
    signOut: async () => {
      const r = await client.signOut()
      if (r.error) throw new Error(r.error.message || `sign-out failed (${r.error.status})`)
      env.location.reload()
    },
  }
}
