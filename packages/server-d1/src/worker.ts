import type { D1WorkerEnv, ExecutionContextLike, ScheduledControllerLike } from './compose.js'
import { earlyAnswer } from './early.js'

// The Workflow class named by the `MAIL_SYNC` binding in wrangler.jsonc ([[CHN5]] D34) must be a named export of the Worker entry. Its module loads the composition only when a run starts.
export { MailSyncWorkflow } from './mail-sync-workflow.js'

// #522: the composition (`instance.js`: the registry, the operations, Gmail, Better Auth) is loaded by a dynamic import, so a cold request that `earlyAnswer` can answer from the variables alone (the unauthenticated `/mcp` 401 and the discovery documents)
// never evaluates it or reads a database. The bundler keeps the module lazy: it is evaluated at the first import().
const instance = () => import('./instance.js')

export default {
  // [[AGT8]] D49: the execution context reaches the app so an authorisation can start the runner with `waitUntil`.
  fetch: async (req: Request, env: D1WorkerEnv, ctx: ExecutionContextLike): Promise<Response> =>
    earlyAnswer(req, env) ?? (await instance()).workerFor(env).fetch(req, ctx),
  // [[CHN5]] D14: the one `scheduled` handler of the Worker; it dispatches on the cron expression.
  scheduled: async (controller: ScheduledControllerLike, env: D1WorkerEnv): Promise<void> =>
    (await instance()).workerFor(env).scheduled(controller),
}
