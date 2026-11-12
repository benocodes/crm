// The receiver: verify, start a Workflow keyed by the event id, answer at once. No work happens in the request beyond those two steps ([[API7]] D21).
import { verifyWebhook } from './verify.js'

/** The slice of a Cloudflare Workflow binding the receiver uses. */
export interface WorkflowBinding {
  create(options: { id: string; params: unknown }): Promise<unknown>
  get(id: string): Promise<unknown>
}
export interface ReceiverEnv {
  /** The `whsec_...` secret `POST /meta/v1/webhooks` returned (shown once). */
  WEBHOOK_SECRET: string
  REPLY_WORKFLOW: WorkflowBinding
}

/** The only event type this example acts on; the vault's subscription default is the same ([[API7]] D18). */
export const HANDLED_TYPE = 'interaction.created'

const answer = (status: number, body: Record<string, unknown>) => Response.json(body, { status })

/**
 * `create` with an id that already exists throws; for the receiver that is success (the vault delivered this event before, D15). The platform words the error in more than one way, so the
 * message is matched loosely, and any other error is checked by asking for the instance: if it is there, the event is already started.
 */
async function alreadyStarted(workflow: WorkflowBinding, id: string, error: unknown): Promise<boolean> {
  if (/already[\s._-]?exist/i.test(error instanceof Error ? error.message : String(error))) return true
  try {
    await workflow.get(id)
    return true
  } catch {
    return false
  }
}

export async function handleWebhook(request: Request, env: ReceiverEnv, nowMs?: number): Promise<Response> {
  if (request.method !== 'POST') return answer(405, { error: 'method_not_allowed' })
  const body = await request.text()
  const verdict = await verifyWebhook({ secret: env.WEBHOOK_SECRET, headers: request.headers, body, nowMs })
  if (!verdict.ok) return answer(401, { error: 'invalid_signature' })
  let event: Record<string, unknown>
  try {
    const parsed: unknown = JSON.parse(body)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('not an object')
    event = parsed as Record<string, unknown>
  } catch {
    return answer(400, { error: 'invalid_body' })
  }
  if (event.type !== HANDLED_TYPE) return answer(200, { ignored: true })
  const id = request.headers.get('webhook-id')!
  try {
    await env.REPLY_WORKFLOW.create({ id, params: event })
  } catch (error) {
    if (!(await alreadyStarted(env.REPLY_WORKFLOW, id, error))) return answer(500, { error: 'workflow_unavailable' })
  }
  return answer(200, { received: true })
}
