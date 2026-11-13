// The `clerk` step of `setup:remote` ([[OPS65]] D13-D17, D25-D33, D37, D38): rows C1-C10 as a desired-state table over Clerk's Backend API
// (plain `fetch`, no SDK), the Frontend API and the issuer's metadata. Every row is evaluated and the whole checklist is printed (D26); a
// dashboard-only row is checked where a read exists and otherwise `manual`, never claimed. Requests go only to the paths of the table
// (D33): no Platform API, no dashboard endpoints. Nothing here prints a key, the PEM, an invitation link or a client secret.
import { SCOPE_DESCRIPTIONS, SCOPE_POLICY, createVaultRegistry, toProviderScope } from '@vault/api'
import { parse } from 'jsonc-parser'
import { pemFromJwk, type ClerkKeys } from './clerk-keys.js'
import type { SetupDeps, SetupOptions, Status, StepResult } from './types.js'

const BAPI = 'https://api.clerk.com'
export const CLI_APP_NAME = 'Vibase CLI'
const ROLE = 'vibase_role'

/** What the Clerk rows read of a run: shared by `setup:remote` and `vibase instance setup` ([[OPS232]]), which differ in where the config text comes from. */
export interface ClerkCtx {
  opts: SetupOptions
  deps: Pick<SetupDeps, 'fetch' | 'readConfigText'>
  keys?: ClerkKeys
  cliClientId?: string
  jwtPem?: string
  manualRows?: string[]
}
type Ctx = ClerkCtx

type RowStatus = Exclude<Status, 'blocked'>
interface Row {
  id: string
  status: RowStatus
  detail: string
  /** Printed under a failing or unverified row: the dashboard path and the value to set. */
  fix?: string[]
}
interface Reply {
  status: number
  json: any // eslint-disable-line @typescript-eslint/no-explicit-any -- Clerk's JSON, read field by field below
}

/** The scopes of the desired state, from the operation registry (D40). */
export function desiredScopes() {
  const declared = createVaultRegistry().declaredScopes()
  const provider = declared.map(toProviderScope)
  return {
    declared,
    /** C8's ceiling: every declared scope and `offline_access` (refresh tokens for the CLI, D31). */
    cli: [...provider, 'offline_access'],
    /** C7: declared scopes with the verb `read` an agent may hold (D16, D40). */
    defaults: declared.filter((s) => SCOPE_POLICY[s]?.agentGrantable === true && s.split(':')[1] === 'read').map(toProviderScope),
    checklist: declared.map((s) => `  ${toProviderScope(s)}  ${SCOPE_DESCRIPTIONS[s] ?? ''}`),
  }
}

const sameSet = (a: readonly string[], b: readonly string[]) => a.length === b.length && new Set([...a, ...b]).size === a.length
const asList = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [])
const q = encodeURIComponent

/** The Clerk requests of one run. A write in a dry run is refused in code, as `run` does for wrangler. */
class Clerk {
  constructor(private ctx: Ctx, private keys: ClerkKeys) {}
  private async send(url: string, method: string, body: unknown, auth: boolean): Promise<Reply> {
    if (method !== 'GET' && this.ctx.opts.dryRun) throw new Error(`refusing to send ${method} ${url.replace(/^https:\/\/[^/]+/, '')} in a dry run`)
    const headers: Record<string, string> = {}
    if (auth) headers.authorization = `Bearer ${this.keys.secretKey}`
    if (body !== undefined) headers['content-type'] = 'application/json'
    const res = await this.ctx.deps.fetch(url, { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) })
    const raw = await res.text()
    let json: unknown = null
    try {
      json = raw ? JSON.parse(raw) : null
    } catch {
      json = null
    }
    return { status: res.status, json }
  }
  bapi = (method: string, path: string, body?: unknown) => this.send(`${BAPI}${path}`, method, body, true)
  issuer = (path: string) => this.send(`${this.keys.issuer}${path}`, 'GET', undefined, false)
}

const ok = (r: Reply) => r.status >= 200 && r.status < 300
/** Clerk's error text, for a row's detail: codes and messages only (no request body, no key). */
const refusal = (r: Reply): string => {
  const errs = Array.isArray(r.json?.errors) ? (r.json.errors as { code?: string; message?: string; long_message?: string; meta?: { param_name?: string } }[]) : []
  const text = errs.map((e) => [e.code, e.long_message ?? e.message, e.meta?.param_name && `(${e.meta.param_name})`].filter(Boolean).join(' ')).join('; ')
  return `HTTP ${r.status}${text ? `: ${text}` : ''}`
}

/** `AUTH_CLI_CLIENT_ID` as already written in `env.<name>` (D15: the stable key once known). */
export function configuredCliClientId(configText: string, env: string): string | undefined {
  const root = parse(configText, [], { allowTrailingComma: true }) as { env?: Record<string, { vars?: Record<string, unknown> }> } | undefined
  const v = root?.env?.[env]?.vars?.AUTH_CLI_CLIENT_ID
  return typeof v === 'string' && v !== '' ? v : undefined
}

/** The instance's signing key as the PEM `CLERK_JWT_KEY` holds (D14), from the Backend API's JWKS. */
export async function signingKeyPem(ctx: Ctx): Promise<string> {
  if (ctx.jwtPem) return ctx.jwtPem
  const r = await new Clerk(ctx, ctx.keys!).bapi('GET', '/v1/jwks')
  const key = (ok(r) && Array.isArray(r.json?.keys) ? (r.json.keys as { kty?: string }[]) : []).find((k) => k.kty === 'RSA')
  if (!key) throw new Error(`could not read the instance's signing key from Clerk (${refusal(r)})`)
  return (ctx.jwtPem = pemFromJwk(key))
}

export async function clerkStep(ctx: Ctx): Promise<StepResult> {
  const keys = ctx.keys!
  const { opts } = ctx
  const clerk = new Clerk(ctx, keys)
  const prod = keys.kind === 'production'
  const rows = new Map<string, Row>()
  const set = (id: string, status: RowStatus, detail: string, fix?: string[]) => void rows.set(id, { id, status, detail, ...(fix ? { fix } : {}) })
  const scopes = desiredScopes()

  // Instance identity (D14, D35, D37): the issuer is confirmed by its metadata and both keys must be one instance's.
  let issuerOk = false
  let stop = false
  try {
    const meta = await clerk.issuer('/.well-known/openid-configuration')
    issuerOk = ok(meta) && meta.json?.issuer === keys.issuer
    if (!issuerOk) set(prod ? 'domain' : 'instance', 'fail', ok(meta) ? `${keys.issuer}/.well-known/openid-configuration names issuer ${String(meta.json?.issuer)}, expected ${keys.issuer}` : `${keys.issuer} did not answer openid-configuration (${refusal(meta)})`, prod ? ['Dashboard → Domains: finish the Frontend API DNS records'] : undefined)
  } catch (e) {
    set(prod ? 'domain' : 'instance', 'fail', `${keys.issuer} is unreachable (${e instanceof Error ? e.message : 'failed'})`, prod ? ['Dashboard → Domains: finish the Frontend API DNS records'] : undefined)
  }
  if (prod && issuerOk) set('domain', 'ok', `the Frontend API domain ${keys.issuer} answers`)
  const jwks = await clerk.bapi('GET', '/v1/jwks')
  if (!ok(jwks)) {
    set('instance', 'fail', `Clerk refused the secret key (${refusal(jwks)})`)
    stop = true
  } else if (issuerOk) {
    const theirs = await clerk.issuer('/.well-known/jwks.json')
    const kids = (r: Reply) => asList((Array.isArray(r.json?.keys) ? r.json.keys : []).map((k: { kid?: string }) => k.kid)).sort()
    if (!ok(theirs) || kids(jwks).join() !== kids(theirs).join()) {
      set('instance', 'fail', 'the secret key and the publishable key are from different Clerk instances (the JWKS key ids differ)')
      stop = true
    } else set('instance', 'ok', `${keys.kind} instance ${keys.issuer}: both keys are one instance's`)
  } else stop = !prod
  const key = ok(jwks) ? (Array.isArray(jwks.json?.keys) ? (jwks.json.keys as { kty?: string }[]) : []).find((k) => k.kty === 'RSA') : undefined
  if (key) ctx.jwtPem = pemFromJwk(key)

  if (!stop) {
    // C1 (D27): the sign-up mode through the Frontend API.
    const env = issuerOk ? await clerk.issuer('/v1/environment').catch(() => null) : null
    const mode = env && ok(env) ? env.json?.user_settings?.sign_up?.mode : undefined
    if (mode === 'public') set('C1', 'fail', 'sign-up mode is public: anyone can sign up', ['Dashboard → Configure → Restrictions → Sign-up mode: Restricted'])
    else if (mode === 'restricted' || mode === 'waitlist') set('C1', 'ok', `sign-up mode ${mode}`)
    else set('C1', 'manual', 'could not read the sign-up mode (the Frontend API refused or did not answer): Dashboard → Configure → Restrictions → Sign-up mode must be Restricted')

    // C2 (D32): read only.
    const orgs = await clerk.bapi('GET', '/v1/instance/organization_settings')
    if (ok(orgs)) set('C2', 'ok', orgs.json?.enabled === true ? 'warning: Organizations are on; the vault ignores the `o` claim, but turn them off in the dashboard if nothing else uses them' : 'Organizations are off')
    else if (orgs.status === 402 || orgs.status === 404) set('C2', 'ok', 'Organizations are off (not available on this instance)')
    else set('C2', 'manual', `could not read the Organizations setting (${refusal(orgs)})`)

    // C3 (D28): never checked, never ok.
    set('C3', 'manual', 'Dashboard → Sessions → Customize session token: add the claim {"vibase_role": "{{user.public_metadata.vibase_role}}"}, keeping existing claims; confirmed at the first sign-in (GET /meta/v1/me shows role: owner)')

    // C4 (D20, D32): the union, never removing.
    const inst = await clerk.bapi('GET', '/v1/instance')
    if (!ok(inst)) set('C4', 'fail', `could not read the instance (${refusal(inst)})`)
    else {
      const have = asList(inst.json?.allowed_origins)
      const missing = opts.origins.filter((o) => !have.includes(o))
      const extra = have.filter((o) => !opts.origins.includes(o))
      const note = extra.length ? `; extra (left alone): ${extra.join(', ')}` : ''
      if (missing.length === 0) set('C4', 'ok', `${opts.origins.length} allowed origin(s) present${note}`)
      else if (opts.dryRun) set('C4', 'update', `would add ${missing.join(', ')}${note}`)
      else {
        const w = await clerk.bapi('PATCH', '/v1/instance', { allowed_origins: [...have, ...missing] })
        set('C4', ok(w) ? 'update' : 'fail', ok(w) ? `added ${missing.join(', ')}${note}` : `could not set allowed origins (${refusal(w)})`)
      }
    }

    // C6, C7, C9 (D16, D30, D31): one GET, at most one PATCH of the differing fields. `--no-dcr` never turns registration on.
    const st = await clerk.bapi('GET', '/v1/instance/oauth_application_settings')
    if (!ok(st)) for (const id of ['C6', 'C7', 'C9']) set(id, 'fail', `could not read the OAuth application settings (${refusal(st)})`)
    else {
      const s = st.json ?? {}
      const diff: Record<string, unknown> = {}
      if (!opts.noDcr && s.dynamic_oauth_client_registration !== true) diff.dynamic_oauth_client_registration = true
      if (!sameSet(asList(s.default_scopes), scopes.defaults)) diff.default_scopes = scopes.defaults
      if (s.oauth_jwt_access_tokens !== true) diff.oauth_jwt_access_tokens = true
      let wrote: Reply | null = null
      if (Object.keys(diff).length > 0 && !opts.dryRun) wrote = await clerk.bapi('PATCH', '/v1/instance/oauth_application_settings', diff)
      const rowOf = (id: string, field: string, what: string) => {
        if (id === 'C6' && opts.noDcr) return set(id, 'ok', `${what}: left as is (--no-dcr), currently ${s.dynamic_oauth_client_registration === true ? 'on' : 'off'}`)
        if (!(field in diff)) return set(id, 'ok', `${what} as desired`)
        if (wrote && !ok(wrote)) return set(id, 'fail', `${what}: could not set (${refusal(wrote)})`)
        set(id, 'update', `${opts.dryRun ? 'would set' : 'set'} ${what}`)
      }
      rowOf('C6', 'dynamic_oauth_client_registration', 'dynamic client registration on')
      rowOf('C7', 'default_scopes', `default scopes for DCR clients (${scopes.defaults.length} read scopes)`)
      rowOf('C9', 'oauth_jwt_access_tokens', 'JWT access tokens')
      if (Array.isArray(s.dynamic_client_allowed_scopes)) rows.get('C7')!.detail += `; DCR scope ceiling left as is (${asList(s.dynamic_client_allowed_scopes).length} scope(s))`
    }

    // C8 (D15, D29, D31) and C5 (D29).
    let wrote8: 'none' | 'ok' | 'catalog' | 'device' | 'other' = 'none'
    const apps = await listApps(clerk)
    if (apps === null) set('C8', 'fail', 'could not list the OAuth applications')
    else {
      const configured = configuredCliClientId(ctx.deps.readConfigText(), opts.env)
      const byId = configured ? apps.find((a) => a.client_id === configured) : undefined
      const byName = apps.filter((a) => a.name === CLI_APP_NAME)
      const found = byId ? [byId] : byName
      const want = { public: true, device_authorization_grant_enabled: true, consent_screen_enabled: true }
      if (found.length > 1) set('C8', 'fail', `${found.length} applications named ${CLI_APP_NAME} and no configured AUTH_CLI_CLIENT_ID: ${found.map((a) => `${a.id} (${a.client_id})`).join(', ')}`, ['Delete the extra applications in Dashboard → OAuth applications, or set AUTH_CLI_CLIENT_ID in wrangler.jsonc to the one to keep'])
      else {
        const app = found[0]
        const body: Record<string, unknown> = app ? {} : { name: CLI_APP_NAME, ...want, scopes: scopes.cli.join(' ') }
        if (app) {
          for (const [k, v] of Object.entries(want)) if ((app as unknown as Record<string, unknown>)[k] !== v) body[k] = v
          if (!sameSet(String(app.scopes ?? '').split(' ').filter(Boolean), scopes.cli)) body.scopes = scopes.cli.join(' ')
        }
        if (app) ctx.cliClientId = app.client_id
        if (app && Object.keys(body).length === 0) set('C8', 'ok', `${CLI_APP_NAME} ${app.client_id} as desired`)
        else if (opts.dryRun) set('C8', app ? 'update' : 'create', `would ${app ? `update ${CLI_APP_NAME} ${app.client_id} (${Object.keys(body).join(', ')})` : `create ${CLI_APP_NAME}`}`)
        else {
          const w = app ? await clerk.bapi('PATCH', `/v1/oauth_applications/${q(app.id)}`, body) : await clerk.bapi('POST', '/v1/oauth_applications', body)
          if (ok(w)) {
            ctx.cliClientId = String(w.json?.client_id ?? app?.client_id)
            wrote8 = 'ok'
            set('C8', app ? 'update' : 'create', `${app ? 'updated' : 'created'} ${CLI_APP_NAME} ${ctx.cliClientId}`)
          } else {
            const text = JSON.stringify(w.json ?? {}).toLowerCase()
            wrote8 = text.includes('device') ? 'device' : text.includes('scope') ? 'catalog' : 'other'
            if (wrote8 === 'device') set('C8', 'fail', `Clerk refused the device authorization grant (${refusal(w)})`, ['The device grant needs the new OAuth IdP and a reachable device verification page (served on the Account Portal domain)', ...(prod ? ['Dashboard → Domains: finish the Account Portal DNS records'] : [])])
            else set('C8', 'fail', `${app ? 'update' : 'create'} ${CLI_APP_NAME} refused (${refusal(w)})${wrote8 === 'catalog' ? ': see C5' : ''}`)
          }
        }
      }
      // C5: Clerk validates custom scope keys against the catalog on C8's write; a dry run can only read the advertised ones.
      const catalogFix = ['Dashboard → OAuth applications → Scopes: add each of these custom scopes (key, description):', ...scopes.checklist]
      if (wrote8 === 'catalog') set('C5', 'fail', 'Clerk refused the scopes: some declared scope is not in the OAuth scope catalog', catalogFix)
      else if (wrote8 === 'ok' || (!opts.dryRun && rows.get('C8')?.status === 'ok')) set('C5', 'ok', 'every declared scope is accepted by the OAuth scope catalog')
      else {
        const meta = issuerOk ? await clerk.issuer('/.well-known/oauth-authorization-server').catch(() => null) : null
        const listed = meta && ok(meta) ? asList(meta.json?.scopes_supported) : null
        const absent = listed ? scopes.declared.map(toProviderScope).filter((s) => !listed.includes(s)) : null
        if (absent && absent.length === 0) set('C5', 'ok', 'every declared scope is listed in scopes_supported')
        else set('C5', 'manual', `unverified: ${absent ? `${absent.length} declared scope(s) are not advertised in scopes_supported (advertised is not the same as missing)` : 'scopes_supported could not be read'}; a real run checks it through the application write`, catalogFix)
      }
    }

    // C10 (D17, D38): the first owner.
    await ownerRow(ctx, clerk, set)
  }

  set('sign-in', 'manual', prod ? 'sign-in methods (Google, email code): configure in the dashboard; production social sign-in needs your own OAuth client credentials' : 'sign-in methods (Google, email code): configure in the dashboard')
  const order = ['instance', 'domain', 'C1', 'C2', 'C3', 'C4', 'C5', 'C6', 'C7', 'C8', 'C9', 'C10', 'sign-in']
  const list = order.flatMap((id) => rows.get(id) ?? [])
  const lines = list.flatMap((r) => [`${r.id.padEnd(8)}${r.status.padEnd(8)}${r.detail}`, ...(r.status === 'ok' || !r.fix ? [] : r.fix.map((f) => `${''.padEnd(16)}${f}`))])
  const manual = list.filter((r) => r.status === 'manual').map((r) => `${r.id}: ${r.detail}`)
  ctx.manualRows = manual
  const failed = list.filter((r) => r.status === 'fail').map((r) => r.id)
  const status: Status = failed.length > 0 ? 'fail' : list.some((r) => r.status === 'create') ? 'create' : list.some((r) => r.status === 'update') ? 'update' : 'ok'
  const detail = failed.length > 0 ? `${failed.join(', ')} need attention (checklist below); nothing after this step ran` : status === 'ok' ? `${keys.kind} instance ${keys.issuer} is as desired` : `${opts.dryRun ? 'would configure' : 'configured'} ${keys.kind} instance ${keys.issuer}`
  return { step: 'clerk', status, detail, lines, ...(manual.length ? { manual } : {}) }
}

interface App {
  id: string
  name: string
  client_id: string
  scopes?: string
  public?: boolean
  device_authorization_grant_enabled?: boolean
  consent_screen_enabled?: boolean
}
/** Every OAuth application, paged. */
async function listApps(clerk: Clerk): Promise<App[] | null> {
  const all: App[] = []
  for (let offset = 0; offset < 10_000; offset += 100) {
    const r = await clerk.bapi('GET', `/v1/oauth_applications?limit=100&offset=${offset}`)
    if (!ok(r)) return null
    const page: App[] = Array.isArray(r.json) ? r.json : (r.json?.data ?? [])
    all.push(...page)
    if (page.length < 100) return all
  }
  return all
}

/** C10: an invitation carrying `vibase_role: owner`, or the role on the existing user; an existing role is never changed. */
async function ownerRow(ctx: Ctx, clerk: Clerk, set: (id: string, s: RowStatus, d: string, fix?: string[]) => void): Promise<void> {
  const email = ctx.opts.ownerEmail!
  const wanted = email.toLowerCase()
  const users = await clerk.bapi('GET', `/v1/users?email_address=${q(email)}`)
  if (!ok(users)) return set('C10', 'fail', `could not look up ${email} (${refusal(users)})`)
  const user = (Array.isArray(users.json) ? users.json : []).find((u: { email_addresses?: { email_address?: string }[] }) => (u.email_addresses ?? []).some((e) => e.email_address?.toLowerCase() === wanted))
  if (user) {
    const role = user.public_metadata?.[ROLE]
    if (role === 'owner') return set('C10', 'ok', `${email} is the owner`)
    if (role !== undefined && role !== null && role !== '') return set('C10', 'fail', `${email} already has the role ${String(role)}; setup never changes an existing role`, [`Set public_metadata.${ROLE} to "owner" for ${email} in Dashboard → Users, or use another --owner-email`])
    if (ctx.opts.dryRun) return set('C10', 'update', `would set ${ROLE} owner on the existing user ${email}`)
    const w = await clerk.bapi('PATCH', `/v1/users/${q(user.id)}/metadata`, { public_metadata: { [ROLE]: 'owner' } })
    return set('C10', ok(w) ? 'update' : 'fail', ok(w) ? `set ${ROLE} owner on the existing user ${email}` : `could not set the role on ${email} (${refusal(w)})`)
  }
  const inv = await clerk.bapi('GET', `/v1/invitations?status=pending&query=${q(email)}`)
  if (!ok(inv)) return set('C10', 'fail', `could not list invitations (${refusal(inv)})`)
  const pending = (Array.isArray(inv.json) ? inv.json : (inv.json?.data ?? [])).find((i: { email_address?: string; status?: string }) => i.email_address?.toLowerCase() === wanted && (i.status === undefined || i.status === 'pending'))
  if (pending) return set('C10', 'ok', `an invitation for ${email} is pending (${pending.id})`)
  if (ctx.opts.dryRun) return set('C10', 'create', `would invite ${email} as owner`)
  const w = await clerk.bapi('POST', '/v1/invitations', { email_address: email, public_metadata: { [ROLE]: 'owner' }, notify: true })
  set('C10', ok(w) ? 'create' : 'fail', ok(w) ? `invited ${email} as owner (invitation ${String(w.json?.id)}; Clerk emails the link)` : `could not invite ${email} (${refusal(w)})`)
}
