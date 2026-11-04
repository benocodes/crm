import { z } from 'zod'
import { ApiError } from '../errors.js'
import type { Principal } from '../auth/types.js'
import { toolName, type Operation, type OperationInput, type Registry } from '../registry.js'
import { formatScope } from '../scopes.js'

/** [[API106]] D7-D9: one tool, as `tools/list` carries it. */
export interface McpTool {
  name: string
  title: string
  description: string
  inputSchema: Record<string, unknown>
  outputSchema?: Record<string, unknown>
  annotations: { readOnlyHint: boolean; destructiveHint?: boolean }
  _meta: { 'vibase/surface': 'api' | 'meta' }
}
export interface ToolEntry {
  op: Operation
  tool: McpTool
}

type Json = Record<string, unknown>
const toJson = (schema: z.ZodType, io: 'input' | 'output'): Json => {
  const { $schema: _drop, ...rest } = z.toJSONSchema(schema, { io, unrepresentable: 'any', target: 'draft-2020-12' }) as Json
  return rest
}

/** D8: summary, description, then the scope line. */
export function describeOperation(op: Operation): string {
  const lines = [op.summary]
  if (op.description) lines.push(op.description)
  if (op.kind === 'tenant') lines.push(`Requires ${formatScope(op.scope)} (${op.surface === 'api' ? 'records' : 'configuration'} surface).`)
  else if (!op.agents) lines.push('Requires a signed-in user.')
  return lines.join('\n')
}

function inputSchemaOf(op: Operation): Json {
  const properties: Record<string, unknown> = {}
  const required: string[] = []
  const add = (from: string, schema: Json) => {
    for (const [k, v] of Object.entries((schema.properties ?? {}) as Json)) {
      if (k in properties) throw new Error(`operation ${op.name}: argument "${k}" appears in more than one of params, query and body (${from})`)
      properties[k] = v
    }
    required.push(...((schema.required ?? []) as string[]))
  }
  if (op.request?.params) add('params', toJson(op.request.params, 'input'))
  if (op.request?.query) add('query', toJson(op.request.query, 'input'))
  const body = op.request?.body
  if (body instanceof z.ZodObject) add('body', toJson(body, 'input'))
  else if (body) {
    properties.body = toJson(body, 'input')
    if (!body.safeParse(undefined).success) required.push('body')
  }
  return { type: 'object', properties, ...(required.length > 0 ? { required } : {}) }
}

function toolOf(op: Operation): McpTool {
  const out = op.response.schema ? toJson(op.response.schema, 'output') : undefined
  return {
    name: toolName(op.name),
    title: op.summary,
    description: describeOperation(op),
    inputSchema: inputSchemaOf(op),
    ...(out && out.type === 'object' ? { outputSchema: out } : {}),
    annotations: { readOnlyHint: op.method === 'get', ...(op.method === 'delete' ? { destructiveHint: true } : {}) },
    _meta: { 'vibase/surface': op.surface },
  }
}

const cache = new WeakMap<Registry, ToolEntry[]>()
/** D7, D9, D11: every non-binary operation as a tool, in registry order; derived once per registry. */
export function deriveTools(registry: Registry): readonly ToolEntry[] {
  let entries = cache.get(registry)
  if (!entries) {
    entries = registry
      .operations()
      .filter((op) => op.output !== 'binary')
      .map((op) => ({ op, tool: toolOf(op) }))
    cache.set(registry, entries)
  }
  return entries
}

/**
 * D6: a tenant operation is visible when the caller's effective scopes hold its scope in an organisation; an account operation
 * to a user, or to an agent when the operation answers agents and the composition is a single workspace.
 */
export function isVisible(op: Operation, principal: Principal, workspace: boolean): boolean {
  if (op.output === 'binary') return false
  if (op.kind === 'account') return principal.actor.kind === 'user' || (op.agents === true && workspace)
  return !principal.organizationForbidden && principal.organizationId !== null && principal.scopes.has(op.scope)
}

const asString = (v: unknown): string => (typeof v === 'string' ? v : typeof v === 'object' ? JSON.stringify(v) : String(v))

/**
 * D9: the flat arguments back into params, query and body. Params and query values go over as strings, as the REST router hands
 * them over, so validation and coercion are the REST ones. Any other name is a body field (a strict body schema refuses it);
 * an operation with no body field to put it in refuses it as a validation error, never drops it.
 */
export function splitArguments(op: Operation, args: Record<string, unknown>): OperationInput {
  const paramKeys = op.request?.params?.shape ?? {}
  const queryKeys = op.request?.query?.shape ?? {}
  const bodySchema = op.request?.body
  const objectBody = bodySchema instanceof z.ZodObject
  const params: Record<string, unknown> = {}
  const query: Record<string, unknown> = {}
  const bodyFields: Record<string, unknown> = {}
  let whole: unknown
  const unknown: string[] = []
  for (const [k, v] of Object.entries(args)) {
    if (v === undefined || v === null) continue
    if (k in paramKeys) params[k] = asString(v)
    else if (k in queryKeys) query[k] = asString(v)
    else if (objectBody) bodyFields[k] = v
    else if (bodySchema && k === 'body') whole = v
    else unknown.push(k)
  }
  if (unknown.length > 0) throw new ApiError(400, 'validation_error', `unknown argument${unknown.length > 1 ? 's' : ''}: ${unknown.join(', ')}`)
  return { params, query, body: objectBody ? bodyFields : whole }
}
