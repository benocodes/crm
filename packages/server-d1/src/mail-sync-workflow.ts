// The Workflow of one sync run ([[CHN5]] D11, D34). It imports `cloudflare:workers`, so only the Worker bundle loads it; the orchestrator itself is
// `runMailSync` in `@vault/api` (Node-safe, tested with the workerd step shim), reached through the composition.
import { WorkflowEntrypoint } from 'cloudflare:workers'
import type { MailSyncParams, MailSyncSummary, WorkflowEventLike, WorkflowStepLike } from '@vault/api'
import type { D1WorkerEnv } from './compose.js'
import { workerFor } from './instance.js'

export class MailSyncWorkflow extends WorkflowEntrypoint<D1WorkerEnv, MailSyncParams> {
  async run(event: WorkflowEventLike<MailSyncParams>, step: WorkflowStepLike): Promise<MailSyncSummary> {
    return workerFor(this.env).runMailSync(event, step)
  }
}
