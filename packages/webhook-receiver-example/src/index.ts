// The Worker entry: the receiver answers HTTP, the Workflow class does the work.
import { handleWebhook, type ReceiverEnv } from './receiver.js'

export { ReplyWorkflow } from './workflow.js'

export default {
  fetch: (request: Request, env: ReceiverEnv) => handleWebhook(request, env),
}
