// The Workflow of one sync run ([[CHN5]] D11, D34). It imports `cloudflare:workers`, so only the Worker bundle loads it; the orchestrator itself is
// `runGmailSyncWorkflow` in `@vibase/api` (Node-safe, tested with the workerd step shim), reached through the composition.
import { WorkflowEntrypoint } from 'cloudflare:workers'
import type { GmailSyncParams, GmailSyncSummary, WorkflowEventLike, WorkflowStepLike } from '@vibase/api'
import type { D1WorkerEnv } from './compose.js'

export class GmailSyncWorkflow extends WorkflowEntrypoint<D1WorkerEnv, GmailSyncParams> {
  async run(event: WorkflowEventLike<GmailSyncParams>, step: WorkflowStepLike): Promise<GmailSyncSummary> {
    const { workerFor } = await import('./instance.js')
    return workerFor(this.env).runGmailSyncWorkflow(event, step)
  }
}
