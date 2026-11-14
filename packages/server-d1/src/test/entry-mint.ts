// TEST-ONLY Worker entry (never deployed): the REAL Worker module with one addition, `/auth/*` answered by the test composition (open admission) when `OPEN_ADMISSION=1`, so a test can mint
// real Better Auth tokens inside workerd and present them to the real composition on the same CONTROL_DB ([[CORE244]]). Every other path is `src/worker.ts` untouched.
import { createAuthHandler } from '@vibase/auth'
import { createVibaseRegistry, grantableScopes } from '@vibase/api'
import worker from '../worker.js'
import type { D1WorkerEnv } from '../compose.js'

export { MailSyncWorkflow } from '../worker.js'

type Env = D1WorkerEnv & { OPEN_ADMISSION?: string }
let handler: ((req: Request) => Promise<Response>) | undefined

export default {
  fetch(req: Request, env: Env, ctx: Parameters<typeof worker.fetch>[2]): Promise<Response> {
    const path = new URL(req.url).pathname
    if (env.OPEN_ADMISSION === '1' && (path === '/auth' || path.startsWith('/auth/'))) {
      handler ??= createAuthHandler(env.CONTROL_DB as never, { secret: env.AUTH_SECRET!, baseURL: env.PUBLIC_BASE_URL!, vaultScopes: createVibaseRegistry().declaredScopes(), grantableScopes: grantableScopes(createVibaseRegistry().declaredScopes()) }, { unsafeOpenAdmissionForTests: true })
      return handler(req)
    }
    return worker.fetch(req, env, ctx)
  },
  scheduled: worker.scheduled,
}
