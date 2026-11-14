import { z } from 'zod'
import type { Actor } from './auth/types.js'
import type { Role } from './auth/roles.js'
import { formatScope, type Scope, type ScopeSet } from './scopes.js'
import type { Expression, SqlBool } from 'kysely'
import type { PhysicalTable, PreparedOperation, QueryContext } from '@vibase/storage'
import type { ObjectStore } from './objects/store.js'
import { softDeletes, type PreparedEnv, type PreparedResource } from './storage/definition.js'
import { columnFilterParams } from './storage/column-filters.js'
import { aggregateAnswer, aggregateDescription, aggregateParams } from './storage/aggregate.js'
import { SORTED_NEXT, sortedQueryFields } from './storage/sort-params.js'
import { aggregateOperation, createOperation, deleteOperation, getOperation, listOperation, updateOperation } from './storage/crud.js'
import { endpointTypesOf, type EndpointTypes } from './associations/definition.js'
import { embeddedFields, getWithAssociations, includeQuery } from './associations/embed.js'
import { fullPath, type Surface } from './surfaces.js'
import { crudActions, parseInput, resourcePath, scopeResourceOf, type CrudAction } from './resources/define.js'

/**
 * [[AGT8]] D32: whether an operation may be the target of an action request. `eligible: true` may name the stored record an id-bearing
 * operation acts on (`target`: checked at proposal time, D34) and any read the call needs beyond its scope that only its arguments
 * show (`alsoRequires`, for discovery). `eligible: false` carries the reason a client is told (`400 operation_not_proposable`).
 */
export type ProposalDecl =
  | { eligible: true; target?: { table: PhysicalTable; idArg: string; notFound: string; live: boolean }; alsoRequires?: string }
  | { eligible: false; reason: string }
/** What `prepare` may call besides building: a read-only unit on the request's own storage identity ([[AGT8]] D28: plan reads before a decision command). */
export interface PrepareContext {
  read<T>(op: PreparedOperation<T>): Promise<T>
}

/** [[AGT8]] D2, D53: how a possibly delivered attempt is treated before it is repeated. `reconcile` (the default) asks the transport; `idempotent` repeats it; `never` gives up with `outcome_unknown`. */
export type RetryPolicy = 'reconcile' | 'idempotent' | 'never'
/** What an enqueued operation resolves at authorisation ([[AGT8]] D9, D52): fixed on the execution row and identical on every attempt. */
export interface Authorisation {
  /** An anchor, a connection: whatever the transport needs that was true when the call was authorised. */
  resolution?: Record<string, unknown>
  /** The domain of the execution's `client_ref` (`{execution_id}@{domain}`); default `vibase.invalid`. */
  clientRefDomain?: string
  /** Commit-time guards on what `resolution` rests on: false at commit and the authorisation writes nothing. */
  guards?: (qc: QueryContext) => Expression<SqlBool>[]
}
/**
 * [[AGT8]] D2, D51, D52, D57: an operation declared `execution: enqueued`. Called directly it answers `202` with an execution receipt; approved from a
 * request it creates the same execution; the runner then drives the transport. `input` is the operation's own arguments, without `idempotency_key`.
 */
export interface ExecutionDecl {
  retry?: RetryPolicy
  transport: string
  /** The scope that lets a caller read this operation's executions ([[AGT8]] D57). */
  readScope: Scope
  input: z.ZodObject
  authorise?: (env: PreparedEnv, args: Record<string, unknown>, ctx: PrepareContext) => Promise<Authorisation | void>
}
/** What an after-commit stage can ask of the composition: start the runner on an execution, best effort ([[AGT8]] D13, D49). */
export interface AfterContext {
  kick(executionId: string): void
}

export type HttpMethod = 'get' | 'post' | 'patch' | 'delete'
/** What a binary operation's object stage returns ([[CORE58]] P8, P10): the app turns it into the response. */
export interface BinaryBody {
  body: ReadableStream<Uint8Array>
  size: number
  contentType: string
  filename: string
}
/** `origin` is the request's own origin (`https://host`) where the transport knows it: REST sets it, MCP does not ([[CHN5]] D57's redirect URI). */
export type OperationInput = { params: Record<string, unknown>; query: Record<string, unknown>; body: unknown; origin?: string }
interface OperationBase {
  name: string
  /** [[API32]] D1: required, no default. `path` is relative to the surface; the wire path is `fullPath(op)`. */
  surface: Surface
  summary: string
  description?: string
  tags?: string[]
  method: HttpMethod
  path: string
  request?: { params?: z.ZodObject; query?: z.ZodObject; body?: z.ZodType }
  validation?: 'adapter' | 'handler'
  response: { status: 200 | 201 | 202 | 204; schema?: z.ZodType }
  /** [[CHN5]] D29: answers `501 not_implemented` on a storage binding that is not D1, before any unit runs. */
  d1Only?: boolean
  /** The documented request body may be omitted (the OpenAPI document and the CLI then do not require it): the decision commands, whose body is all optional. */
  optionalBody?: boolean
  /** `binary` responds with a `BinaryBody` from the `objects` stage; default `json`. */
  output?: 'json' | 'binary'
}
/**
 * The one tenant operation shape ([[CORE36]] D16): the operation builds a bounded program from the trusted environment and
 * the request input, and the storage binding runs it. `prepare` may be async (it can hash a secret).
 */
export interface TenantOperation extends OperationBase {
  kind: 'tenant'
  /**
   * The scope the operation requires. `null` ([[AGT8]] D7, D38): the authority is the target's and is decided in `prepare` (the
   * `action_requests` decision commands); `authority` then says which action of which target resource it takes, for discovery and
   * tool visibility.
   */
  scope: Scope | null
  authority?: 'read' | 'request_approval' | 'write'
  /** [[AGT8]] D32: required on every tenant operation that is not a read (checked at registration). */
  proposal?: ProposalDecl
  /** [[AGT8]] D28: a unit that drifts is planned and run once more, then answers `409 conflict`. */
  replanOnDrift?: boolean
  prepare: (env: PreparedEnv, input: OperationInput, ctx?: PrepareContext) => PreparedOperation<unknown> | Promise<PreparedOperation<unknown>>
  /**
   * The object stage ([[CORE25]] D52): runs after the read unit with the unit's value and the composition's store, so a
   * unit never calls R2. Its return is the response (JSON) or a `BinaryBody` (binary).
   */
  objects?: (value: unknown, store: ObjectStore) => Promise<unknown>
  /**
   * The after-commit stage ([[CHN141]] D75): runs after the unit has committed, with its value, and returns the response. For a side effect that must
   * not happen unless the unit did (a Workflow instance for a recorded sync request). An `ApiError` it throws is the response.
   */
  after?: (value: unknown, ctx: AfterContext) => Promise<unknown>
  /** [[AGT8]] D2: declared by `enqueuedOperation`; absent: the operation runs inline. */
  execution?: ExecutionDecl
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
  /** Set on a single-workspace composition ([[CORE64]] D24): the user's role from the token, null for an agent. Absent: the copy-based answer. */
  readonly workspace?: { readonly role: Role | null; /** The OAuth client of the token ([[CORE77]] D14); null for a session token and an API key. */ readonly clientId: string | null }
}
export interface AccountOperation extends OperationBase {
  kind: 'account'
  /** Also answers an agent principal, on a single-workspace composition only ([[CORE64]] `me.get`). */
  agents?: boolean
  prepare: (env: AccountEnv, input: OperationInput) => PreparedOperation<unknown>
}
/**
 * What a control operation sees ([[CORE245]] P2): the actor, the deployment's organisation, the unit's clock and id and random sources. It carries no storage binding: a control operation reaches the control
 * plane only through the port its factory closed over, handed in by composition ([[CORE259]] D5).
 */
export interface ControlEnv {
  readonly actor: Actor
  readonly organizationId: string
  readonly scopes: ScopeSet
  readonly now: Date
  readonly newId: () => string
  readonly randomBytes: (n: number) => Uint8Array
}
/**
 * An administration operation whose state lives in the control-plane database, not the CRM one ([[CORE245]]): scope-checked like a tenant operation, run by `run` against a port instead of a
 * storage unit. No CRM event, no proposal (the authority is the owner's, human-only).
 */
export interface ControlOperation extends OperationBase {
  kind: 'control'
  scope: Scope
  run: (env: ControlEnv, input: OperationInput) => Promise<unknown>
}
export type Operation = TenantOperation | AccountOperation | ControlOperation
export type AnyResource = PreparedResource<any, any>

/**
 * [[API6]] D4: how an event's `resource_type` is shown in the feed. `scope`: the resource whose `read` scope the caller needs; `edge`: also checked
 * on the edge record's endpoint types (the association events); `owner`: an agent principal sees only events whose record (`after`, or `before` for a delete) holds its own id at
 * the JSON `path` ([[API219]] D19: a webhook event's `agent_id`), a user holding the scope sees all. `invisible`: never shown, with the reason (fail closed: a type with no entry is the same).
 */
export type EventTypeDecl = { scope: string; edge?: true; owner?: { path: string } } | { invisible: string }

const OP_NAME = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/
const TOOL_NAME = /^[a-z0-9_]{1,64}$/

export class Registry {
  private readonly ops: Operation[] = []
  private readonly defs: AnyResource[] = []
  private readonly explicitEventTypes = new Map<string, EventTypeDecl>()

  /** Validates at load: a bad operation is a programming mistake (plain Error). */
  register(op: Operation): this {
    if (!OP_NAME.test(op.name)) throw new Error(`invalid operation name "${op.name}"`)
    if (!TOOL_NAME.test(toolName(op.name))) throw new Error(`invalid tool name for operation ${op.name}`)
    if (!op.summary || op.summary.trim() === '') throw new Error(`operation ${op.name} needs a summary`)
    if (this.ops.some((o) => o.name === op.name)) throw new Error(`duplicate operation ${op.name}`)
    if (this.ops.some((o) => o.method === op.method && fullPath(o) === fullPath(op))) {
      throw new Error(`duplicate route ${op.method.toUpperCase()} ${fullPath(op)}`)
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
    if (op.kind === 'tenant') {
      if (op.scope === null && !op.authority) throw new Error(`operation ${op.name}: a null scope needs an authority`)
      if (op.method !== 'get' && !op.proposal) throw new Error(`operation ${op.name}: every tenant operation that changes data declares its proposal metadata (eligible, or ineligible with a reason)`)
      if (op.execution) checkEnqueued(op, op.execution)
      if (op.proposal?.eligible) {
        if (op.scope === null || op.scope.action !== 'write') throw new Error(`operation ${op.name}: a proposable operation requires a write scope`)
        // An enqueued operation is not inline: its after stage starts the runner and it is D1 only ([[AGT8]] D26, D49).
        if (!op.execution && (op.after || op.objects || op.d1Only)) throw new Error(`operation ${op.name}: a proposable operation runs inline: no after-commit or object stage, no d1Only`)
        if (op.objects) throw new Error(`operation ${op.name}: an enqueued operation has no object stage`)
      }
    }
    this.ops.push(op)
    return this
  }

  registerResource(def: AnyResource): this {
    for (const op of resourceOperations(def, () => endpointTypesOf(this.defs))) this.register(op)
    this.defs.push(def)
    return this
  }

  operations(): readonly Operation[] {
    return this.ops
  }

  /**
   * [[API6]] D4: how events of a resource type are shown in the feed, for a type no registered definition names (a command's or an account
   * operation's). An explicit entry wins over the one a definition registers for the same type, whatever the order.
   */
  registerEventType(type: string, decl: EventTypeDecl): this {
    this.explicitEventTypes.set(type, decl)
    return this
  }

  /** The feed's visibility map: every registered definition's `eventName` under its scope resource, then the explicit entries. A type with no entry is invisible. */
  eventTypes(): ReadonlyMap<string, EventTypeDecl> {
    const out = new Map<string, EventTypeDecl>()
    for (const def of this.defs) out.set(def.eventName, { scope: scopeResourceOf(def) })
    for (const [type, decl] of this.explicitEventTypes) out.set(type, decl)
    return out
  }

  /** Replaces a registered operation with `change(op)`: the name, method and path must not move. For a hand-written stage on a generated operation ([[CHN155]] D91). */
  decorate(name: string, change: (op: TenantOperation) => TenantOperation): this {
    const at = this.ops.findIndex((o) => o.name === name)
    const op = this.ops[at]
    if (!op || op.kind !== 'tenant') throw new Error(`decorate: no tenant operation ${name}`)
    const next = change(op)
    if (next.name !== op.name || next.method !== op.method || next.path !== op.path) throw new Error(`decorate: ${name} must keep its name, method and path`)
    this.ops[at] = next
    return this
  }

  resources(): readonly AnyResource[] {
    return this.defs
  }

  get(name: string): Operation | undefined {
    return this.ops.find((o) => o.name === name)
  }

  /**
   * Every scope a tenant or control operation requires, formatted, sorted and unique, plus `<resource>:request_approval` for each resource that
   * has a proposable operation ([[AGT8]] D30).
   */
  declaredScopes(): string[] {
    const out = new Set<string>()
    for (const op of this.ops) {
      if (op.kind === 'account' || op.scope === null) continue
      out.add(formatScope(op.scope))
      if (op.kind === 'tenant' && op.proposal?.eligible) out.add(formatScope({ resource: op.scope.resource, action: 'request_approval' }))
    }
    return [...out].sort()
  }
}

/** [[AGT8]] D2, D51, D57: what an enqueued operation must look like, checked at registration (a mistake of the author, so a plain Error). */
function checkEnqueued(op: TenantOperation, execution: ExecutionDecl): void {
  const fail = (what: string): never => {
    throw new Error(`operation ${op.name}: an enqueued operation ${what}`)
  }
  if (op.method !== 'post') fail('is called with post')
  if (op.response.status !== 202) fail('answers 202 with the execution receipt')
  if (op.scope === null || op.scope.action !== 'write') fail('requires a write scope')
  if (execution.readScope.action !== 'read') fail('declares a read scope for its executions (an action `read`)')
  if (op.request?.params || op.request?.query) fail('takes its arguments in the body: no path or query parameters')
  const body = op.request?.body
  const key = body instanceof z.ZodObject ? body.shape.idempotency_key : undefined
  if (!(body instanceof z.ZodObject) || key === undefined || key.safeParse(undefined).success) fail('requires an idempotency_key in its body')
  if (!op.proposal?.eligible) fail('is proposable (an approved request creates the same execution)')
}

/** The MCP/CLI-safe name derived from a dotted operation name. */
export const toolName = (name: string): string => name.replaceAll('.', '_')

/**
 * The query parameters a list's filters become, shared by `<list>.list` and `<list>.aggregate` ([[CORE202]] D13: the same filters): an equality parameter for each
 * `filters` and custom filter, replaced by one grammar string where [[CORE200]] D9 made the column a column filter.
 */
function filterFields(def: PreparedResource<any, any>): Record<string, z.ZodType> {
  const fields: Record<string, z.ZodType> = {}
  for (const [key, f] of Object.entries({ ...(def.filters ?? {}), ...(def.customFilters ?? {}) })) fields[key] = (f as { schema: z.ZodType }).schema.optional()
  return Object.assign(fields, columnFilterParams(def))
}

/** The generic CRUD operations of a definition, in CRUD_ACTIONS order, for the actions it generates. */
export function resourceOperations(def: PreparedResource<any, any>, types: () => EndpointTypes = () => endpointTypesOf([def])): TenantOperation[] {
  const p = resourcePath(def)
  const s = scopeResourceOf(def)
  const actions = new Set<CrudAction>(crudActions(def))
  const idParams = z.object({ id: z.uuid() })
  const rec: z.ZodType = def.record
  const getQuery = z.object({ include: includeQuery.optional() })
  const base = { kind: 'tenant' as const, surface: def.surface, validation: 'handler' as const, tags: [def.name], ...(def.d1Only ? { d1Only: true } : {}) }
  const notProposable = (): ProposalDecl => ({ eligible: false, reason: def.notProposable ?? 'not proposable' })
  const targeted = (): ProposalDecl => (def.notProposable !== undefined ? notProposable() : { eligible: true, target: { table: def.table as PhysicalTable, idArg: 'id', notFound: `${def.eventName} not found`, live: softDeletes(def) } })
  const ops: TenantOperation[] = []
  if (actions.has('list')) {
    // [[CORE133]] D8, D9: a list that declares `sorts` takes sort and order, and its cursor is an opaque string; every other list keeps a UUID cursor.
    const sorts = def.sorts ?? []
    const sortFields = sorts.length > 0 ? sortedQueryFields(def) : null
    const query: Record<string, z.ZodType> = sortFields ? { after: sortFields.after! } : { after: z.uuid().optional() }
    query.limit = z.coerce.number().int().min(1).max(200).optional()
    Object.assign(query, filterFields(def))
    if (sortFields) {
      query.sort = sortFields.sort!
      query.order = sortFields.order!
    }
    ops.push({
      ...base,
      name: `${def.name}.list`,
      summary: `List ${def.name}`,
      method: 'get',
      path: p,
      scope: { resource: s, action: 'read' },
      request: { query: z.object(query) },
      response: { status: 200, schema: z.object({ data: z.array(rec), next_cursor: sorts.length > 0 ? SORTED_NEXT : z.uuid().nullable() }) },
      prepare: (env, input) => {
        const { after, limit, sort, order, ...filters } = input.query as Record<string, unknown>
        // Without `sorts`, `sort` and `order` are not parameters: they stay in `filters`, where they are unknown filters, as they always were.
        const raw = sorts.length > 0 ? { after, limit, sort, order, filters: filters as Record<string, string> } : { after, limit, filters: { ...(sort !== undefined ? { sort } : {}), ...(order !== undefined ? { order } : {}), ...filters } as Record<string, string> }
        return def.override?.list ? def.override.list(env, raw) : listOperation(def, env, raw)
      },
    })
  }
  // [[CORE202]] D13: `GET <list path>/aggregate`, registered BEFORE `get` so that `GET /deals/{id}` does not swallow it: the router matches in registration order.
  if (actions.has('list') && def.aggregate) {
    ops.push({
      ...base,
      name: `${def.name}.aggregate`,
      summary: `Count ${def.name}, and sum, average or take the minimum or maximum of their fields`,
      description: aggregateDescription(def),
      method: 'get',
      path: `${p}/aggregate`,
      scope: { resource: s, action: 'read' },
      request: { query: z.object({ ...aggregateParams(def), ...filterFields(def) }) },
      response: { status: 200, schema: aggregateAnswer },
      prepare: (env, input) => aggregateOperation(def, env, input.query),
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
      // [[CORE62]] D6: an associable record can embed its edges (`?include=associations`); other resources take no query.
      request: { params: idParams, ...(def.associable ? { query: getQuery } : {}) },
      response: { status: 200, schema: def.associable ? (def.record as z.ZodObject).extend(embeddedFields) : rec },
      prepare: (env, input) =>
        def.associable && parseInput(getQuery, input.query).include === 'associations'
          ? getWithAssociations(def, env, types(), input.params.id as string)
          : def.override?.get
            ? def.override.get(env, input.params.id)
            : getOperation(def, env, input.params.id as string),
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
      proposal: def.notProposable !== undefined ? notProposable() : { eligible: true },
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
      proposal: targeted(),
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
      proposal: targeted(),
      request: { params: idParams },
      response: { status: 204 },
      prepare: (env, input) => (def.override?.delete ? def.override.delete(env, input.params.id) : deleteOperation(def, env, input.params.id as string)),
    })
  }
  return ops
}

/** The adapter-validated operations ([[CORE36]]) parse their input here, before any scope check; handler-validated ones do it inside `prepare`. */
export function validateOperationInput(op: Operation, input: OperationInput): OperationInput {
  if (op.validation !== 'adapter') return input
  const { params, query, body, origin } = input
  return {
    ...(origin !== undefined ? { origin } : {}),
    params: op.request?.params ? parseInput(op.request.params, params) : params,
    query: op.request?.query ? parseInput(op.request.query, query) : query,
    body: op.request?.body ? parseInput(op.request.body, body) : body,
  }
}
