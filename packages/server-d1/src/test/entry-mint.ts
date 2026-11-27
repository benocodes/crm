// TEST-ONLY Worker entry (never deployed): the REAL Worker module with one addition, `/auth/*` answered by the test composition (open admission) when `OPEN_ADMISSION=1`, so a test can mint
// real Better Auth tokens inside workerd and present them to the real composition on the same CONTROL_DB ([[CORE244]]). Every other path is `src/worker.ts` untouched.
import { createAuthHandler } from '@vibase/auth'
import { createVibaseRegistry, defaultGrantScopes, grantableScopes } from '@vibase/api'
import { parseBuiltInAuthConfig } from '../auth-config.js'
import worker from '../worker.js'
import type { D1WorkerEnv } from '../compose.js'

export { GmailSyncWorkflow } from '../worker.js'

type Env = D1WorkerEnv & { OPEN_ADMISSION?: string }
/** A request with this header goes to the REAL composition's `/auth` branch even under `OPEN_ADMISSION` ([[UI255]]: the CORS tests need compose.ts's own `/auth`, the sign-up needs the test one). */
const REAL_AUTH_HEADER = 'x-test-real-auth'
let handler: ((req: Request) => Promise<Response>) | undefined

export default {
  fetch(req: Request, env: Env, ctx: Parameters<typeof worker.fetch>[2]): Promise<Response> {
    const path = new URL(req.url).pathname
    if (
      env.OPEN_ADMISSION === '1' &&
      req.headers.get(REAL_AUTH_HEADER) === null &&
      (path === '/auth' || path.startsWith('/auth/'))
    ) {
      // The same parse the Worker uses, so the mint handler trusts exactly the origins the real composition does ([[UI255]] D3); a Google client when the test binds one.
      const parsed = parseBuiltInAuthConfig({ ...env } as unknown as Record<string, string | undefined>)
      handler ??= createAuthHandler(
        env.CONTROL_DB as never,
        {
          secret: env.AUTH_SECRET!,
          baseURL: env.PUBLIC_BASE_URL!,
          ...(parsed.trustedOrigins ? { trustedOrigins: parsed.trustedOrigins } : {}),
          ...(parsed.google ? { google: parsed.google } : {}),
          vaultScopes: createVibaseRegistry().declaredScopes(),
          grantableScopes: grantableScopes(createVibaseRegistry().declaredScopes()),
          // As compose.ts does ([[CORE330]]): the registration default list is what a scope-less authorize is filled with.
          defaultScopes: defaultGrantScopes(createVibaseRegistry().declaredScopes()),
        },
        { unsafeOpenAdmissionForTests: true },
      )
      return handler(req)
    }
    return worker.fetch(req, env, ctx)
  },
  scheduled: worker.scheduled,
}
