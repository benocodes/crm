import { usage } from './errors.js'
import type { Command, FlagSpec, FlagType, JsonSchema, Operation } from './types.js'

/** Names the CLI owns. A body property with one is reachable only through `--data`; a query parameter with one cannot be derived. */
export const RESERVED_FLAGS: readonly string[] = ['data', 'all', 'refresh', 'profile', 'server', 'output', 'help']

const METHODS = ['get', 'put', 'post', 'patch', 'delete', 'head', 'options']
type Obj = Record<string, any>
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)

/** Follows local `#/...` references (a few hops; a cycle or an unknown target resolves to `{}`). */
function resolve(root: unknown, node: unknown): Obj {
  let cur = node
  for (let hops = 0; hops < 16; hops++) {
    if (!isObj(cur) || typeof cur.$ref !== 'string') return isObj(cur) ? cur : {}
    const ref: string = cur.$ref
    if (!ref.startsWith('#/')) return {}
    let target: unknown = root
    for (const part of ref.slice(2).split('/')) target = isObj(target) ? target[part.replace(/~1/g, '/').replace(/~0/g, '~')] : undefined
    cur = target
  }
  return {}
}

const isJsonType = (t: string) => t === 'application/json' || t.endsWith('+json')

function toOperation(source: 'api' | 'meta', root: unknown, path: string, method: string, op: Obj, shared: unknown[]): Operation {
  const parameters: Operation['parameters'] = []
  for (const raw of [...shared, ...(Array.isArray(op.parameters) ? op.parameters : [])]) {
    const p = resolve(root, raw)
    if ((p.in !== 'path' && p.in !== 'query') || typeof p.name !== 'string') continue
    const entry = { name: p.name, in: p.in as 'path' | 'query', required: p.in === 'path' || p.required === true, schema: resolve(root, p.schema), description: typeof p.description === 'string' ? p.description : undefined }
    const at = parameters.findIndex((x) => x.name === entry.name && x.in === entry.in)
    if (at >= 0) parameters[at] = entry
    else parameters.push(entry)
  }
  let body: Operation['body'] = null
  if (op.requestBody !== undefined) {
    const rb = resolve(root, op.requestBody)
    const content = isObj(rb.content) ? rb.content : {}
    const jsonKey = Object.keys(content).find(isJsonType)
    body = { required: rb.required === true, schema: jsonKey ? resolve(root, content[jsonKey]?.schema) : null }
  }
  const responses = isObj(op.responses) ? op.responses : {}
  const okStatus = Object.keys(responses)
    .filter((s) => /^2\d\d$/.test(s))
    .sort()[0]
  const success = okStatus ? resolve(root, responses[okStatus]) : {}
  const content = isObj(success.content) ? success.content : {}
  const types = Object.keys(content)
  const binary = types.length > 0 && !types.some(isJsonType)
  const jsonType = types.find(isJsonType)
  const responseSchema = jsonType ? resolve(root, content[jsonType]?.schema) : {}
  const props = resolve(root, responseSchema).properties
  const paginated = parameters.some((p) => p.in === 'query' && p.name === 'after') && isObj(props) && 'next_cursor' in props
  return { id: op.operationId, source, method: method.toUpperCase(), path, summary: typeof op.summary === 'string' ? op.summary : '', parameters, body, binary, paginated }
}

/** Merges the two OpenAPI documents by `operationId` ([[API6]] D7). A duplicate is a usage error naming both. */
export function mergeDocuments(docs: { source: 'api' | 'meta'; doc: unknown }[]): Operation[] {
  const out = new Map<string, Operation>()
  for (const { source, doc } of docs) {
    const paths = isObj(doc) && isObj(doc.paths) ? doc.paths : {}
    for (const [path, item] of Object.entries<unknown>(paths)) {
      if (!isObj(item)) continue
      const shared = Array.isArray(item.parameters) ? item.parameters : []
      for (const method of METHODS) {
        const op = item[method]
        if (!isObj(op) || typeof op.operationId !== 'string' || op.operationId === '') continue
        const next = toOperation(source, doc, path, method, op, shared)
        const prior = out.get(next.id)
        if (prior) throw usage(`operationId "${next.id}" appears twice: ${prior.method} ${prior.path} (${prior.source} document) and ${next.method} ${next.path} (${next.source} document)`, 'duplicate_operation')
        out.set(next.id, next)
      }
    }
  }
  return [...out.values()]
}

const kebab = (s: string) => s.replace(/_/g, '-')

function flagType(schema: JsonSchema): { type: FlagType; enum?: string[] } {
  const typeOf = (s: Obj): string | undefined => {
    const t = s.type
    if (typeof t === 'string') return t
    if (Array.isArray(t)) return t.find((x) => x !== 'null')
    for (const key of ['anyOf', 'oneOf']) {
      const variants = s[key]
      if (Array.isArray(variants)) {
        const found = variants.map((v) => (isObj(v) ? typeOf(v) : undefined)).find((x) => x !== undefined && x !== 'null')
        if (found) return found
      }
    }
    return undefined
  }
  const t = typeOf(schema)
  const en = Array.isArray(schema.enum) && schema.enum.every((v) => typeof v === 'string') ? (schema.enum as string[]) : undefined
  if (t === 'integer' || t === 'number' || t === 'boolean') return { type: t }
  if (t === 'object' || t === 'array') return { type: 'json' }
  return en ? { type: 'string', enum: en } : { type: 'string' }
}

export function deriveCommand(op: Operation): Command {
  const dot = op.id.lastIndexOf('.')
  const base = {
    operationId: op.id,
    resource: dot > 0 ? kebab(op.id.slice(0, dot)) : kebab(op.id),
    action: dot > 0 ? kebab(op.id.slice(dot + 1)) : '',
    method: op.method,
    path: op.path,
    summary: op.summary,
    pathParams: [...op.path.matchAll(/\{([^}]+)\}/g)].map((m) => m[1]!),
    flags: [] as FlagSpec[],
    dataOnly: [] as string[],
    hasBody: op.body !== null,
    bodyRequired: op.body?.required ?? false,
    binary: op.binary,
    paginated: op.paginated,
  }
  const fail = (error: string): Command => ({ ...base, flags: [], dataOnly: [], error })
  if (dot <= 0) return fail(`operationId "${op.id}" is not <resource>.<action>`)
  const declared = new Set(op.parameters.filter((p) => p.in === 'path').map((p) => p.name))
  for (const name of base.pathParams) if (!declared.has(name)) return fail(`path parameter {${name}} of ${op.id} is not declared`)
  const taken = new Set<string>()
  for (const p of op.parameters) {
    if (p.in !== 'query') continue
    const name = kebab(p.name)
    if (RESERVED_FLAGS.includes(name)) return fail(`${op.id}: query parameter "${p.name}" has a name reserved by the CLI (${RESERVED_FLAGS.map((r) => '--' + r).join(', ')}), so this command cannot be derived`)
    if (taken.has(name)) return fail(`${op.id}: two query parameters map to --${name}`)
    taken.add(name)
    base.flags.push({ name, prop: p.name, where: 'query', ...flagType(p.schema), required: p.required, description: p.description })
  }
  if (op.body && op.body.schema === null) return fail(`${op.id}: the request body is not JSON, which the CLI cannot send`)
  const props = isObj(op.body?.schema?.properties) ? (op.body!.schema!.properties as Obj) : {}
  const required = Array.isArray(op.body?.schema?.required) ? (op.body!.schema!.required as string[]) : []
  for (const [prop, raw] of Object.entries(props)) {
    const name = kebab(prop)
    if (RESERVED_FLAGS.includes(name) || taken.has(name)) {
      base.dataOnly.push(prop)
      continue
    }
    taken.add(name)
    const schema = isObj(raw) ? raw : {}
    base.flags.push({ name, prop, where: 'body', ...flagType(schema), required: required.includes(prop), description: typeof schema.description === 'string' ? schema.description : undefined })
  }
  return base
}

/** One command per operation that has an `operationId` (merging already dropped plain routes). */
export function deriveCommands(ops: Operation[]): Command[] {
  return ops.map(deriveCommand)
}
