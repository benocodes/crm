import { ROTATION_OVERLAP_MS } from './secrets.js'

// [[API7]] D7, D12 ([[API220]]): Standard Webhooks' `v1` signature, computed with Web Crypto (no library in the Worker). The key is the decoded bytes of `whsec_<base64>`; the signed text is
// `<id>.<timestamp>.<body>`, the id being the event id and the timestamp Unix seconds. `standardwebhooks@1.1.1` is the test oracle only.

const enc = new TextEncoder()

const keyBytes = (secret: string): Uint8Array => {
  const b64 = secret.startsWith('whsec_') ? secret.slice('whsec_'.length) : secret
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))
}
const base64 = (bytes: Uint8Array): string => btoa(String.fromCharCode(...bytes))

async function sign(secret: string, text: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', keyBytes(secret) as BufferSource, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  return base64(new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(text))))
}

/** The `webhook-signature` value: `v1,<sig>` for each secret, space separated, in the order given. */
export async function signatureHeader(a: { secrets: string[]; id: string; timestamp: number; body: string }): Promise<string> {
  const text = `${a.id}.${a.timestamp}.${a.body}`
  return (await Promise.all(a.secrets.map(async (s) => `v1,${await sign(s, text)}`))).join(' ')
}

/**
 * The secrets to sign with (D12), newest first, from rows oldest first: the newest, plus the one before it while the newest is under 24 hours old (the rotation overlap). Rows are read in
 * `created_at` order, so a rotation is the newest row.
 */
export function secretsInForce<T extends { created_at: string }>(rows: readonly T[], now: Date): T[] {
  const newest = rows[rows.length - 1]
  if (!newest) return []
  const previous = rows[rows.length - 2]
  const young = now.getTime() - Date.parse(newest.created_at) < ROTATION_OVERLAP_MS
  return previous && young ? [newest, previous] : [newest]
}
