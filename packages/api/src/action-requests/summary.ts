// [[AGT588]] D8: the server-written summary of an action request, one deterministic line per operation class. Every value in it can be outside content (a
// contact's display name, a subject), so each one is stripped of invisible characters (D4's rule), has its control characters turned to spaces, is quoted and
// is clamped, which keeps a hostile value from posing as the vault's own words.
import { stripInvisibleCharacters } from '../channels/invisible-characters.js'

export const VALUE_MAX = 80
export const SUMMARY_MAX = 500
const NAMED_RECIPIENTS = 5
const FIELD_NAMES_SHOWN = 8

const clampTo = (text: string, max: number): string => {
  const chars = [...text]
  return chars.length <= max ? text : `${chars.slice(0, max - 1).join('')}…`
}

/** One interpolated value, made safe: stripped, control characters (and line separators) to single spaces, trimmed, clamped to 80 characters. */
export function clean(value: string): string {
  return clampTo(
    stripInvisibleCharacters(value)
      // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are exactly what is replaced here
      .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, ' ')
      .replace(/ {2,}/g, ' ')
      .trim(),
    VALUE_MAX,
  )
}
/** `clean`, then in double quotes (a double quote inside becomes a single quote, so it cannot close the quotation early). */
export const quoted = (value: string): string => `"${clean(value).replaceAll('"', "'")}"`

const LABEL_COLUMNS = ['name', 'title', 'subject'] as const
/**
 * The record's label: its `name` column if the table has one, else `title`, else `subject`; the id when that column is NULL or blank, or the table has
 * none of them. Null when there is no row. The column decides, not the value: a contact with a NULL name is its id, never its `subject`.
 */
export function labelOf(row: Record<string, unknown> | null, id: string | null): string | null {
  if (row === null) return null
  for (const column of LABEL_COLUMNS) {
    if (!(column in row)) continue
    const v = row[column]
    return typeof v === 'string' && v.trim() !== '' ? v : id
  }
  return id
}

/** The label of a record being created: read from the arguments by the same rule, with no id to fall back to. */
export function argumentLabel(args: Record<string, unknown>): string | null {
  for (const column of LABEL_COLUMNS) {
    if (!(column in args)) continue
    const v = args[column]
    return typeof v === 'string' && v.trim() !== '' ? v : null
  }
  return null
}

export interface SendFacts {
  /** The connection's address; null when the connection is not there. */
  mailbox: string | null
  /** A reply's thread subject; null when the thread has none or is not there. */
  threadSubject: string | null
}

const recipients = (args: Record<string, unknown>): string => {
  const list = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [])
  const visible = [...list(args.to), ...list(args.cc)]
  const bcc = list(args.bcc).length
  const named = visible.slice(0, NAMED_RECIPIENTS).map(clean)
  const more = visible.length - named.length
  const head = named.length === 0 ? 'no one' : named.join(', ')
  return `${head}${more > 0 ? ` and ${more} more` : ''}${bcc > 0 ? ` (bcc: ${bcc})` : ''}`
}

const sendSummary = (args: Record<string, unknown>, facts: SendFacts, threadId: string | null): string => {
  const from = facts.mailbox === null ? 'an unknown mailbox' : clean(facts.mailbox)
  if (args.mode === 'reply') {
    const thread = facts.threadSubject ?? threadId ?? ''
    return `Reply from ${from} in ${quoted(thread)} to ${recipients(args)}`
  }
  return `Send a new email from ${from} to ${recipients(args)}: ${quoted(typeof args.subject === 'string' ? args.subject : '')}`
}

export interface SummaryInput {
  operation: string
  /** The operation's flat arguments as proposed. */
  args: Record<string, unknown>
  /** The names of the arguments that are not the changed fields (the path parameters: the target's id). */
  paramKeys: readonly string[]
  /** The stored target record read at create (an id-bearing operation), or null. */
  target: Record<string, unknown> | null
  targetId: string | null
  send?: SendFacts
}

/** The target's label, or its id when no row was given (the proposer may not read it, 588.31); null for an operation with no target record. */
const targetLabel = (input: SummaryInput): string | null =>
  input.target === null ? input.targetId : labelOf(input.target, input.targetId)

/** The whole summary, at most 500 characters. */
export function summarise(input: SummaryInput): string {
  const { operation, args } = input
  const [resource = operation, verb = ''] = operation.split('.')
  const record = (label: string | null) => (label === null ? '' : ` ${quoted(label)}`)
  let text: string
  if (operation === 'messages.send')
    text = sendSummary(
      args,
      input.send ?? { mailbox: null, threadSubject: null },
      typeof args.thread_id === 'string' ? args.thread_id : null,
    )
  else if (verb === 'create') text = `Create ${resource} record${record(argumentLabel(args))}`
  else if (verb === 'update') {
    const fields = Object.keys(args).filter((k) => !input.paramKeys.includes(k))
    const shown = fields.slice(0, FIELD_NAMES_SHOWN).map(clean)
    const rest = fields.length - shown.length
    const list = shown.length === 0 ? 'none' : `${shown.join(', ')}${rest > 0 ? ` and ${rest} more` : ''}`
    text = `Update ${resource} record${record(targetLabel(input))} (fields: ${list})`
  } else if (verb === 'delete') text = `Delete ${resource} record${record(targetLabel(input))}`
  else {
    const label = targetLabel(input)
    text = label === null ? operation : `${operation} on ${resource} record ${quoted(label)}`
  }
  return clampTo(text, SUMMARY_MAX)
}
