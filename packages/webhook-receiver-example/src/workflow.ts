// The Workflow class. It imports `cloudflare:workers`, so only the Worker bundle loads it; everything it does is `runReply`.
import { WorkflowEntrypoint } from 'cloudflare:workers'
import { NonRetryableError } from 'cloudflare:workflows'
import { runReply, type ReplyOutcome, type StepLike } from './reply.js'

export interface WorkflowEnv {
  VIBASE_URL: string
  VIBASE_API_KEY: string
}

export class ReplyWorkflow extends WorkflowEntrypoint<WorkflowEnv, unknown> {
  async run(event: { payload: unknown }, step: StepLike): Promise<ReplyOutcome> {
    return runReply(event, step, {
      baseUrl: this.env.VIBASE_URL,
      apiKey: this.env.VIBASE_API_KEY,
      fetch: (input, init) => fetch(input, init),
      nonRetryable: (message) => new NonRetryableError(message),
    })
  }
}
