import { parseArgs } from 'node:util'
import { usage } from './errors.js'
import type { Command, FlagSpec, Invocation } from './types.js'

export interface InvokeIo {
  readFile(path: string): Promise<string>
  readStdin(): Promise<string>
}

/** Flags taking a value, among the CLI's own: the command scanner must skip their values. */
export const GLOBAL_VALUE_FLAGS = ['--data', '--profile', '--server', '--output'] as const

function coerce(flag: FlagSpec, raw: string): unknown {
  switch (flag.type) {
    case 'integer': {
      const n = Number(raw)
      if (raw.trim() === '' || !Number.isInteger(n)) throw usage(`--${flag.name} takes an integer`)
      return n
    }
    case 'number': {
      const n = Number(raw)
      if (raw.trim() === '' || !Number.isFinite(n)) throw usage(`--${flag.name} takes a number`)
      return n
    }
    case 'json':
      try {
        return JSON.parse(raw)
      } catch {
        throw usage(`--${flag.name} takes JSON (an object or an array)`)
      }
    default:
      if (flag.enum && !flag.enum.includes(raw)) throw usage(`--${flag.name} must be one of: ${flag.enum.join(', ')}`)
      return raw
  }
}

async function readData(spec: string, io: InvokeIo): Promise<unknown> {
  let text: string
  if (spec === '-') text = await io.readStdin()
  else if (spec.startsWith('@')) {
    try {
      text = await io.readFile(spec.slice(1))
    } catch {
      throw usage(`cannot read ${spec.slice(1)} for --data`)
    }
  } else text = spec
  try {
    return JSON.parse(text)
  } catch (e) {
    throw usage(`--data is not valid JSON: ${e instanceof Error ? e.message : 'parse error'}`)
  }
}

/** Turns the words after the command into one request ([[API6]] D7): positional path parameters, flags, `--data`. */
export async function parseInvocation(cmd: Command, args: string[], io: InvokeIo): Promise<Invocation> {
  if (cmd.error) throw usage(cmd.error)
  const options: Record<string, { type: 'string' | 'boolean' }> = {
    data: { type: 'string' },
    all: { type: 'boolean' },
    refresh: { type: 'boolean' },
    help: { type: 'boolean' },
    profile: { type: 'string' },
    server: { type: 'string' },
    output: { type: 'string' },
  }
  for (const f of cmd.flags) options[f.name] = { type: f.type === 'boolean' ? 'boolean' : 'string' }
  let parsed
  try {
    parsed = parseArgs({ args, options, allowPositionals: true, allowNegative: true })
  } catch (e) {
    throw usage(e instanceof Error ? e.message.split('. ')[0]! : 'invalid arguments')
  }
  const { values, positionals } = parsed
  if (positionals.length !== cmd.pathParams.length) {
    const want = cmd.pathParams.map((p) => `<${p}>`).join(' ')
    throw usage(`${cmd.resource} ${cmd.action} takes ${cmd.pathParams.length} positional argument(s)${want ? `: ${want}` : ''}; got ${positionals.length}`)
  }
  let path = cmd.path
  cmd.pathParams.forEach((name, i) => {
    // The URL parser resolves "." and ".." segments, so these would address another route.
    if (['', '.', '..'].includes(positionals[i]!)) throw usage(`<${name}> must not be empty, "." or ".."`)
    path = path.replace(`{${name}}`, encodeURIComponent(positionals[i]!))
  })
  const all = values.all === true
  if (all && !cmd.paginated) throw usage(`--all applies to list operations only`)
  const output = typeof values.output === 'string' ? values.output : undefined
  if (output !== undefined && !cmd.binary) throw usage(`--output applies to binary operations only`)

  const query: [string, string][] = []
  const fromFlags: Record<string, unknown> = {}
  for (const f of cmd.flags) {
    const v = values[f.name]
    if (v === undefined) continue
    const typed = f.type === 'boolean' ? v === true : coerce(f, v as string)
    if (f.where === 'query') {
      if (Array.isArray(typed)) for (const item of typed) query.push([f.prop, String(item)])
      else query.push([f.prop, typeof typed === 'object' ? JSON.stringify(typed) : String(typed)])
    } else fromFlags[f.prop] = typed
  }

  let body: unknown
  const data = typeof values.data === 'string' ? await readData(values.data, io) : undefined
  if (data !== undefined && !cmd.hasBody) throw usage(`${cmd.resource} ${cmd.action} takes no request body`)
  if (cmd.hasBody) {
    const flagged = Object.keys(fromFlags).length > 0
    if (data !== undefined) {
      if (flagged) {
        if (typeof data !== 'object' || data === null || Array.isArray(data)) throw usage('flags can only be combined with a --data JSON object')
        body = { ...(data as Record<string, unknown>), ...fromFlags }
      } else body = data
    } else if (flagged || cmd.bodyRequired) body = { ...fromFlags }
  }
  return { path, query, body, all, output }
}
