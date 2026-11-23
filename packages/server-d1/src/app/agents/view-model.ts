// [[UI459]] D3-D8 ([[UI458]]): the Agents page's logic as a pure view model: how an agent connected, its permissions line, its dates, the order, which actions and detail a row offers, and the outcome of a toggle. No DOM, no network; dates come in through a formatter.
import type { ApiResult } from '../session/api.js'
import type { AgentRecord } from '../session/types.js'

export interface AgentRowModel {
  id: string
  name: string
  disabled: boolean
  status: { text: 'Enabled' | 'Disabled'; tone: 'success' | 'neutral' }
  /** D3 order: how it connected, permissions, dates, then (a form's agent only) the managed-by line. */
  meta: string[]
  /** D5: the toggle this row offers; none for readers and for a form's agent. */
  action: 'disable' | 'enable' | null
  /** D7: the CLI line for an owner and an agent with no scopes; never for a form's agent. */
  grantCommand: string | null
  /** D6: the agent of a listed form. */
  formManaged: boolean
}
export interface AgentsView {
  /** D8: `agents:read`. Without it the page shows no-access text and reads nothing. */
  access: boolean
  /** D8: `agents:write`, on a page that may be read. */
  canWrite: boolean
  rows: AgentRowModel[]
}
export type ToggleOutcome =
  | { kind: 'updated'; record: AgentRecord; announce: string }
  | { kind: 'reload' }
  | { kind: 'form'; text: string }
  | { kind: 'error'; text: string }

/** D6: also the sentence shown for `409 form_principal`. */
export const FORM_MANAGED_LINE = 'Managed by its form: disable or delete the form to stop it.'

/** D3, [[UI459]] P4: the order of the deleted connect page's view-model checks (`delegated_by` or `auth_client_id` first, then `auth_subject`), new wording. A form's agent (D6) replaces all of them. */
export function connectedText(a: AgentRecord, meId: string, formName?: string): string {
  if (formName !== undefined) return `Website form ${formName}`
  if (a.delegated_by !== null)
    return a.delegated_by === meId ? 'Signed in through you' : 'Signed in through another member'
  if (a.auth_client_id !== null) return `Connected through OAuth client ${a.auth_client_id}`
  if (a.auth_subject !== null) return 'Agent account'
  return 'API-key agent'
}

const ACTION_ORDER = ['read_metadata', 'read', 'request_approval', 'write']
const ACTION_TEXT: Record<string, string> = { request_approval: 'propose', read_metadata: 'read metadata' }

/** D4: "Permissions: contacts (read, write), tasks (read)"; grouped by resource in the scopes' sorted order, `request_approval` shown as "propose". */
export function permissionsLine(scopes: readonly string[]): string {
  if (scopes.length === 0) return 'No permissions yet'
  const groups = new Map<string, string[]>()
  for (const scope of [...scopes].sort()) {
    const at = scope.indexOf(':')
    const resource = at < 0 ? scope : scope.slice(0, at)
    const actions = groups.get(resource) ?? []
    if (at >= 0) actions.push(scope.slice(at + 1))
    groups.set(resource, actions)
  }
  const rank = (action: string) => {
    const i = ACTION_ORDER.indexOf(action)
    return i < 0 ? ACTION_ORDER.length : i
  }
  const parts = [...groups].map(([resource, actions]) => {
    if (actions.length === 0) return resource
    const sorted = [...actions].sort((x, y) => rank(x) - rank(y) || (x < y ? -1 : x > y ? 1 : 0))
    return `${resource} (${sorted.map((x) => ACTION_TEXT[x] ?? x).join(', ')})`
  })
  return `Permissions: ${parts.join(', ')}`
}

/** D3: "Created <date>", plus "; disabled <date>" when disabled. */
export function datesLine(a: AgentRecord, fmt: (iso: string) => string): string {
  const created = `Created ${fmt(a.created_at)}`
  return a.disabled_at === null ? created : `${created}; disabled ${fmt(a.disabled_at)}`
}

/** D3: enabled before disabled, then name (case-insensitive), then id. */
export function sortAgents(agents: readonly AgentRecord[]): AgentRecord[] {
  return [...agents].sort(
    (a, b) =>
      Number(a.disabled_at !== null) - Number(b.disabled_at !== null) ||
      a.name.localeCompare(b.name, undefined, { sensitivity: 'accent' }) ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  )
}

/** D7: the line an owner sees for an agent with no scopes ([[UI30]] D12, kept by [[UI459]]). */
export const grantCommand = (id: string): string =>
  `vibase agents update ${id} --scopes '["contacts:read","contacts:write"]'`

export function buildAgentsView(input: {
  scopes: readonly string[]
  meId: string
  agents: AgentRecord[]
  /** form id to form name; `null` when forms were not read (no `forms:read`, or the read failed). */
  forms: ReadonlyMap<string, string> | null
  formatDate: (iso: string) => string
}): AgentsView {
  const { scopes, meId, forms, formatDate } = input
  if (!scopes.includes('agents:read')) return { access: false, canWrite: false, rows: [] }
  const canWrite = scopes.includes('agents:write')
  const rows = sortAgents(input.agents).map((a): AgentRowModel => {
    const formName = forms?.get(a.id)
    const formManaged = formName !== undefined
    const disabled = a.disabled_at !== null
    return {
      id: a.id,
      name: a.name,
      disabled,
      status: disabled ? { text: 'Disabled', tone: 'neutral' } : { text: 'Enabled', tone: 'success' },
      meta: [
        connectedText(a, meId, formName),
        permissionsLine(a.scopes),
        datesLine(a, formatDate),
        ...(formManaged ? [FORM_MANAGED_LINE] : []),
      ],
      action: !canWrite || formManaged ? null : disabled ? 'enable' : 'disable',
      grantCommand: canWrite && !formManaged && a.scopes.length === 0 ? grantCommand(a.id) : null,
      formManaged,
    }
  })
  return { access: true, canWrite, rows }
}

/** D5: what a toggle's answer means. `200` carries the record to show; `404` means the agent is gone (read again); `409 form_principal` is D6's sentence. */
export function toggleOutcome(r: ApiResult<AgentRecord>, name: string, disabled: boolean): ToggleOutcome {
  if (r.status === 200 && r.body)
    return { kind: 'updated', record: r.body, announce: `${disabled ? 'Disabled' : 'Enabled'} ${name}.` }
  if (r.status === 404) return { kind: 'reload' }
  if (r.status === 409 && r.code === 'form_principal') return { kind: 'form', text: FORM_MANAGED_LINE }
  return {
    kind: 'error',
    text: `Could not ${disabled ? 'disable' : 'enable'} ${name} (${r.code ?? r.status}). Try again.`,
  }
}
