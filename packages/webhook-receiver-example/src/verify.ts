// Standard Webhooks verification with Web Crypto only. Stub: the red commit ([[API221]]).
export const WEBHOOK_HEADERS = { id: 'webhook-id', timestamp: 'webhook-timestamp', signature: 'webhook-signature' } as const
export const TOLERANCE_SECONDS = 300
export type Verdict = { ok: true } | { ok: false; reason: string }
export async function verifyWebhook(_a: { secret: string; headers: Headers; body: string; nowMs?: number }): Promise<Verdict> {
  return { ok: true }
}
