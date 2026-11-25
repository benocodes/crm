import { VibaseError } from './errors.js'

/** Column filters (DX608 D9): the typed operand/condition forms and the serialiser to the API's `[not.]<operator>.<operand>` grammar. */

export type FilterKind = 'uuid' | 'text' | 'integer' | 'timestamp' | 'boolean'

type OperandOf<K extends string> = K extends 'integer'
  ? number
  : K extends 'boolean'
    ? boolean
    : K extends 'timestamp'
      ? string | Date
      : string

type Conditions<K extends string, Ops extends string> = {
  [Op in Exclude<Ops, 'in' | 'is' | 'like' | 'ilike'>]?: OperandOf<K>
} & ('in' extends Ops ? { in?: readonly OperandOf<K>[] } : unknown) &
  ('is' extends Ops ? { is?: K extends 'boolean' ? boolean | null : null } : unknown) &
  ('like' extends Ops ? { like?: string } : unknown) &
  ('ilike' extends Ops ? { ilike?: string } : unknown)

/** What a filter parameter takes: a bare operand (equals), or an object of the field's operators, with `not` carrying the same again. */
export type Filter<K extends string, Ops extends string> =
  | OperandOf<K>
  | (Conditions<K, Ops> & { not?: Conditions<K, Ops> })

/** The filter parameters of an operation in the map: name to `[kind, operators]`. */
export type FilterSpecs = { [name: string]: readonly [kind: string, operators: string] }

export type FilterArgs<Args, F extends FilterSpecs> = Omit<Args, keyof F> & {
  [N in keyof F]?: Filter<F[N][0], F[N][1]>
}

export interface FilterEntry {
  readonly kind: string
  readonly operators: readonly string[]
  /** The most conditions the parameter takes (its array schema's `maxItems`). */
  readonly max: number
}

const refuse = (name: string, message: string) => new VibaseError(400, 'validation_error', `filter ${name}: ${message}`)

function operand(name: string, value: unknown): string {
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) throw refuse(name, 'the Date is invalid')
    return value.toISOString()
  }
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return String(value)
  throw refuse(name, `an operand is a string, number, boolean or Date, not ${value === null ? 'null' : typeof value}`)
}

/** An item of `in.(...)`: quoted when the grammar needs it (`,` `(` `)` `"`, a backslash, edge whitespace, empty). */
function listItem(name: string, value: unknown): string {
  const text = operand(name, value)
  return /[,()"\\]|^\s|\s$|^$/.test(text) ? `"${text.replace(/[\\"]/g, '\\$&')}"` : text
}

function conditions(name: string, spec: unknown, prefix: string, out: string[]): void {
  if (typeof spec !== 'object' || spec === null || Array.isArray(spec) || spec instanceof Date)
    throw refuse(name, 'takes an operand or an object of operators')
  for (const [op, value] of Object.entries(spec)) {
    if (value === undefined) continue
    if (op === 'not') {
      if (prefix !== '') throw refuse(name, 'not cannot be nested')
      conditions(name, value, 'not.', out)
    } else if (op === 'in') {
      if (!Array.isArray(value)) throw refuse(name, 'in takes a list')
      out.push(`${prefix}in.(${value.map((item) => listItem(name, item)).join(',')})`)
    } else if (op === 'is') {
      if (value !== null && typeof value !== 'boolean') throw refuse(name, 'is takes null, true or false')
      out.push(`${prefix}is.${value}`)
    } else out.push(`${prefix}${op}.${operand(name, value)}`)
  }
}

/** The repeated parameter values of one filter: a bare operand is `eq.<v>`, an object one condition per key (`not` keys counted too). */
export function serialiseFilter(name: string, value: unknown, entry: FilterEntry): string[] {
  const out: string[] = []
  if (typeof value === 'object' && value !== null && !(value instanceof Date)) conditions(name, value, '', out)
  else out.push(`eq.${operand(name, value)}`)
  if (out.length > entry.max)
    throw refuse(name, `at most ${entry.max} conditions (got ${out.length}); nothing was sent`)
  return out
}
