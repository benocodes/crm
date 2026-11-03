import { randomBytes } from 'node:crypto'

// A fake authorization server for the CLI's device-login tests ([[API104]]): RFC 8414 metadata, RFC 8628 device authorization,
// RFC 6749 refresh with rotating refresh tokens, RFC 7009 revocation. Test-only; nothing here is a real credential.

export interface Traffic {
  origin: string
  path: string
  url: string
  method: string
  headers: Record<string, string>
  body: string
}

type Handler = (req: Request) => Response | Promise<Response>

/**
 * A network of origins. Every request is recorded (headers and body, before the handler sees it); an origin nobody serves is
 * "unreachable". Redirects are the rig's business (the real fetch's behaviour, modelled in `rig`), so this sits under it.
 */
export function network(handlers: Record<string, Handler>) {
  const traffic: Traffic[] = []
  const fetch = async (req: Request): Promise<Response> => {
    const u = new URL(req.url)
    const headers: Record<string, string> = {}
    req.headers.forEach((v, k) => (headers[k] = v))
    traffic.push({ origin: u.origin, path: u.pathname, url: req.url, method: req.method, headers, body: await req.clone().text() })
    const h = handlers[u.origin]
    if (!h) throw new TypeError(`unreachable: ${u.origin}`)
    return h(req)
  }
  return { fetch, traffic, at: (origin: string, path?: string) => traffic.filter((t) => t.origin === origin && (path === undefined || t.path === path)) }
}

const hex = () => randomBytes(6).toString('hex')
const jsonRes = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

export type PollOutcome = 'pending' | 'slow_down' | 'denied' | 'expired' | 'ok' | 'html'

export interface FakeIssuerOptions {
  origin?: string
  clientId?: string
  /** What the device endpoint answers beyond the secrets. */
  device?: { expires_in?: number; interval?: number; complete?: boolean }
  /** One outcome per poll of the device grant; the last repeats. */
  script?: PollOutcome[]
  /** Access token life in seconds. */
  expiresIn?: number
  revocation?: 'ok' | 'fail' | 'none'
  subject?: string
  /** Makes an access token; the default is an opaque string. */
  mint?: (c: { sub: string; scope: string }) => string | Promise<string>
  /** Changes the metadata document. */
  metadata?: (base: Record<string, unknown>) => Record<string, unknown>
  /** Real milliseconds the token endpoint takes to answer a refresh (so concurrent callers overlap). */
  refreshDelayMs?: number
  /** Answers every request on these paths with a redirect to this URL (the metadata, device or token endpoint redirecting off-origin). */
  redirect?: { path: string; to: string }
}

export function fakeIssuer(opts: FakeIssuerOptions = {}) {
  const origin = opts.origin ?? 'https://issuer.test'
  const clientId = opts.clientId ?? 'client_cli'
  const script = [...(opts.script ?? ['ok'])]
  const expiresIn = opts.expiresIn ?? 3600
  const devices = new Map<string, { scope: string }>()
  const refresh = new Map<string, { scope: string; sub: string }>()
  const access = new Set<string>()
  const secrets = new Set<string>()
  const seenScopes: string[] = []
  let n = 0
  let polls = 0
  let refreshCount = 0
  const sub = opts.subject ?? 'user_a'
  let redirect = opts.redirect

  const issue = async (scope: string, subject: string) => {
    n++
    const token = opts.mint ? await opts.mint({ sub: subject, scope }) : `tok-access-${n}-${hex()}`
    const rt = `tok-refresh-${n}-${hex()}`
    access.add(token)
    refresh.set(rt, { scope, sub: subject })
    secrets.add(token)
    secrets.add(rt)
    return { access_token: token, token_type: 'Bearer', expires_in: expiresIn, refresh_token: rt, scope }
  }
  const err = (error: string, status = 400) => jsonRes({ error, error_description: `${error} (fake)` }, status)

  const handler: Handler = async (req) => {
    const u = new URL(req.url)
    if (redirect && u.pathname === redirect.path) return new Response(null, { status: 307, headers: { location: redirect.to } })
    if (u.pathname === '/.well-known/oauth-authorization-server') {
      const base: Record<string, unknown> = {
        issuer: origin,
        device_authorization_endpoint: origin + '/oauth/device_authorization',
        token_endpoint: origin + '/oauth/token',
        scopes_supported: ['openid', 'email', 'profile', 'offline_access'],
      }
      if ((opts.revocation ?? 'ok') !== 'none') base.revocation_endpoint = origin + '/oauth/revoke'
      return jsonRes(opts.metadata ? opts.metadata(base) : base)
    }
    const form = Object.fromEntries(new URLSearchParams(await req.text()))
    if (u.pathname === '/oauth/device_authorization') {
      if (form.client_id !== clientId) return err('invalid_client', 401)
      seenScopes.push(form.scope ?? '')
      const device_code = `tok-device-${hex()}`
      secrets.add(device_code)
      devices.set(device_code, { scope: form.scope ?? '' })
      return jsonRes({
        device_code,
        user_code: 'WDJB-MJHT',
        verification_uri: origin + '/activate',
        ...(opts.device?.complete === false ? {} : { verification_uri_complete: origin + '/activate?user_code=WDJB-MJHT' }),
        expires_in: opts.device?.expires_in ?? 600,
        interval: opts.device?.interval ?? 5,
      })
    }
    if (u.pathname === '/oauth/token') {
      if (form.client_id !== clientId) return err('invalid_client', 401)
      if (form.grant_type === 'urn:ietf:params:oauth:grant-type:device_code') {
        const d = devices.get(form.device_code ?? '')
        if (!d) return err('invalid_grant')
        const outcome = script.length > 1 ? script.shift()! : script[0]!
        polls++
        switch (outcome) {
          case 'pending':
            return err('authorization_pending')
          case 'slow_down':
            return err('slow_down')
          case 'denied':
            return err('access_denied')
          case 'expired':
            return err('expired_token')
          case 'html':
            return new Response('<html>blocked</html>', { status: 403, headers: { 'content-type': 'text/html' } })
          case 'ok':
            return jsonRes(await issue(d.scope, sub))
        }
      }
      if (form.grant_type === 'refresh_token') {
        refreshCount++
        if (opts.refreshDelayMs) await new Promise((r) => setTimeout(r, opts.refreshDelayMs))
        const r = refresh.get(form.refresh_token ?? '')
        if (!r) return err('invalid_grant')
        refresh.delete(form.refresh_token!) // rotating: a refresh token works once
        return jsonRes(await issue(r.scope, r.sub))
      }
      return err('unsupported_grant_type')
    }
    if (u.pathname === '/oauth/revoke') {
      if ((opts.revocation ?? 'ok') === 'fail') return new Response('boom', { status: 500 })
      refresh.delete(form.token ?? '')
      return new Response(null, { status: 200 })
    }
    return err('not_found', 404)
  }

  return {
    origin,
    clientId,
    handler,
    /** The device grant's scope parameter of each device request. */
    seenScopes,
    /** Every access token, refresh token and device code issued: none may appear in the CLI's output. */
    secrets: () => [...secrets],
    isLiveAccess: (t: string) => access.has(t),
    /** The server side stops accepting this access token. */
    rejectAccess: (t: string) => void access.delete(t),
    rejectAllAccess: () => access.clear(),
    /** The provider forgets every refresh token (a revoked grant). */
    forgetRefresh: () => refresh.clear(),
    hasRefresh: (t: string) => refresh.has(t),
    setRedirect: (r: { path: string; to: string } | undefined) => void (redirect = r),
    polls: () => polls,
    refreshCalls: () => refreshCount,
    setScript: (s: PollOutcome[]) => void (script.length = 0, script.push(...s)),
  }
}
