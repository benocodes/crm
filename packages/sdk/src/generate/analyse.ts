import type { FieldPlace, HttpMethod } from '../types.js'

/** One operation of the documents, analysed: everything the table and the map need (DX603 D2 to D5, D12). */
export interface Analysed {
  id: string
  document: 'api' | 'meta'
  namespace: string
  method: string
  http: HttpMethod
  path: string
  fields: Record<string, FieldPlace>
  body: boolean
  output: 'json' | 'empty' | 'binary'
  /** The success status the result type is read from (json only). */
  status: number
  paginated: boolean
  proposable: boolean
  filters: Record<string, { kind: string; operators: string[]; max: number }>
  /** DX616 D2: the operation's `x-vibase-aggregate`, each named field's kind taken from the filters; absent when the document has none. */
  aggregate?: AnalysedAggregate
}

export const AGGREGATE_FUNCTIONS = ['sum', 'avg', 'min', 'max'] as const
export interface AnalysedAggregate {
  sum: string[]
  avg: string[]
  min: string[]
  max: string[]
  group_by: string[]
  money: Record<string, string>
  /** Every field named by a list, to its filter kind. */
  kinds: Record<string, string>
  /** The aggregate parameters that exist on the server (a function with no field has none), sorted. */
  params: string[]
}

type Obj = Record<string, any>
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)
const METHODS = ['get', 'put', 'post', 'patch', 'delete'] as const
/** DX616 D2: reads and checks `x-vibase-aggregate`; every listed field must be a filter parameter of the same operation. */
function analyseAggregate(id: string, raw: unknown, filters: Analysed['filters']): AnalysedAggregate {
  const bad = (why: string) => new Error(`operation ${id}: x-vibase-aggregate ${why}`)
  if (!isObj(raw)) throw bad('must be an object')
  const lists: Record<string, string[]> = {}
  const kinds: Record<string, string> = {}
  for (const name of [...AGGREGATE_FUNCTIONS, 'group_by']) {
    const list = raw[name]
    if (!Array.isArray(list) || list.some((f) => typeof f !== 'string'))
      throw bad(`"${name}" must be an array of field names`)
    for (const field of list as string[]) {
      if (!(field in filters))
        throw bad(`"${name}" names the field "${field}", which is not a filter parameter of the operation`)
      kinds[field] = filters[field].kind
    }
    lists[name] = list as string[]
  }
  const money = raw.money
  if (!isObj(money) || Object.values(money).some((c) => typeof c !== 'string'))
    throw bad('"money" must map each money field to its currency column')
  return {
    sum: lists.sum,
    avg: lists.avg,
    min: lists.min,
    max: lists.max,
    group_by: lists.group_by,
    money: money as Record<string, string>,
    kinds,
    params: Object.keys(lists)
      .filter((n) => lists[n].length > 0)
      .sort(),
  }
}

const RESERVED_METHODS = ['all', 'propose']

/** D4: an id splits at its first dot; both parts are camelCased (`deals.move_stage` is `deals.moveStage`). DX604 D5: a namespace ending in `__c` is a custom object's key and stays verbatim (`projects__c.list` is `projects__c.list`). */
export function memberNames(operationId: string): { namespace: string; method: string } {
  const dot = operationId.indexOf('.')
  if (dot <= 0 || dot === operationId.length - 1)
    throw new Error(`operation id "${operationId}" must be <namespace>.<method>`)
  const camel = (s: string) => s.replace(/[_.]+([a-zA-Z0-9])/g, (_, c: string) => c.toUpperCase())
  const namespace = operationId.slice(0, dot)
  return {
    namespace: namespace.endsWith('__c') ? namespace : camel(namespace),
    method: camel(operationId.slice(dot + 1)),
  }
}

/** Follows local `#/...` references. */
function deref(root: unknown, node: unknown): Obj {
  let cur = node
  for (let hops = 0; hops < 16; hops++) {
    if (!isObj(cur) || typeof cur.$ref !== 'string') return isObj(cur) ? cur : {}
    if (!cur.$ref.startsWith('#/')) return {}
    let target: unknown = root
    for (const part of cur.$ref.slice(2).split('/'))
      target = isObj(target) ? target[part.replace(/~1/g, '/').replace(/~0/g, '~')] : undefined
    cur = target
  }
  return {}
}

const isJson = (type: string) => type === 'application/json' || type.endsWith('+json')

function analyseOperation(
  document: 'api' | 'meta',
  root: unknown,
  path: string,
  http: HttpMethod,
  op: Obj,
  shared: unknown[],
): Analysed {
  const id = op.operationId as string
  // DX604 D4: a path is origin-relative (one leading slash): the client sends the credential to the origin it was given.
  if (!/^\/(?!\/)/.test(path))
    throw new Error(
      `operation ${id}: the path "${path}" must start with a single "/" (an absolute URL or a // host is refused, DX604 D4)`,
    )
  const { namespace, method } = memberNames(id)
  const fields: Record<string, FieldPlace> = {}
  const filters: Analysed['filters'] = {}
  let paginatedQuery = false
  for (const raw of [...shared, ...(Array.isArray(op.parameters) ? op.parameters : [])]) {
    const p = deref(root, raw)
    if ((p.in !== 'path' && p.in !== 'query') || typeof p.name !== 'string') continue
    if (p.name in fields && fields[p.name] !== p.in)
      throw new Error(`operation ${id}: the field "${p.name}" is both a ${fields[p.name]} and a ${p.in} parameter`)
    fields[p.name] = p.in
    if (p.in === 'query' && p.name === 'after') paginatedQuery = true
    const filter = p['x-vibase-filter']
    if (p.in === 'query' && isObj(filter) && typeof filter.kind === 'string' && Array.isArray(filter.operators)) {
      // The cap is the array alternative's maxItems (P1); a document without one allows a single condition.
      const alternatives = [
        deref(root, p.schema),
        ...(Array.isArray(deref(root, p.schema).anyOf) ? deref(root, p.schema).anyOf : []),
      ]
      const max = alternatives
        .map((a) => deref(root, a))
        .find((a) => a.type === 'array' && typeof a.maxItems === 'number')
      filters[p.name] = { kind: filter.kind, operators: filter.operators.map(String), max: max ? max.maxItems : 1 }
    }
  }

  let body = false
  if (op.requestBody !== undefined) {
    const rb = deref(root, op.requestBody)
    const content = isObj(rb.content) ? rb.content : {}
    const key = Object.keys(content).find(isJson)
    const schema = key ? deref(root, content[key]?.schema) : {}
    const isObject = schema.type === 'object' || (Array.isArray(schema.type) && schema.type.includes('object'))
    if (!key || !isObject)
      throw new Error(
        `operation ${id}: the request body must be a JSON object (D5), not ${key ? JSON.stringify(schema.type ?? 'a non-object schema') : 'a non-JSON body'}`,
      )
    body = true
    for (const name of Object.keys(isObj(schema.properties) ? schema.properties : {})) {
      if (name in fields)
        throw new Error(
          `operation ${id}: the field "${name}" is in both the ${fields[name]} and the body (D5); a flat argument has one place`,
        )
      fields[name] = 'body'
    }
  }

  const responses = isObj(op.responses) ? op.responses : {}
  const okStatus = Object.keys(responses)
    .filter((s) => /^2\d\d$/.test(s))
    .sort()[0]
  const success = okStatus ? deref(root, responses[okStatus]) : {}
  const content = isObj(success.content) ? success.content : {}
  const types = Object.keys(content)
  const jsonType = types.find(isJson)
  let output: Analysed['output'] = 'json'
  if (types.length === 0) output = 'empty'
  else if (!jsonType) output = 'binary'
  const resultSchema = jsonType ? deref(root, content[jsonType]?.schema) : {}
  const props = isObj(resultSchema.properties) ? resultSchema.properties : {}
  const proposal = op['x-vibase-proposal']
  const aggregate =
    op['x-vibase-aggregate'] === undefined ? undefined : analyseAggregate(id, op['x-vibase-aggregate'], filters)

  return {
    id,
    document,
    namespace,
    method,
    http,
    path,
    fields,
    body,
    output,
    status: okStatus ? Number(okStatus) : 200,
    paginated: paginatedQuery && 'next_cursor' in props,
    proposable: isObj(proposal) && proposal.eligible === true,
    filters,
    ...(aggregate ? { aggregate } : {}),
  }
}

/** Reads every operation of both documents. Refusals (D4, D5): a collision, a reserved member name, a non-object body, a field in two places. Sorted by id. */
export function analyseDocuments(documents: { api: unknown; meta: unknown }): Analysed[] {
  const byId = new Map<string, Analysed>()
  const byMember = new Map<string, string>()
  for (const document of ['api', 'meta'] as const) {
    const root = documents[document]
    const paths = isObj(root) && isObj(root.paths) ? root.paths : {}
    for (const [path, item] of Object.entries<unknown>(paths)) {
      if (!isObj(item)) continue
      const shared = Array.isArray(item.parameters) ? item.parameters : []
      for (const m of METHODS) {
        const op = item[m]
        if (!isObj(op)) continue
        if (typeof op.operationId !== 'string' || op.operationId === '')
          throw new Error(`${m.toUpperCase()} ${path} (${document} document) has no operationId`)
        const next = analyseOperation(document, root, path, m.toUpperCase() as HttpMethod, op, shared)
        const prior = byId.get(next.id)
        if (prior)
          throw new Error(
            `operation id "${next.id}" appears twice: ${prior.http} ${prior.path} (${prior.document} document) and ${next.http} ${next.path} (${next.document} document)`,
          )
        if (RESERVED_METHODS.includes(next.method))
          throw new Error(
            `operation ${next.id}: the method name "${next.method}" is reserved for the client's own helpers (D4)`,
          )
        const member = `${next.namespace}.${next.method}`
        const clash = byMember.get(member)
        if (clash) throw new Error(`operations ${clash} and ${next.id} both map to the client member ${member} (D4)`)
        byMember.set(member, next.id)
        byId.set(next.id, next)
      }
    }
  }
  return [...byId.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
}
