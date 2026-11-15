// TEST-ONLY Worker entry (never deployed) for [[CORE304]]: the REAL Worker module (src/worker.ts) with a recording `EMAIL` binding, so what the Worker would send can be read back at `/__emails`. The browser E2E leg
// (`e2e/auth-pages-reset.e2e.ts`) runs the same entry under `wrangler dev`, and `self-service-reset-workerd.test.ts` runs it in Miniflare. With `SIGNUP_OPEN=1` only `/auth/sign-up/email` is answered by the test
// composition (open admission), so a test can make an account without an invitation; every other path, `/auth/request-password-reset` included, is the real composition untouched.
import { createAuthHandler } from '@vibase/auth'
import worker from '../worker.js'
import type { D1WorkerEnv } from '../compose.js'

export { MailSyncWorkflow } from '../worker.js'

type Env = D1WorkerEnv & { SIGNUP_OPEN?: string }
const recorded: unknown[] = []
const recorder = {
  async send(message: unknown): Promise<unknown> {
    recorded.push(message)
    return { messageId: `recorded-${recorded.length}` }
  },
}
let wrapped: Env | undefined
let signUp: ((req: Request) => Promise<Response>) | undefined

export default {
  fetch(req: Request, env: Env, ctx: Parameters<typeof worker.fetch>[2]): Promise<Response> | Response {
    const url = new URL(req.url)
    if (url.pathname === '/__emails') return Response.json(recorded)
    if (env.SIGNUP_OPEN === '1' && url.pathname === '/auth/sign-up/email') {
      signUp ??= createAuthHandler(
        env.CONTROL_DB as never,
        { secret: env.AUTH_SECRET!, baseURL: env.PUBLIC_BASE_URL! },
        { unsafeOpenAdmissionForTests: true },
      )
      return signUp(req)
    }
    // One wrapped env per isolate: the composition is built once, from the first env it sees.
    wrapped ??= { ...env, EMAIL: recorder as never }
    return worker.fetch(req, wrapped, ctx)
  },
  scheduled: worker.scheduled,
}
