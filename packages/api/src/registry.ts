import { z } from 'zod'
import type { Actor } from './auth/types.js'
import { formatScope, type Scope, type ScopeSet } from './scopes.js'
import type { PreparedOperation } from '@vault/storage'
import type { ObjectStore } from './objects/store.js'
import type { PreparedEnv, PreparedResource } from './storage/definition.js'
import { createOperation, deleteOperation, getOperation, listOperation, updateOperation } from './storage/crud.js'
import { crudActions, resourcePath, scopeResourceOf, type CrudAction } from './resources/define.js'

export type HttpMethod = 'get' | 'post' | 'patch' | 'delete'
/** What a binary operation's object stage returns ([[CORE58]] P8, P10): the app turns it into the response. */
export interface BinaryBody {
  body: ReadableStream<Uint8Array>
  size: number
  contentType: string
  filename: string
}
export type OperationInput = { params: Record<string, unknown>; query: Record<string, unknown>; body: unknown }
interface OperationBase {
  name: string
  summary: string
  description?: string
  tags?: string[]
  method: HttpMethod
  path: string
  request?: { params?: z.ZodObject; query?: z.ZodObject; body?: z.ZodType }
  validation?: 'adapter' | 'handler'
  response: { status: 200 | 201 | 204; schema?: z.ZodType }
  /** `binary` responds with a `BinaryBody` from the `objects` stage; default `json`. */
  output?: 'json' | 'binary'
}
/**
 * The one tenant operation shape ([[CORE36]] D16): the operation builds a bounded program from the trusted environment and
 * the request input, and the storage binding runs it. `prepare` may be async (it can hash a secret).
 */
export interface TenantOperation extends OperationBase {
  kind: 'tenant'
  scope: Scope
  prepare: (env: PreparedEnv, input: OperationInput) => PreparedOperation<unknown> | Promise<PreparedOperation<unknown>>
  /**
   * The object stage ([[CORE25]] D52): runs after the read unit with the unit's value and the composition's store, so a
   * unit never calls R2. Its return is the response (JSON) or a `BinaryBody` (binary).
   */
  objects?: (value: unknown, store: ObjectStore) => Promise<unknown>
}
/**
 * What an account operation sees ([[CORE41]] C2, P12): the signed-in user, the active organisation and its scopes when
 * there is one (null and empty otherwise), and the unit's clock. Account operations are read-only prepared programs run
 * with an `account` storage identity; a write would be an internal unit with an explicit organisation instead.
 */
export interface AccountEnv {
  readonly actor: Actor
  readonly organizationId: string | null
  readonly scopes: ScopeSet
  readonly now: Date
}
export interface AccountOperation extends OperationBase {
  kind: 'account'
  prepare: (env: AccountEnv, input: OperationInput) => PreparedOperation<unknown>
}
export type Operation = TenantOperation | AccountOperation
export type AnyResource = PreparedResource<any, any>

const OP_NAME = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/
const TOOL_NAME = /^[a-z0-9_]{1,64}$/

export class Registry {
  private readonly ops: Operation[] = []
  private readonly defs: AnyResource[] = []

  /** Validates at load: a bad operation is a programming mistake (plain Error). */
  register(op: Operation): this {
    if (!OP_NAME.test(op.name)) throw new Error(`invalid operation name "${op.name}"`)
    if (!TOOL_NAME.test(toolName(op.name))) throw new Error(`invalid tool name for operation ${op.name}`)
    if (!op.summary || op.summary.trim() === '') throw new Error(`operation ${op.name} needs a summary`)
    if (this.ops.some((o) => o.name === op.name)) throw new Error(`duplicate operation ${op.name}`)
    if (this.ops.some((o) => o.method === op.method && o.path === op.path)) {
      throw new Error(`duplicate route ${op.method.toUpperCase()} ${op.path}`)
    }
    const binary = op.output === 'binary'
    if (binary) {
      if (op.response.schema !== undefined) throw new Error(`operation ${op.name}: a binary operation has no response schema`)
      if (op.response.status !== 200) throw new Error(`operation ${op.name}: a binary operation responds 200`)
      if (op.kind !== 'tenant' || !op.objects) throw new Error(`operation ${op.name}: a binary operation needs an objects stage`)
    } else if (op.response.status === 204 ? op.response.schema !== undefined : op.response.schema === undefined) {
      throw new Error(`operation ${op.name}: response schema is required unless 204 or binary, and forbidden on 204`)
    }
    if (op.kind === 'tenant' && op.objects && op.response.status === 204) throw new Error(`operation ${op.name}: an objects stage needs a response body`)
    const params = op.request?.params
    if (params) {
      for (const m of op.path.matchAll(/\{(\w+)\}/g)) {
        if (!(m[1]! in params.shape)) throw new Error(`operation ${op.name}: path parameter {${m[1]}} is not declared`)
      }
    }
    this.ops.push(op)
    return this
  }

  registerResource(def: AnyResource): this {
    for (const op of resourceOperations(def)) this.register(op)
    this.defs.push(def)
    return this
  }

  operations(): readonly Operation[] {
    return this.ops
  }

  resources(): readonly AnyResource[] {
    return this.defs
  }

  get(name: string): Operation | undefined {
    return this.ops.find((o) => o.name === name)
  }

  /** Every scope a tenant operation requires, formatted, sorted and unique. */
  declaredScopes(): string[] {
    const out = new Set<string>()
    for (const op of this.ops) if (op.kind === 'tenant') out.add(formatScope(op.scope))
    return [...out].sort()
  }
}

/** The MCP/CLI-safe name derived from a dotted operation name. */
export const toolName = (name: string): string => name.replaceAll('.', '_')

/** The generic CRUD operations of a definition, in CRUD_ACTIONS order, for the actions it generates. */
export function resourceOperations(def: PreparedResource<any, any>): TenantOperation[] {
  const p = resourcePath(def)
  const s = scopeResourceOf(def)
  const actions = new Set<CrudAction>(crudActions(def))
  const idParams = z.object({ id: z.uuid() })
  const rec: z.ZodType = def.record
  const base = { kind: 'tenant' as const, validation: 'handler' as const, tags: [def.name] }
  const ops: TenantOperation[] = []
  if (actions.has('list')) {
    const query: Record<string, z.ZodType> = { after: z.uuid().optional(), limit: z.coerce.number().int().min(1).max(200).optional() }
    for (const [key, f] of Object.entries({ ...(def.filters ?? {}), ...(def.joinFilters ?? {}) })) query[key] = (f as { schema: z.ZodType }).schema.optional()
    ops.push({
      ...base,
      name: `${def.name}.list`,
      summary: `List ${def.name}`,
      method: 'get',
      path: p,
      scope: { resource: s, action: 'read' },
      request: { query: z.object(query) },
      response: { status: 200, schema: z.object({ data: z.array(rec), next_cursor: z.uuid().nullable() }) },
      prepare: (env, input) => {
        const { after, limit, ...filters } = input.query
        const raw = { after, limit, filters: filters as Record<string, string> }
        return def.override?.list ? def.override.list(env, raw) : listOperation(def, env, raw)
      },
    })
  }
  if (actions.has('get')) {
    ops.push({
      ...base,
      name: `${def.name}.get`,
      summary: `Get a ${def.eventName}`,
      method: 'get',
      path: `${p}/{id}`,
      scope: { resource: s, action: 'read' },
      request: { params: idParams },
      response: { status: 200, schema: rec },
      prepare: (env, input) => (def.override?.get ? def.override.get(env, input.params.id) : getOperation(def, env, input.params.id as string)),
    })
  }
  if (actions.has('create')) {
    ops.push({
      ...base,
      name: `${def.name}.create`,
      summary: `Create a ${def.eventName}`,
      method: 'post',
      path: p,
      scope: { resource: s, action: 'write' },
      request: { body: def.create },
      response: { status: 201, schema: rec },
      prepare: (env, input) => (def.override?.create ? def.override.create(env, input.body) : createOperation(def, env, input.body)),
    })
  }
  if (actions.has('update')) {
    ops.push({
      ...base,
      name: `${def.name}.update`,
      summary: `Update a ${def.eventName}`,
      method: 'patch',
      path: `${p}/{id}`,
      scope: { resource: s, action: 'write' },
      request: { params: idParams, body: def.update },
      response: { status: 200, schema: rec },
      prepare: (env, input) =>
        def.override?.update
          ? def.override.update(env, { id: input.params.id, body: input.body })
          : updateOperation(def, env, input.params.id as string, input.body),
    })
  }
  if (actions.has('delete')) {
    ops.push({
      ...base,
      name: `${def.name}.delete`,
      summary: `Delete a ${def.eventName}`,
      method: 'delete',
      path: `${p}/{id}`,
      scope: { resource: s, action: 'write' },
      request: { params: idParams },
      response: { status: 204 },
      prepare: (env, input) => (def.override?.delete ? def.override.delete(env, input.params.id) : deleteOperation(def, env, input.params.id as string)),
    })
  }
  return ops
}
