// Pure helpers: what a request looks like to a human. No DOM, so they are unit-tested.
export interface ActionRequest {
  id: string
  operation: string
  arguments: Record<string, unknown>
  edited_arguments: Record<string, unknown> | null
  status: string
  reason: string
  evidence: { type: 'message' | 'interaction'; id: string }[]
  contact_id: string | null
  thread_id: string | null
  expires_at: string
  decided_at: string | null
  decision_reason: string | null
  error_code: string | null
  error_message: string | null
  created_by: string
  created_at: string
}

/** "tasks.update" -> "Update task"; unknown shapes fall back to the raw name. */
export function operationTitle(op: string): string {
  const [resource, verb] = op.split('.')
  if (!resource || !verb) return op
  const noun = resource.replace(/_/g, ' ').replace(/s$/, '')
  return `${verb.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase())} ${noun}`
}

export function relativeTime(iso: string, now: number): string {
  const ms = Date.parse(iso) - now
  const abs = Math.abs(ms)
  const units: [number, string][] = [[86_400_000, 'd'], [3_600_000, 'h'], [60_000, 'min']]
  let text = 'now'
  for (const [size, label] of units) {
    if (abs >= size) {
      text = `${Math.floor(abs / size)} ${label}`
      break
    }
  }
  if (text === 'now') return 'just now'
  return ms >= 0 ? `in ${text}` : `${text} ago`
}

/** Arguments as the reviewer will approve them: the edited set when there is one. */
export const effectiveArguments = (r: ActionRequest): Record<string, unknown> => r.edited_arguments ?? r.arguments

export const prettyJson = (v: unknown): string => JSON.stringify(v, null, 2)

/** Newest first. */
export const byCreatedDesc = (a: ActionRequest, b: ActionRequest): number => Date.parse(b.created_at) - Date.parse(a.created_at)

export const isExpired = (r: ActionRequest, now: number): boolean => Date.parse(r.expires_at) <= now

export interface EmailPreview {
  mode: string
  to: string[]
  cc: string[]
  bcc: string[]
  subject: string
  /** The text of the message; null when the vault did not return it (only a descriptor came back). */
  body: string | null
}

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [])

/** A `messages.send` request as an email the reviewer can read; null for every other operation. */
export function emailPreview(r: ActionRequest): EmailPreview | null {
  if (r.operation !== 'messages.send') return null
  const a = effectiveArguments(r)
  return {
    mode: typeof a.mode === 'string' ? a.mode : 'new',
    to: strings(a.to),
    cc: strings(a.cc),
    bcc: strings(a.bcc),
    subject: typeof a.subject === 'string' ? a.subject : '',
    body: typeof a.body === 'string' ? a.body : null,
  }
}

/** The list endpoint returns a body descriptor; the single-record read returns the text. Take the arguments from the full record, the rest from the list. */
export const withFullArguments = (listed: ActionRequest, full: ActionRequest): ActionRequest => ({ ...listed, arguments: full.arguments, edited_arguments: full.edited_arguments })
