// Standard Webhooks verification with Web Crypto only (no dependency, so this file copies anywhere a Worker runs).
// The vault signs `<webhook-id>.<webhook-timestamp>.<body>` with HMAC-SHA256 keyed by the decoded bytes of the `whsec_<base64>` secret and sends
// `v1,<base64>` for each secret in force (two during the 24 hours after a rotation), space separated. Accept the request when any `v1` signature matches.

export const WEBHOOK_HEADERS = { id: 'webhook-id', timestamp: 'webhook-timestamp', signature: 'webhook-signature' } as const
/** A timestamp further than this from now, either way, is refused: it stops a captured request being replayed later. */
export const TOLERANCE_SECONDS = 300

export type Verdict = { ok: true } | { ok: false; reason: string }

const enc = new TextEncoder()
const bytesOf = (b64: string): Uint8Array => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))

export async function verifyWebhook(a: { secret: string; headers: Headers; body: string; nowMs?: number }): Promise<Verdict> {
  const id = a.headers.get(WEBHOOK_HEADERS.id)
  const timestamp = a.headers.get(WEBHOOK_HEADERS.timestamp)
  const signatures = a.headers.get(WEBHOOK_HEADERS.signature)
  if (!id || !timestamp || !signatures) return { ok: false, reason: 'missing_header' }
  if (!/^\d{1,12}$/.test(timestamp)) return { ok: false, reason: 'bad_timestamp' }
  if (Math.abs((a.nowMs ?? Date.now()) / 1000 - Number(timestamp)) > TOLERANCE_SECONDS) return { ok: false, reason: 'timestamp_out_of_tolerance' }
  let key: CryptoKey
  try {
    const raw = a.secret.startsWith('whsec_') ? a.secret.slice('whsec_'.length) : a.secret
    key = await crypto.subtle.importKey('raw', bytesOf(raw) as BufferSource, { name: 'HMAC', hash: 'SHA-256' }, false, ['verify'])
  } catch {
    return { ok: false, reason: 'bad_secret' }
  }
  const signed = enc.encode(`${id}.${timestamp}.${a.body}`)
  for (const candidate of signatures.split(' ')) {
    const [version, value] = candidate.split(',')
    if (version !== 'v1' || !value) continue // an unknown version is skipped, not an error
    try {
      // `verify` compares in constant time.
      if (await crypto.subtle.verify('HMAC', key, bytesOf(value) as BufferSource, signed)) return { ok: true }
    } catch {
      /* not base64: not a match */
    }
  }
  return { ok: false, reason: 'no_matching_signature' }
}
