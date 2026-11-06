import type { D1WorkerEnv, ExecutionContextLike, ScheduledControllerLike } from './compose.js'
import { workerFor } from './instance.js'

// The Workflow class named by the `MAIL_SYNC` binding in wrangler.jsonc ([[CHN5]] D34) must be a named export of the Worker entry.
export { MailSyncWorkflow } from './mail-sync-workflow.js'

export default {
  // [[AGT8]] D49: the execution context reaches the app so an authorisation can start the runner with `waitUntil`.
  fetch: (req: Request, env: D1WorkerEnv, ctx: ExecutionContextLike): Promise<Response> => workerFor(env).fetch(req, ctx),
  // [[CHN5]] D14: the one `scheduled` handler of the Worker; it dispatches on the cron expression.
  scheduled: (controller: ScheduledControllerLike, env: D1WorkerEnv): Promise<void> => workerFor(env).scheduled(controller),
}
