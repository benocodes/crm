// The `env.<name>` writer of `setup:remote` ([[OPS65]] D9): adds what a JSONC wrangler config lacks, fills the placeholder
// `database_id`, and refuses (a mismatch naming the key) wherever a present value differs. Comments and formatting survive:
// every edit is a `jsonc-parser` `modify` of one path.
import { applyEdits, modify, parse, type JSONPath } from 'jsonc-parser'
import { PLACEHOLDER_DATABASE_ID } from '../remote.js'

export interface DesiredEnv {
  env: string
  workerName: string
  d1Name: string
  /** The database's id, or the placeholder while the database is only planned. */
  d1Id: string
  r2Name: string
  apiHost: string
  corsOrigins: string
  /** `--auth clerk`: the Clerk variables ([[OPS65]] D3). `AUTH_CLI_CLIENT_ID` is absent while the CLI application is only planned. */
  authVars?: { AUTH_PROVIDER: string; CLERK_ISSUER: string; CLERK_PUBLISHABLE_KEY?: string; CLERK_AUTHORIZED_PARTIES: string; AUTH_CLI_CLIENT_ID?: string }
  /** The Gmail group's public vars ([[OPS150]]); only names from the allow-list ever get here. */
  gmailVars?: Record<string, string>
}
export interface ReconcileResult {
  text: string
  /** Dotted paths the edit added or filled. */
  changed: string[]
  /** Dotted paths whose present value differs from the desired one. */
  mismatches: string[]
}

type Json = Record<string, unknown>
const isObj = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v)

/** The desired block, shaped like `env.smoked1` ([[OPS4]] D10). */
export function desiredBlock(d: DesiredEnv): Json {
  return {
    name: d.workerName,
    workers_dev: false,
    preview_urls: false,
    routes: [{ pattern: d.apiHost, custom_domain: true }],
    observability: { enabled: true },
    d1_databases: [{ binding: 'DB', database_name: d.d1Name, database_id: d.d1Id, migrations_dir: '../storage-d1/migrations', remote: true }],
    r2_buckets: [{ binding: 'BODIES', bucket_name: d.r2Name }],
    vars: Object.fromEntries(Object.entries(d.authVars ? { ...d.authVars, CORS_ALLOWED_ORIGINS: d.corsOrigins, ...d.gmailVars } : { AUTH_PROVIDER: '', CORS_ALLOWED_ORIGINS: d.corsOrigins, ...d.gmailVars }).filter(([, v]) => v !== undefined)),
  }
}

export function reconcileEnvBlock(text: string, d: DesiredEnv): ReconcileResult {
  const root = parse(text, [], { allowTrailingComma: true }) as unknown
  const current = isObj(root) && isObj(root.env) ? root.env[d.env] : undefined
  const want = desiredBlock(d)
  const edits: { path: JSONPath; value: unknown; label: string }[] = []
  const mismatches: string[] = []
  const at = (label: string) => `env.${d.env}.${label}`

  if (current === undefined) {
    edits.push({ path: ['env', d.env], value: want, label: `env.${d.env}` })
  } else if (!isObj(current)) {
    mismatches.push(`env.${d.env}`)
  } else {
    const scalar = (obj: Json, path: JSONPath, key: string, value: unknown, label: string) => {
      if (!(key in obj)) edits.push({ path: [...path, key], value, label })
      else if (obj[key] !== value) {
        // The one value the command fills in place: a placeholder database_id.
        if (key === 'database_id' && obj[key] === PLACEHOLDER_DATABASE_ID) edits.push({ path: [...path, key], value, label })
        else mismatches.push(label)
      }
    }
    scalar(current, ['env', d.env], 'name', d.workerName, at('name'))
    scalar(current, ['env', d.env], 'workers_dev', false, at('workers_dev'))
    scalar(current, ['env', d.env], 'preview_urls', false, at('preview_urls'))

    if (!('observability' in current)) edits.push({ path: ['env', d.env, 'observability'], value: { enabled: true }, label: at('observability') })
    else if (!isObj(current.observability)) mismatches.push(at('observability'))
    else scalar(current.observability, ['env', d.env, 'observability'], 'enabled', true, at('observability.enabled'))

    // Keyed lists: the element is found by its key; a list without it is a mismatch, never an append.
    const keyed = (field: string, key: string, keyValue: string, fields: Json) => {
      const list = current[field]
      const base: JSONPath = ['env', d.env, field]
      if (list === undefined) return void edits.push({ path: base, value: [{ [key]: keyValue, ...fields }], label: at(field) })
      if (!Array.isArray(list)) return void mismatches.push(at(field))
      const idx = list.findIndex((e) => isObj(e) && e[key] === keyValue)
      if (idx < 0) return void mismatches.push(at(field))
      for (const [k, v] of Object.entries(fields)) scalar(list[idx] as Json, [...base, idx], k, v, at(`${field}.${keyValue}.${k}`))
    }
    keyed('d1_databases', 'binding', 'DB', { database_name: d.d1Name, database_id: d.d1Id, migrations_dir: '../storage-d1/migrations', remote: true })
    keyed('r2_buckets', 'binding', 'BODIES', { bucket_name: d.r2Name })

    const routes = current.routes
    if (routes === undefined) edits.push({ path: ['env', d.env, 'routes'], value: want.routes, label: at('routes') })
    else if (!Array.isArray(routes) || !routes.some((r) => isObj(r) && r.pattern === d.apiHost && r.custom_domain === true)) mismatches.push(at('routes'))

    if (!('vars' in current)) edits.push({ path: ['env', d.env, 'vars'], value: want.vars, label: at('vars') })
    else if (!isObj(current.vars)) mismatches.push(at('vars'))
    else {
      const vars = current.vars
      for (const [k, v] of Object.entries(want.vars as Json)) {
        const here = vars[k]
        const label = at(`vars.${k}`)
        if (k === 'CLERK_AUTHORIZED_PARTIES' && typeof v === 'string' && typeof here === 'string') {
          // A union, never a removal ([[UI30]] D7): what an owner added by hand stays, what setup needs is appended.
          const present = here.split(',').map((o) => o.trim()).filter(Boolean)
          const missing = v.split(',').filter((o) => o !== '' && !present.includes(o))
          if (missing.length > 0) edits.push({ path: ['env', d.env, 'vars', k], value: [...present, ...missing].join(','), label })
        } else if (k === 'CLERK_PUBLISHABLE_KEY' && here === '') edits.push({ path: ['env', d.env, 'vars', k], value: v, label })
        else scalar(vars, ['env', d.env, 'vars'], k, v, label)
      }
    }
  }

  if (mismatches.length > 0) return { text, changed: [], mismatches }
  let out = text
  for (const e of edits) out = applyEdits(out, modify(out, e.path, e.value, { formattingOptions: { insertSpaces: true, tabSize: 2, eol: '\n' } }))
  return { text: out, changed: edits.map((e) => e.label), mismatches: [] }
}
