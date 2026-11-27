// `GET /oauth/callback/google` ([[CHN5]] D9, D32, D33, D55, D57): a plain route at the root, outside the registry. The browser that arrives carries no
// bearer token, so the signed state is its only binding to a vault user. Every refusal answers a short code (a redirect parameter or the
// built-in page), writes nothing and emits nothing; nothing from Google, the query string or a secret reaches the page or a log line.
import type { Context } from 'hono'
import { defineOperation, execute, unit, uuidv7, type PreparedOperation, type StorageBinding } from '@vibase/storage'
import type { Role, ScopePolicy } from '../auth/roles.js'
import { scopesForRole } from '../auth/roles.js'
import { GmailApiError, HttpGmailClient } from '../channels/gmail/client.js'
import { watchAtConnect } from '../channels/gmail/watch.js'
import { normalizeIdentityValue } from '../identity/normalize.js'
import { ScopeSet } from '../scopes.js'
import type { PreparedEnv } from '../storage/definition.js'
import { connectOperation } from './connect.js'
import type { GmailConfig, PushConfig } from './config.js'
import { sealToken } from './credentials.js'
import type { GoogleKeyCache } from './google-keys.js'
import { GMAIL_READONLY, GoogleExchangeError, exchangeCode, verifyIdToken, type GoogleEndpoints } from './google.js'
import { redirectUriOf } from './operations.js'
import { pkceVerifier, verifyState } from './state.js'
import { requestSync, type MailSyncInstances } from '../sync/request.js'

export type ConnectError =
  | 'state_invalid'
  | 'consent_denied'
  | 'scope_missing'
  | 'not_a_member'
  | 'session_mismatch'
  | 'exchange_failed'
  | 'temporarily_unavailable'

/** The fixed text of each code, shown on the built-in page. Never provider text. Exported as a value so the workspace app's copy of the table ([[UI467]] P2) is checked against it, codes and sentences. */
export const CONNECT_ERROR_TEXT: Record<ConnectError, string> = {
  state_invalid: 'This connect link is invalid or has expired. Start again.',
  consent_denied: 'The connection was cancelled at Google. Nothing was connected.',
  scope_missing: 'Gmail access was not granted. Start again and leave the Gmail permission ticked.',
  not_a_member: 'Your account is not allowed to connect a mailbox to this workspace.',
  session_mismatch:
    'Sign in to this workspace in this browser as the person who started the connection, then start again.',
  exchange_failed: 'Google did not complete the connection. Start again.',
  temporarily_unavailable: 'The connection could not be completed right now. Try again in a minute.',
}
const STATUS: Record<ConnectError, number> = {
  state_invalid: 400,
  consent_denied: 400,
  scope_missing: 400,
  not_a_member: 403,
  session_mismatch: 403,
  exchange_failed: 400,
  temporarily_unavailable: 503,
}
/** Own addresses of one connection: the profile address plus verified aliases, bounded so the connect unit stays one small batch. */
export const MAX_OWN_ADDRESSES = 25

/**
 * [[CORE572]] D8, D9, P2: how the callback binds the browser to the person who started the connect. Named by the composition from the auth provider, never inferred from an absent reader:
 * `better-auth` refuses unless the request carries a live session of the state's user; `state-only` (clerk, none) trusts the signed state alone, the accepted gap of D9.
 */
export type CallbackSession =
  | {
      mode: 'better-auth'
      /** The sign-in subject of the live session on these request headers (Better Auth's own lookup); null: no live session; throws when it cannot say. */
      read: (headers: Headers) => Promise<string | null>
    }
  | { mode: 'state-only' }

export interface CallbackDeps {
  /** [[CORE572]] P2: required, so a composition that forgets it does not compile. */
  session: CallbackSession
  /** Null: unconfigured, the route answers 404 ([[CHN5]] D58). */
  config: GmailConfig | null
  endpoints: GoogleEndpoints
  /** The Google signing-key cache of the ID-token check ([[CORE577]] D21): shared with push, one per isolate. */
  keys: GoogleKeyCache
  fetch: typeof fetch
  /** The `users/me` base of the Gmail API; default Gmail's. */
  gmailBaseUrl?: string
  /** The provider's current workspace role for a sign-in subject: null when the provider has no such person or no admissible role; throws when it cannot say. Null here: no provider. */
  roleOf: ((authSubject: string) => Promise<Role | null>) | null
  policy: ScopePolicy
  declaredScopes: readonly string[]
  /** [[UI469]] D5: where the callback returns when `CONNECT_RETURN_URL` is unset: `<PUBLIC_BASE_URL or the request's origin><defaultReturnPath>`. Absent: the built-in result page. */
  defaultReturnPath?: string
  /** The `MAIL_SYNC` Workflow binding ([[CHN141]] D55, D75). Absent: the connection is committed and no sync is requested. */
  instances?: MailSyncInstances
  /** The effective push configuration ([[CHN5]] D87): when set, the callback registers the watch. */
  push?: PushConfig | null
  storage: (c: Context) => StorageBinding
  clock?: () => Date
  newId?: () => string
  randomBytes?: (n: number) => Uint8Array
}

const escapeHtml = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')
const HEADERS = {
  'content-type': 'text/html; charset=utf-8',
  'cache-control': 'no-store',
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
  'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'",
}
const page = (title: string, bodyHtml: string, status: number): Response =>
  new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(title)}</title><style>body{font-family:system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem;line-height:1.5}code{background:#eee;padding:0 .25rem;border-radius:.25rem}</style></head><body><h1>${escapeHtml(title)}</h1>${bodyHtml}</body></html>`,
    { status, headers: HEADERS },
  )

/** The user's sign-in subject: a read unit, because the role source is keyed by it. */
export function userSubjectOperation(userId: string): PreparedOperation<string | null> {
  return defineOperation<string | null>({
    name: 'connections.callback_subject',
    mutates: false,
    reads: (qc) => ({
      user: {
        query: qc.db.selectFrom('users').select('users.auth_subject').where('users.id', '=', userId),
        mode: 'maybe' as const,
      },
    }),
    build: (found) =>
      unit({
        steps: [],
        events: [],
        decode: () => (found.maybe('user')?.auth_subject as string | null | undefined) ?? null,
      }),
  })
}

export function googleCallbackHandler(deps: CallbackDeps): (c: Context) => Promise<Response> {
  const config = deps.config
  return async (c) => {
    if (!config) return c.json({ error: { code: 'not_found', message: 'no such route' } }, 404)
    const storage = deps.storage(c)
    if (storage.kind !== 'd1')
      return c.json(
        { error: { code: 'not_implemented', message: 'Gmail connections are implemented for D1 only' } },
        501,
      )
    const url = new URL(c.req.url)
    const clock = deps.clock ?? (() => new Date())
    const now = clock()

    // [[UI469]] D5: a set CONNECT_RETURN_URL always wins; else the instance's own page when the composition names one; else null (the built-in page).
    const returnTarget = (): string | null => {
      if (config.returnUrl) return config.returnUrl
      if (!deps.defaultReturnPath) return null
      return `${config.publicBaseUrl ?? url.origin}${deps.defaultReturnPath}`
    }

    const refuse = (code: ConnectError): Response => {
      console.warn(`[gmail] connect refused: ${code}`)
      const target = returnTarget()
      if (target) return redirectTo(target, { error: code })
      return page(
        'Not connected',
        `<p>${escapeHtml(CONNECT_ERROR_TEXT[code])}</p><p><code>${code}</code></p>`,
        STATUS[code],
      )
    }

    const q = url.searchParams
    const state = q.get('state')
    const claims = state ? await verifyState(config.stateSecret, state, now.getTime()) : null
    if (!claims) return refuse('state_invalid')

    // [[CORE572]] D8, P1: the state only proves who started the connect, not who is in this browser: a forwarded authorize link would otherwise connect the mailbox of whoever opens it under the sender.
    // On Better Auth the browser must carry a live session of the state's user; refused before `consent_denied` and before any call to Google, so an unbound browser never spends the code.
    // D9: on `state-only` (Clerk and `none`) there is no same-origin session to read, so the state alone binds the connect. That gap is accepted and recorded; do not close it here.
    const binding = storage
    const organizationId = binding.organizationId
    let subject: string | null | undefined
    const stateSubject = async (): Promise<string | null> =>
      (subject ??= (
        await execute(
          binding,
          { kind: 'tenant', actorId: claims.user_id, organizationId },
          userSubjectOperation(claims.user_id),
        )
      ).value)
    if (deps.session.mode === 'better-auth') {
      let sessionSubject: string | null
      let userSubject: string | null
      try {
        sessionSubject = await deps.session.read(c.req.raw.headers)
        userSubject = sessionSubject === null ? null : await stateSubject()
      } catch {
        return refuse('temporarily_unavailable')
      }
      if (sessionSubject === null || userSubject === null || sessionSubject !== userSubject)
        return refuse('session_mismatch')
    }
    if (q.get('error')) return refuse('consent_denied')
    const code = q.get('code')
    const redirectUri = redirectUriOf(config, url.origin)
    if (!code || !redirectUri) return refuse('exchange_failed')

    // Google: the code, the ID token, the profile and the send-as list. Any failure here is `exchange_failed`; the page never says why.
    let tokens: Awaited<ReturnType<typeof exchangeCode>>
    let identity: { sub: string; email: string }
    let gmail: HttpGmailClient
    let profile: Awaited<ReturnType<HttpGmailClient['getProfile']>>
    let sendAs: Awaited<ReturnType<HttpGmailClient['listSendAs']>>
    try {
      tokens = await exchangeCode({
        endpoints: deps.endpoints,
        clientId: config.clientId,
        clientSecret: config.clientSecret,
        redirectUri,
        code,
        verifier: await pkceVerifier(config.stateSecret, claims.nonce),
        fetch: deps.fetch,
      })
      if (!tokens.scopes.includes(GMAIL_READONLY)) return refuse('scope_missing')
      identity = await verifyIdToken(tokens.idToken, {
        endpoints: deps.endpoints,
        clientId: config.clientId,
        keys: deps.keys,
        nowMs: now.getTime(),
      })
      gmail = new HttpGmailClient({
        accessToken: async () => tokens.accessToken,
        fetch: deps.fetch,
        ...(deps.gmailBaseUrl ? { baseUrl: deps.gmailBaseUrl } : {}),
      })
      profile = await gmail.getProfile()
      sendAs = await gmail.listSendAs()
    } catch (err) {
      // The kind only: a Google error carries no token, but nothing of it is worth a line either.
      console.warn(
        `[gmail] connect exchange failed: ${err instanceof GoogleExchangeError ? err.code : err instanceof GmailApiError ? `gmail_${err.status}` : 'error'}`,
      )
      return refuse('exchange_failed')
    }

    // The addresses that become own (D10): the profile address, and each send-as address that is primary or verified. An alias that is not a valid address is skipped.
    let mailbox: string
    try {
      mailbox = normalizeIdentityValue('email', profile.emailAddress)
    } catch {
      return refuse('exchange_failed')
    }
    const own = new Set([mailbox])
    for (const s of sendAs) {
      if (!(s.isPrimary === true || s.verificationStatus === 'accepted') || typeof s.sendAsEmail !== 'string') continue
      try {
        own.add(normalizeIdentityValue('email', s.sendAsEmail))
      } catch {
        // not an address the vault stores
      }
      if (own.size >= MAX_OWN_ADDRESSES) break
    }

    // D33: the person must still hold a role that grants connections:write. A lookup that fails is retryable and changes nothing.
    let subjectNow: string | null
    try {
      subjectNow = await stateSubject()
    } catch {
      return refuse('temporarily_unavailable')
    }
    if (subjectNow === null || deps.roleOf === null) return refuse('not_a_member')
    const subjectForRole: string = subjectNow
    let role: Role | null
    try {
      role = await deps.roleOf(subjectForRole)
    } catch {
      return refuse('temporarily_unavailable')
    }
    if (
      role === null ||
      !scopesForRole(role, deps.declaredScopes, deps.policy).has({ resource: 'connections', action: 'write' })
    )
      return refuse('not_a_member')

    // The watch ([[CHN5]] D89), after the person is admitted and before the unit: a failure never refuses the connect. The connection commits without a row and the
    // next cron tick registers it. The log names the class and Google's status, never the address, the topic or a token.
    let watchExpiresAt: string | undefined
    if (deps.push) {
      const w = await watchAtConnect(gmail, deps.push.topicName)
      if (w.ok) watchExpiresAt = w.expires_at
      else console.warn(`[gmail] watch not registered at connect (${w.klass}, ${w.detail}); the cron will retry`)
    }

    // One unit, acting as the user (D9, D21): the connection, the credential, the cursor, the state row, the own identities and the events.
    const env: PreparedEnv = {
      actor: { id: claims.user_id, kind: 'user' },
      organizationId,
      scopes: ScopeSet.parse([]),
      now,
      newId: deps.newId ?? (() => uuidv7(now)),
      randomBytes: deps.randomBytes ?? ((n) => crypto.getRandomValues(new Uint8Array(n))),
    }
    try {
      const ciphertext = await sealToken(config.credentialsKey, tokens.refreshToken, env.randomBytes(12))
      const result = (
        await execute(
          binding,
          { kind: 'tenant', actorId: claims.user_id, organizationId },
          connectOperation(env, {
            google_sub: identity.sub,
            mailbox,
            own_addresses: [...own],
            granted_scopes: tokens.scopes,
            ciphertext,
            key_version: config.keyVersion,
            cursor: profile.historyId,
            ...(watchExpiresAt ? { watch_expires_at: watchExpiresAt } : {}),
          }),
        )
      ).value
      // After the unit has committed (D9): a request before it could name a connection that never existed. A failure here never undoes the connect; the cron serves it.
      if (deps.instances) {
        try {
          await requestSync(
            { binding, organizationId, clock: () => now, newId: env.newId, instances: deps.instances },
            result.connection_id,
          )
        } catch (err) {
          console.error(`[gmail] sync request failed after connect: ${err instanceof Error ? err.name : 'error'}`)
        }
      } else {
        console.warn('[gmail] connected, but no sync was requested: the MAIL_SYNC Workflow binding is missing')
      }
      const target = returnTarget()
      if (target) return redirectTo(target, { connection_id: result.connection_id })
      return page('Connected', `<p>Connected <code>${escapeHtml(mailbox)}</code>. You can close this tab.</p>`, 200)
    } catch (err) {
      console.error(`[gmail] connect unit failed: ${err instanceof Error ? err.name : 'error'}`)
      return refuse('temporarily_unavailable')
    }
  }
}

function redirectTo(base: string, params: Record<string, string>): Response {
  const target = new URL(base)
  for (const [k, v] of Object.entries(params)) target.searchParams.set(k, v)
  return new Response(null, {
    status: 302,
    headers: { location: target.toString(), 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' },
  })
}
