// TEST-ONLY Worker entry (never deployed, never imported by the production Worker): the Better Auth composition behind `/auth` in workerd,
// with the test admission switch settable by a binding, and two probes for the password hasher ([[CORE243]] P1, P3).
import { hashPassword as scryptHash } from 'better-auth/crypto'
import { createAuthHandler, hashPassword, verifyPassword } from '../index.js'

interface Env {
  CONTROL_DB: never
  AUTH_SECRET: string
  PUBLIC_BASE_URL: string
  OPEN_ADMISSION?: string
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url)
    if (url.pathname === '/__noop') return new Response('ok')
    if (url.pathname === '/__hash') {
      // One hash per request, so the caller times whole requests (workerd's clock does not advance during CPU work).
      const kdf = url.searchParams.get('kdf')
      try {
        if (kdf === 'scrypt') await scryptHash('correct horse battery staple')
        else if (kdf === 'pbkdf2') await hashPassword('correct horse battery staple', { iterations: Number(url.searchParams.get('iterations') ?? 100_000) })
        else return new Response('unknown kdf', { status: 400 })
        return new Response('ok')
      } catch (err) {
        return Response.json({ error: err instanceof Error ? err.name : 'error' }, { status: 500 })
      }
    }
    if (url.pathname === '/__verify') {
      const hash = url.searchParams.get('hash') ?? ''
      return Response.json({ ok: await verifyPassword({ hash, password: url.searchParams.get('password') ?? '' }) })
    }
    if (url.pathname.startsWith('/auth/')) {
      const handler = createAuthHandler(env.CONTROL_DB, { secret: env.AUTH_SECRET, baseURL: env.PUBLIC_BASE_URL }, { unsafeOpenAdmissionForTests: env.OPEN_ADMISSION === '1' })
      return handler(req)
    }
    return new Response('not found', { status: 404 })
  },
}
