import { z } from 'zod'
import type { AccountContext, ServiceContext } from './context.js'
import { formatScope, type Scope } from './scopes.js'
import type { PreparedOperation } from '@vault/storage'
import { isPrepared, type PreparedEnv, type PreparedResource } from './storage/definition.js'
import { createOperation, deleteOperation, getOperation, listOperation, updateOperation } from './storage/crud.js'
import { createResource, deleteResource, getResource, listResource, updateResource } from './resources/crud.js'
import {
  crudActions,
  resourcePath,
  scopeResourceOf,
  type CrudAction,
  type ResourceDefinition,
} from './resources/define.js'

export type HttpMethod = 'get' | 'post' | 'patch' | 'delete'
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
}
interface TenantOperationBase extends OperationBase {
  kind: 'tenant'
  scope: Scope
}
/** The legacy interactive path (a Kysely transaction in `ServiceContext`). */
export interface LegacyTenantOperation extends TenantOperationBase {
  executor?: 'legacy'
  handler: (ctx: ServiceContext, input: OperationInput) => Promise<unknown>
}
/**
 * The prepared path ([[CORE35]] C5): the operation builds a bounded program and the storage binding runs it.
 * A prepared operation is never wrapped in a legacy transaction.
 * TEMPORARY SEAM: this marker, the legacy variant and `withContext` for tenant operations are removed in
 * [[CORE37]] once every operation is prepared (spec "Migration seam"; recorded in RESULT.md).
 */
export interface PreparedTenantOperation extends TenantOperationBase {
  executor: 'prepared'
  prepare: (env: PreparedEnv, input: OperationInput) => PreparedOperation<unknown> | Promise<PreparedOperation<unknown>>
}
export type TenantOperation = LegacyTenantOperation | PreparedTenantOperation
export interface AccountOperation extends OperationBase {
  kind: 'account'
  handler: (ctx: AccountContext, input: OperationInput) => Promise<unknown>
}
export type Operation = TenantOperation | AccountOperation
export type AnyResource = ResourceDefinition<any> | PreparedResource<any, any>

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
    if (op.response.status === 204 ? op.response.schema !== undefined : op.response.schema === undefined) {
      throw new Error(`operation ${op.name}: response schema is required unless 204, and forbidden on 204`)
    }
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
    for (const op of isPrepared(def) ? preparedResourceOperations(def) : resourceOperations(def)) this.register(op)
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

/** The generic CRUD operations of a definition, in CRUD_ACTIONS order, for the actions it generates. */
export function resourceOperations(def: ResourceDefinition<any>): LegacyTenantOperation[] {
  const p = resourcePath(def)
  const s = scopeResourceOf(def)
  const actions = new Set<CrudAction>(crudActions(def))
  const idParams = z.object({ id: z.uuid() })
  const rec = def.record
  const base = { kind: 'tenant' as const, validation: 'handler' as const, tags: [def.name] }
  const ops: LegacyTenantOperation[] = []

  if (actions.has('list')) {
    const query: Record<string, z.ZodType> = { after: z.uuid().optional(), limit: z.coerce.number().int().min(1).max(200).optional() }
    for (const [key, f] of Object.entries(def.filters ?? {})) query[key] = f.schema.optional()
    ops.push({
      ...base,
      name: `${def.name}.list`,
      summary: `List ${def.name}`,
      method: 'get',
      path: p,
      scope: { resource: s, action: 'read' },
      request: { query: z.object(query) },
      response: { status: 200, schema: z.object({ data: z.array(rec), next_cursor: z.uuid().nullable() }) },
      handler: (ctx, input) => {
        const { after, limit, ...filters } = input.query
        return listResource(ctx, def, { after, limit, filters: filters as Record<string, string> })
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
      handler: (ctx, input) => getResource(ctx, def, input.params.id as string),
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
      handler: (ctx, input) => createResource(ctx, def, input.body),
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
      handler: (ctx, input) => updateResource(ctx, def, input.params.id as string, input.body),
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
      handler: async (ctx, input) => {
        await deleteResource(ctx, def, input.params.id as string)
        return undefined
      },
    })
  }
  return ops
}

/** The MCP/CLI-safe name derived from a dotted operation name. */
export const toolName = (name: string): string => name.replaceAll('.', '_')

/** The same operations, served by the prepared executor. Paths, scopes, schemas and statuses are identical. */
export function preparedResourceOperations(def: PreparedResource<any, any>): PreparedTenantOperation[] {
  const p = resourcePath(def)
  const s = scopeResourceOf(def)
  const actions = new Set<CrudAction>(crudActions(def))
  const idParams = z.object({ id: z.uuid() })
  const rec: z.ZodType = def.record
  const base = { kind: 'tenant' as const, executor: 'prepared' as const, validation: 'handler' as const, tags: [def.name] }
  const ops: PreparedTenantOperation[] = []
  if (actions.has('list')) {
    const query: Record<string, z.ZodType> = { after: z.uuid().optional(), limit: z.coerce.number().int().min(1).max(200).optional() }
    for (const [key, f] of Object.entries(def.filters ?? {})) query[key] = (f as { schema: z.ZodType }).schema.optional()
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
