// Test-only ([[CHN155]]). What Pub/Sub's authenticated push looks like to the vault: RS256 keys minted locally, a JWKS served through an injected `fetch`
// (counted), signed OIDC tokens with overridable claims, and the push request body. Web APIs and `jose` only. Not in the production barrel.
import { SignJWT, exportJWK, generateKeyPair, type JWK } from 'jose'
import { GOOGLE_JWKS_URL } from '../channels/gmail/push.js'
import type { PushConfig } from '../connections/config.js'

export const PUSH: PushConfig = {
  topicName: 'projects/vault-p/topics/gmail.watch',
  subscription: 'projects/vault-p/subscriptions/gmail.push',
  serviceAccount: 'gmail-push@vault-p.iam.gserviceaccount.com',
  publicBaseUrl: 'https://vault.test',
  audience: 'https://vault.test/gmail/push',
}

export interface PushKey {
  kid: string
  privateKey: CryptoKey
  jwk: JWK
}
export async function newPushKey(kid = 'push-key-1'): Promise<PushKey> {
  const { publicKey, privateKey } = await generateKeyPair('RS256', { extractable: true })
  return { kid, privateKey, jwk: { ...(await exportJWK(publicKey)), kid, alg: 'RS256', use: 'sig' } }
}

export interface PushClaims {
  iss?: string
  aud?: string
  email?: string | null
  email_verified?: boolean | null
  /** Seconds from `now` (negative: expired). Default one hour. */
  expIn?: number | null
}
/** A push token as Google's would be: RS256, the two `iss` forms, `aud` the endpoint, the service account's `email` and `email_verified`. `now` is the vault's injected clock. */
export async function signPushToken(key: PushKey, now: Date, c: PushClaims = {}, header: { alg?: string; kid?: string } = {}): Promise<string> {
  const iat = Math.floor(now.getTime() / 1000)
  const payload: Record<string, unknown> = {}
  if (c.email !== null) payload.email = c.email ?? PUSH.serviceAccount
  if (c.email_verified !== null) payload.email_verified = c.email_verified ?? true
  const jwt = new SignJWT(payload)
    .setProtectedHeader({ alg: 'RS256', kid: key.kid, ...header } as never)
    .setIssuer(c.iss ?? 'https://accounts.google.com')
    .setAudience(c.aud ?? PUSH.audience)
    .setSubject('100000000000000000001')
    .setIssuedAt(iat)
  if (c.expIn !== null) jwt.setExpirationTime(iat + (c.expIn ?? 3600))
  return await jwt.sign(key.privateKey)
}

/** A JWKS `fetch` that counts its calls. `mode` is switchable per test. */
export function jwksFetch(keys: PushKey[]): { fetch: typeof fetch; urls: string[]; mode: 'ok' | 'status' | 'throw' | 'bad_json' } {
  const state = {
    urls: [] as string[],
    mode: 'ok' as 'ok' | 'status' | 'throw' | 'bad_json',
    fetch: (async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      state.urls.push(url)
      if (url !== GOOGLE_JWKS_URL) throw new Error(`jwksFetch: unexpected URL ${url}`)
      if (state.mode === 'throw') throw new TypeError('fetch failed')
      if (state.mode === 'status') return new Response('{"error":"down"}', { status: 500 })
      if (state.mode === 'bad_json') return new Response('not json', { status: 200 })
      return new Response(JSON.stringify({ keys: keys.map((k) => k.jwk) }), { status: 200, headers: { 'content-type': 'application/json' } })
    }) as typeof fetch,
  }
  return state
}

const b64 = (s: string): string => btoa(s).replace(/\+/g, '-').replace(/\//g, '_')
/** Pub/Sub's push request body: the Gmail notification is the base64url `message.data`. `data` overrides it whole (a payload that does not decode). */
export function pushBody(o: { emailAddress?: string; historyId?: string; subscription?: string; data?: string } = {}): string {
  const data = o.data ?? b64(JSON.stringify({ emailAddress: o.emailAddress ?? 'owner@vault.test', historyId: o.historyId ?? '1234567' }))
  return JSON.stringify({ message: { data, messageId: '2070443601311540', message_id: '2070443601311540', publishTime: '2026-11-05T10:00:00.000Z', publish_time: '2026-11-05T10:00:00.000Z' }, subscription: o.subscription ?? PUSH.subscription })
}
