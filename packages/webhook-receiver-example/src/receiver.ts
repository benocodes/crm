// The receiver. Stub: the red commit ([[API221]]).
export interface WorkflowBinding {
  create(options: { id: string; params: unknown }): Promise<unknown>
  get(id: string): Promise<unknown>
}
export interface ReceiverEnv {
  WEBHOOK_SECRET: string
  REPLY_WORKFLOW: WorkflowBinding
}
export async function handleWebhook(_request: Request, _env: ReceiverEnv, _nowMs?: number): Promise<Response> {
  return new Response('stub', { status: 200 })
}
