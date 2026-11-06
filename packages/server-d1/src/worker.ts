import type { D1WorkerEnv, ScheduledControllerLike } from './compose.js'
import { workerFor } from './instance.js'

// The Workflow class named by the `MAIL_SYNC` binding in wrangler.jsonc ([[CHN5]] D34) must be a named export of the Worker entry.
export { MailSyncWorkflow } from './mail-sync-workflow.js'

export default {
  fetch: (req: Request, env: D1WorkerEnv): Promise<Response> => workerFor(env).fetch(req),
  // [[CHN5]] D14: the one `scheduled` handler of the Worker; it dispatches on the cron expression.
  scheduled: (controller: ScheduledControllerLike, env: D1WorkerEnv): Promise<void> => workerFor(env).scheduled(controller),
}
