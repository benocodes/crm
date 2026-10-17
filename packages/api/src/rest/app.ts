import { OpenAPIHono } from '@hono/zod-openapi'
import type { Context } from 'hono'
import type { Kysely } from 'kysely'
import type { Database } from '@vault/db'
import { authMiddleware } from '../auth/middleware.js'
import type { Principal, UserAuthenticator } from '../auth/types.js'
import { withAccountContext, withContext } from '../context.js'
import { ApiError, } from '../errors.js'
import { createVaultRegistry } from '../operations.js'
import type { Operation, OperationInput, Registry } from '../registry.js'
import { parseInput } from '../resources/define.js'
import { formatScope } from '../scopes.js'
import { renderError, renderNotFound } from './errors.js'
import { documentOperation, honoPath, registerSecurityScheme } from './openapi.js'

export type AppEnv = { Variables: { db: Kysely<Database>; principal: Principal } }
export interface AppOptions {
  /** Resolves the request's database. Called once per request, never at construction. */
  db: (c: Context) => Kysely<Database>
  registry?: Registry
  /** [[CORE3]]: absent means JWT-shaped tokens are 401. */
  userAuthenticator?: UserAuthenticator
  /** `info.version` in the document. */
  version?: string
}

async function readInput(c: Context<AppEnv>, op: Operation): Promise<OperationInput> {
  let params: Record<string, unknown> = c.req.param()
  let query: Record<string, unknown> = c.req.query()
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
  if (op.validation === 'adapter') {
    if (op.request?.params) params = parseInput(op.request.params, params)
    if (op.request?.query) query = parseInput(op.request.query, query)
    if (op.request?.body) body = parseInput(op.request.body, body)
  }
  return { params, query, body }
}

async function run(c: Context<AppEnv>, op: Operation): Promise<unknown> {
  const input = await readInput(c, op)
  const principal = c.var.principal
  if (op.kind === 'account') {
    if (principal.actor.kind !== 'user') {
      throw new ApiError(403, 'user_required', 'this operation requires a signed-in user')
    }
    return withAccountContext(c.var.db, { actor: principal.actor }, (ctx) => op.handler(ctx, input))
  }
  if (principal.organizationId === null) {
    throw new ApiError(403, 'organization_required', 'an organisation is required (send X-Organization-Id)')
  }
  if (!principal.scopes.has(op.scope)) {
    throw new ApiError(403, 'insufficient_scope', `requires ${formatScope(op.scope)}`)
  }
  const { actor, organizationId, scopes } = principal
  return withContext(c.var.db, { actor, organizationId, scopes }, (ctx) => op.handler(ctx, input))
}

export function createApp(options: AppOptions): OpenAPIHono<AppEnv> {
  const registry = options.registry ?? createVaultRegistry()
  const app = new OpenAPIHono<AppEnv>()
  app.onError(renderError)
  app.notFound(renderNotFound)
  app.use('*', async (c, next) => {
    c.set('db', options.db(c))
    await next()
  })

  registerSecurityScheme(app)
  const auth = authMiddleware({ userAuthenticator: options.userAuthenticator })
  for (const op of registry.operations()) {
    documentOperation(app, op)
    app.on(op.method.toUpperCase(), honoPath(op.path), auth, async (c) => {
      const result = await run(c, op)
      if (op.response.status === 204) return c.body(null, 204)
      return c.json(result as never, op.response.status)
    })
  }

  app.get('/openapi.json', (c) =>
    c.json(
      app.getOpenAPI31Document({
        openapi: '3.1.0',
        info: { title: 'Vault API', version: options.version ?? '0.0.0-dev' },
      }),
    ),
  )
  return app
}
