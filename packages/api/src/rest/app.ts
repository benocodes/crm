import { OpenAPIHono } from '@hono/zod-openapi'
import type { Context } from 'hono'
import { cors } from 'hono/cors'
import { UnitDriftError, execute, uuidv7, type StorageBinding } from '@vibase/storage'
import type { AuthAdapter } from '../auth/adapter.js'
import { mcpChallenge, resourceMetadataChallenge } from '../discovery.js'
import { authMiddleware } from '../auth/middleware.js'
import type { Principal, UserAuthenticator } from '../auth/types.js'
import { createUserAuthenticator } from '../auth/user-authenticator.js'
import { createProfileCache, createWorkspaceAuthenticator, workspaceRole } from '../auth/workspace-authenticator.js'
import { SCOPE_POLICY, type Role, type ScopePolicy } from '../auth/roles.js'
import { googleCallbackHandler } from '../connections/callback.js'
import type { MailSyncInstances } from '../sync/request.js'
import { gmailConfigNotice, gmailUnconfigured, type GmailConfig, type PushConfig } from '../connections/config.js'
import { PUSH_PATH, gmailPushHandler } from '../channels/gmail/push.js'
import { CALLBACK_PATH } from '../connections/operations.js'
import { GOOGLE_ENDPOINTS, type GoogleEndpoints } from '../connections/google.js'
import { clerkWebhookHandler } from '../directory/webhook.js'
import { ApiError, mapStorageError } from '../errors.js'
import { createVibaseRegistry } from '../operations.js'
import { webhooksConfigNotice, type WebhooksRuntime } from '../webhooks/config.js'
import type { ObjectStore } from '../objects/store.js'
import { validateOperationInput, type BinaryBody, type Operation, type OperationInput, type PrepareContext, type Registry } from '../registry.js'
import { proposalHint } from '../proposal.js'
import { hydrateSendRecord,requireSendStore } from '../messaging/send-body.js'
import { runExecution } from '../executions/runner.js'
import type { TransportRegistry } from '../executions/transport.js'
import { parseInput } from '../resources/define.js'
import { ScopeSet, formatScope } from '../scopes.js'
import { internalEnv } from '../storage/internal.js'
import { renderError, renderNotFound } from './errors.js'
import { contentDisposition } from './binary.js'
import { SURFACES, SURFACE_PREFIX, SURFACE_TITLE, fullPath, openApiPath } from '../surfaces.js'
import { MCP_PATH, mcpMethodNotAllowed, mcpPost } from '../mcp/handler.js'
import { documentOperation, honoPath, registerSecurityScheme } from './openapi.js'

/** The Gmail surface of an app ([[CHN5]] D58). `config` null is "unconfigured": the callback answers 404 and `connections.authorize` 501. */
export interface GmailAppOptions {
  config: GmailConfig | null
  /** From `parseGmailConfig`: the variables that are missing or malformed (named in a startup log line, never their values). */
  problems?: readonly string[]
  /** Google's endpoints; default the real ones. Injected in tests and the workerd smoke. */
  endpoints?: GoogleEndpoints
  /** The `fetch` every Google and Gmail call uses; default the global one. */
  fetch?: typeof fetch
  /** The `users/me` base of the Gmail API; default Gmail's. */
  gmailBaseUrl?: string
  /** The role source of the callback's re-check ([[CHN5]] D33). Default: the workspace adapter's cached profile read ([[CORE77]] D12); none without a provider. */
  roleOf?: (authSubject: string) => Promise<Role | null>
  /** The scope policy the role re-check applies; default the vault's. */
  policy?: ScopePolicy
  /** The `MAIL_SYNC` Workflow binding ([[CHN141]] D75). Absent: `connections.sync` answers `501 provider_not_configured` and the callback requests no sync. */
  instances?: MailSyncInstances
  /** Push configuration from `parsePushConfig` ([[CHN5]] D87). Push is on only when this is set AND `config` and `instances` are too; otherwise `POST /gmail/push` answers 404 and no watch is registered. */
  push?: PushConfig | null
  /** The variables `parsePushConfig` found missing or malformed (names only), logged at startup. */
  pushProblems?: readonly string[]
}
export type AppEnv = { Variables: { principal: Principal; storage: StorageBinding } }
export interface AppOptions {
  /**
   * The storage binding for this request, chosen by trusted composition code, never by request input. Resolved once
   * per request, before auth, and reused by auth, the operation and the webhook handlers ([[CORE36]] D16).
   */
  storage: (c: Context) => StorageBinding
  registry?: Registry
  /** Custom or test setups. Absent (and no `authAdapter`) means JWT-shaped tokens are 401. */
  userAuthenticator?: UserAuthenticator
  /** [[CORE3]]: builds the real authenticator over this registry's declared scopes. Exclusive with `userAuthenticator`. */
  authAdapter?: AuthAdapter
  /**
   * A single-workspace composition (the D1 Worker, [[CORE64]] D24): the organisation is the deployment's, the role comes from the
   * token's claim, `/webhooks/clerk` is not mounted and `me.get` answers agents. `adapter` is the workspace adapter, absent when
   * the deployment is API-key only. Exclusive with `authAdapter` and `userAuthenticator`.
   */
  workspace?: { adapter?: AuthAdapter; /** The first-party CLI's OAuth client id ([[CORE77]] D14); unset: none. */ cliClientId?: string }
  /** Injected clock and id source for prepared units (tests and golden fixtures). Default: real time, UUIDv7. */
  clock?: () => Date
  newId?: () => string
  /** The random source of units that mint a secret (`api_keys.create`). Default: `crypto.getRandomValues` (CORE40 P8). */
  randomBytes?: (n: number) => Uint8Array
  /** Allowed CORS origins ([[CORE3]] C4). Empty or absent: no CORS middleware, no `Access-Control-*` header. */
  corsOrigins?: readonly string[]
  /** `info.version` in the document. */
  version?: string
  /** The Gmail connect surface ([[CHN5]] D9, D58). Absent: unconfigured. D1 only; the routes answer `501` on another engine. */
  gmail?: GmailAppOptions
  /**
   * [[AGT8]] D13, D49: the execution rail of this app. `transports` are the ones the runner resolves by name; the kick after an authorisation starts the runner
   * through `start` (default: the request's `waitUntil`). Absent: nothing starts after commit and the per-minute cron is the only entry.
   */
  executions?: { transports: TransportRegistry; start?: (run: () => Promise<unknown>) => void }
  /** [[API7]] D12, D13: the webhook configuration from `parseWebhooksConfig` (the credentials key, the insecure-URL switch) and its problems (names only, logged once). Absent: unconfigured; `create` and `rotate_secret` answer `501 webhooks_not_configured`. Ignored when `registry` is given. */
  webhooks?: { runtime: WebhooksRuntime; problems?: readonly string[] }
  /** Extra operations registered before the queue's (Node tests; see `createVibaseRegistry`). Ignored when `registry` is given. */
  extraOperations?: (registry: Registry) => void
  /** The object store of operations with an object stage ([[CORE25]] D52). Absent: those operations answer `503 objects_unavailable`. */
  objects?: ObjectStore
}

async function readInput(c: Context<AppEnv>, op: Operation): Promise<OperationInput> {
  const params: Record<string, unknown> = c.req.param()
  const origin = new URL(c.req.url).origin
  const query: Record<string, unknown> = c.req.query()
  // [[CORE129]] D10a (any repeated query parameter): a repeated query parameter is refused, never answered with whichever value the router keeps (the first).
  for (const [key, values] of Object.entries(c.req.queries())) {
    if (values.length > 1) throw new ApiError(400, 'validation_error', `query parameter "${key}" was given ${values.length} times; send it once`)
  }
  let body: unknown
  if (op.method === 'post' || op.method === 'patch') {
    const text = await c.req.text()
    if (text !== '') {
      try {
        body = JSON.parse(text)
      } catch {
        throw new ApiError(400, 'validation_error', 'request body is not valid JSON')
      }
    }
  }
  return { params, query, body, origin }
}

type Injected = Pick<AppOptions, 'clock' | 'newId' | 'randomBytes' | 'objects' | 'workspace' | 'executions'> & { registry: Registry }

const run = async (c: Context<AppEnv>, op: Operation, injected: Injected): Promise<unknown> => executeOperation(c, op, await readInput(c, op), injected)

/**
 * The after-commit kick of the execution rail ([[AGT8]] D13, D49): starts the runner on one execution, best effort. A kick that throws, is dropped by the
 * runtime or finds no execution context changes nothing the caller was told: the execution stays queued and the per-minute cron runs it.
 */
function kickRunner(c: Context<AppEnv>, injected: Injected, executionId: string): void {
  const rail = injected.executions
  if (!rail || c.var.storage.kind !== 'd1') return
  const clock = injected.clock ?? (() => new Date())
  const deps = { binding: c.var.storage, registry: injected.registry, transports: rail.transports, clock, newId: () => uuidv7(clock()) }
  const run = () =>
    runExecution(deps, executionId).then(
      () => undefined,
      (err) => console.error(`[rail] execution ${executionId} failed to run: ${err instanceof Error ? err.name : 'error'}`),
    )
  try {
    if (rail.start) rail.start(run)
    else c.executionCtx.waitUntil(run())
  } catch {
    // No execution context, or the runtime refused: the cron is the guarantee.
  }
}

/**
 * The executor both REST and MCP `tools/call` run ([[API106]] D12): scope checks, the account-operation rule, `prepare`, the storage
 * unit, events and error mapping. `input` is already read; adapter-validated operations are validated first, as REST does.
 */
async function executeOperation(c: Context<AppEnv>, op: Operation, rawInput: OperationInput, injected: Injected): Promise<unknown> {
  const input = validateOperationInput(op, rawInput)
  const principal = c.var.principal
  if (op.kind === 'account') {
    if (principal.actor.kind !== 'user' && !(op.agents && injected.workspace)) {
      throw new ApiError(403, 'user_required', 'this operation requires a signed-in user')
    }
    const storage = c.var.storage
    // Scopes only mean something inside an organisation; an unusable claim or a contradicted header is no organisation here.
    const organizationId = principal.organizationForbidden ? null : principal.organizationId
    const env = {
      actor: principal.actor,
      organizationId,
      scopes: organizationId === null ? ScopeSet.parse([]) : principal.scopes,
      now: (injected.clock ?? (() => new Date()))(),
      ...(injected.workspace ? { workspace: { role: principal.actor.kind === 'user' ? (principal.role ?? null) : null, clientId: principal.clientId ?? null } } : {}),
    }
    try {
      return (await execute(storage, { kind: 'account', actorId: principal.actor.id }, op.prepare(env, input))).value
    } catch (err) {
      throw mapStorageError(err)
    }
  }
  if (principal.organizationForbidden) {
    throw new ApiError(403, 'organization_forbidden', 'not a member of that organisation')
  }
  if (principal.organizationId === null) {
    throw new ApiError(403, 'organization_required', 'an organisation is required (sign in with an active organisation)')
  }
  const { actor, organizationId, scopes } = principal
  const storage = c.var.storage
  const clock = injected.clock ?? (() => new Date())
  const now = clock()
  const env = {
    actor,
    ...(injected.objects ? { objects: injected.objects } : {}),
    organizationId,
    scopes,
    now,
    newId: injected.newId ?? (() => uuidv7(now)),
    randomBytes: injected.randomBytes ?? ((n: number) => crypto.getRandomValues(new Uint8Array(n))),
  }
  if (op.scope !== null && !scopes.has(op.scope)) {
    // The one refusal path of REST and MCP alike: a caller that can propose this call is told how ([[AGT8]] D42).
    const hint = await proposalHint(op, env, input)
    throw new ApiError(403, 'insufficient_scope', `requires ${formatScope(op.scope)}${hint ? `; ${hint}` : ''}`)
  }
  // [[CHN5]] D29: a D1-only operation on another engine is not implemented there; refused after the scope checks, before any unit runs.
  if (op.d1Only && c.var.storage.kind !== 'd1') throw new ApiError(501, 'not_implemented', 'this operation is implemented for D1 only')
  // D52: a composition without a store refuses before any unit runs; the scope checks above stay the first refusals.
  if (op.objects && !injected.objects) {
    throw new ApiError(503, 'objects_unavailable', 'object storage is not configured')
  }
  const identity = { kind: 'tenant', actorId: actor.id, organizationId } as const
  const ctx: PrepareContext = { read: async (program) => (await execute(storage, identity, program)).value }
  let value: unknown
  try {
    // `prepare` may be async (it can hash a secret) and may refuse with an ApiError: both map like a storage error.
    // [[AGT8]] D28: a decision command whose unit drifted is planned afresh and run once more; a second drift is `409 conflict`.
    const attempt = async () => (await execute(storage, identity, await op.prepare(env, input, ctx))).value
    try {
      value = await attempt()
    } catch (err) {
      if (!(op.replanOnDrift && err instanceof UnitDriftError)) throw err
      value = await attempt()
    }
  } catch (err) {
    throw mapStorageError(err)
  }
  // The after-commit stage ([[CHN141]]): outside the storage error mapping too; it throws the ApiError it means.
  if (op.after) value = await op.after(value, { kick: (executionId) => kickRunner(c, injected, executionId) })
  // AGT166: the existing post-read object seam, restricted to authored send gets. Other operation arguments retain their existing behavior.
  if ((op.name === 'action_requests.get' || op.name === 'action_executions.get') && (value as {operation?:string}).operation === 'messages.send') return hydrateSendRecord(value,requireSendStore(injected.objects))
  // The object stage runs after the unit, outside the storage error mapping: an ApiError propagates, anything else is masked.
  return op.objects ? op.objects(value, injected.objects!) : value
}

export function createApp(options: AppOptions): OpenAPIHono<AppEnv> {
  if ([options.authAdapter, options.userAuthenticator, options.workspace].filter(Boolean).length > 1) {
    throw new Error('createApp: pass only one of authAdapter, userAuthenticator and workspace')
  }
  const gmail = options.gmail
  const push: PushConfig | null = gmail?.config && gmail.instances && gmail.push ? gmail.push : null
  const registry = options.registry ?? createVibaseRegistry({ operations: options.extraOperations, ...(options.webhooks ? { webhooks: options.webhooks.runtime } : {}), connections: { config: gmail?.config ?? null, ...(gmail?.endpoints ? { endpoints: gmail.endpoints } : {}), ...(gmail?.instances ? { instances: gmail.instances } : {}), push, ...(gmail?.fetch ? { fetch: gmail.fetch } : {}), ...(gmail?.gmailBaseUrl ? { gmailBaseUrl: gmail.gmailBaseUrl } : {}) } })
  // [[CHN5]] D58: a partial configuration is a startup log line naming what is wrong; nothing configured at all is simply "off".
  if (gmail?.problems && gmail.problems.length > 0 && !gmailUnconfigured(gmail.problems)) console.warn(gmailConfigNotice(gmail.problems))
  if (options.webhooks?.problems && options.webhooks.problems.length > 0) console.warn(webhooksConfigNotice(options.webhooks.problems))
  if (gmail?.pushProblems && gmail.pushProblems.length > 0) console.warn(`[gmail] push is off: set or fix ${gmail.pushProblems.join(', ')}`)
  else if (gmail?.push && !push) console.warn(`[gmail] push is off: ${gmail.config ? 'the MAIL_SYNC binding is missing' : 'Gmail is not configured'}`)
  const profiles = options.workspace?.adapter ? createProfileCache(options.workspace.adapter) : null
  const userAuthenticator =
    options.userAuthenticator ??
    (options.authAdapter
      ? createUserAuthenticator({ adapter: options.authAdapter, declaredScopes: registry.declaredScopes() })
      : options.workspace?.adapter
        ? createWorkspaceAuthenticator({ adapter: options.workspace.adapter, declaredScopes: registry.declaredScopes(), cliClientId: options.workspace.cliClientId, profiles: profiles! })
        : undefined)
  const app = new OpenAPIHono<AppEnv>()
  app.onError(renderError)
  app.notFound(renderNotFound)
  const corsOrigins = options.corsOrigins ?? []
  // [[API106]] D20: the transport's DNS-rebinding rule. No Origin (server-side clients) passes; any Origin must be on the CORS list,
  // so an empty list refuses every browser. Before the CORS middleware, so a refused origin gets no CORS answer either.
  app.use(MCP_PATH, async (c, next) => {
    const origin = c.req.header('origin')
    if (origin !== undefined && !corsOrigins.includes(origin)) return c.json({ error: { code: 'origin_forbidden', message: 'this origin may not call the MCP endpoint' } }, 403)
    await next()
  })
  if (corsOrigins.length > 0) {
    app.use(
      '*',
      cors({
        origin: (origin) => (corsOrigins.includes(origin) ? origin : null),
        allowMethods: ['GET', 'POST', 'PATCH', 'DELETE'],
        allowHeaders: ['Authorization', 'X-Organization-Id', 'Content-Type', 'MCP-Protocol-Version'],
        exposeHeaders: ['WWW-Authenticate'],
        maxAge: 600,
      }),
    )
  }
  // [[CORE64]] D22: with a provider configured, every 401 points at the protected-resource metadata. A thrown ApiError is already
  // rendered by `onError` when control returns here.
  if (options.workspace?.adapter) {
    app.use('*', async (c, next) => {
      await next()
      if (c.res.status !== 401) return
      // [[API106]] D14: only the exact /mcp path carries the MCP challenge; every other path keeps [[CORE84]]'s.
      const url = new URL(c.req.url)
      c.res.headers.set('WWW-Authenticate', url.pathname === MCP_PATH ? mcpChallenge(url.origin, registry.declaredScopes()) : resourceMetadataChallenge(url.origin))
    })
  }
  app.use('*', async (c, next) => {
    c.set('storage', options.storage(c))
    await next()
  })

  registerSecurityScheme(app)
  const injected: Injected = { clock: options.clock, newId: options.newId, randomBytes: options.randomBytes, objects: options.objects, workspace: options.workspace, executions: options.executions, registry }
  const auth = authMiddleware({ userAuthenticator, env: () => internalEnv(options), declaredScopes: registry.declaredScopes() })
  for (const op of registry.operations()) {
    documentOperation(app, op)
    app.on(op.method.toUpperCase(), honoPath(fullPath(op)), auth, async (c) => {
      const result = await run(c, op, injected)
      if (op.response.status === 204) return c.body(null, 204)
      if (op.output === 'binary') {
        const file = result as BinaryBody
        return c.body(file.body, 200, {
          'content-type': file.contentType,
          'content-length': String(file.size),
          'content-disposition': contentDisposition(file.filename),
          'x-content-type-options': 'nosniff',
          'content-security-policy': 'sandbox',
        })
      }
      return c.json(result as never, op.response.status)
    })
  }

  // [[API106]] D1, D12: root machinery, not an operation. GET and DELETE answer 405 without a credential (there is no stream or session).
  app.post(
    MCP_PATH,
    auth,
    mcpPost({
      registry,
      version: options.version ?? '0.0.0-dev',
      workspace: options.workspace !== undefined,
      execute: (c, op, input) => executeOperation(c, op, input, injected),
    }),
  )
  app.all(MCP_PATH, mcpMethodNotAllowed)

  // [[CHN5]] D9: the Google OAuth callback. A plain route at the root: the browser carries no bearer token, the signed state is its credential.
  app.get(
    CALLBACK_PATH,
    googleCallbackHandler({
      config: gmail?.config ?? null,
      endpoints: gmail?.endpoints ?? GOOGLE_ENDPOINTS,
      fetch: gmail?.fetch ?? ((input, init) => fetch(input, init)),
      ...(gmail?.gmailBaseUrl ? { gmailBaseUrl: gmail.gmailBaseUrl } : {}),
      roleOf:
        gmail?.roleOf ??
        (profiles
          ? async (subject) => {
              const profile = await profiles.profileOf(subject, (options.clock ?? (() => new Date()))().getTime())
              return profile ? workspaceRole(profile.role) : null
            }
          : null),
      policy: gmail?.policy ?? SCOPE_POLICY,
      ...(gmail?.instances ? { instances: gmail.instances } : {}),
      push,
      declaredScopes: registry.declaredScopes(),
      storage: options.storage,
      clock: options.clock,
      newId: options.newId,
      randomBytes: options.randomBytes,
    }),
  )

  // [[CHN5]] D15, D87: Pub/Sub's push. A plain route at the root: its credential is the OIDC bearer token, checked first.
  app.post(
    PUSH_PATH,
    gmailPushHandler({ push, fetch: gmail?.fetch ?? ((input, init) => fetch(input, init)), ...(gmail?.instances ? { instances: gmail.instances } : {}), storage: options.storage, clock: options.clock, newId: options.newId }),
  )

  // Plain route, not an operation: the Svix signature is its only credential, and it is not documented.
  if (options.authAdapter) app.post('/webhooks/clerk', clerkWebhookHandler(options.authAdapter, { clock: options.clock, newId: options.newId }))

  // [[API32]] D4: one document per surface, unauthenticated; there is no root document (D5).
  for (const surface of SURFACES) {
    app.get(openApiPath(surface), (c) => {
      const all = app.getOpenAPI31Document({
        openapi: '3.1.0',
        info: { title: SURFACE_TITLE[surface], version: options.version ?? '0.0.0-dev' },
      }) as { paths?: Record<string, unknown> }
      const prefix = SURFACE_PREFIX[surface] + '/'
      const paths = Object.fromEntries(Object.entries(all.paths ?? {}).filter(([p]) => p.startsWith(prefix)))
      return c.json({ ...all, paths })
    })
  }
  return app
}
