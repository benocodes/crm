// TEST-ONLY Worker entry ([[UI246]] D6): the REAL composition's options spread into a test composition that adds a capturing `sendResetPassword`, so Better Auth's own reset
// request issues a real token the test can use. The shipped composition has no `sendResetPassword`; nothing here is ever deployed or imported by the production Worker.
import { betterAuth } from 'better-auth'
import { authOptions, createAuthHandler } from '../index.js'

interface Env {
  CONTROL_DB: never
  AUTH_SECRET: string
  PUBLIC_BASE_URL: string
  /** `1`: the shipped composition unchanged (no `sendResetPassword`). */
  SHIPPED?: string
}

const captured: Array<{ token: string; email: string }> = []
let handler: ((req: Request) => Promise<Response>) | undefined

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url)
    if (url.pathname === '/__resets') return Response.json(captured)
    if (!url.pathname.startsWith('/auth/')) return new Response('not found', { status: 404 })
    const config = { secret: env.AUTH_SECRET, baseURL: env.PUBLIC_BASE_URL }
    if (env.SHIPPED === '1') return (handler ??= createAuthHandler(env.CONTROL_DB, config, { unsafeOpenAdmissionForTests: true }))(req)
    if (!handler) {
      const options = authOptions(env.CONTROL_DB, config, { unsafeOpenAdmissionForTests: true })
      const auth = betterAuth({
        ...options,
        emailAndPassword: {
          ...options.emailAndPassword,
          sendResetPassword: async ({ user, token }: { user: { email: string }; token: string }) => {
            captured.push({ token, email: user.email })
          },
        },
      })
      handler = (r) => auth.handler(r)
    }
    return handler(req)
  },
}
