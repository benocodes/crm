// [[UI468]] P2, P3 ([[UI458]] D7): the capture-settings form as a pure model. Record to form values; form values to the `connections.update` body with only the changed fields.
// Labels and blocked senders compare as sets (order carries no meaning for capture), blocked senders lowercased as the server stores them, so a reload never shows a spurious change.
// Client refusals are the cheap rules only (no labels at all); everything else is the server's `400`.
export type ContactCreation = 'sent' | 'sent_and_received' | 'none'

/** P2: the system labels offered as switches, by name, in this order. */
export const SYSTEM_LABEL_OPTIONS: { id: string; name: string }[] = [
  { id: 'INBOX', name: 'Inbox' },
  { id: 'SENT', name: 'Sent' },
  { id: 'STARRED', name: 'Starred' },
  { id: 'IMPORTANT', name: 'Important' },
  { id: 'CATEGORY_PERSONAL', name: 'Personal tab' },
  { id: 'CATEGORY_SOCIAL', name: 'Social tab' },
  { id: 'CATEGORY_PROMOTIONS', name: 'Promotions tab' },
  { id: 'CATEGORY_UPDATES', name: 'Updates tab' },
  { id: 'CATEGORY_FORUMS', name: 'Forums tab' },
]
const SYSTEM_IDS = SYSTEM_LABEL_OPTIONS.map((o) => o.id)

export interface SettingsValues {
  /** The checked system labels (ids, offered order). */
  labels: string[]
  /** Every other stored label id, the editor's list. */
  otherLabels: string[]
  /** Blocked senders as their values (an address or a domain). */
  blocked: string[]
  excludeGroupAddresses: boolean
  excludePersonalDomains: boolean
  contactCreation: ContactCreation
}
export interface CaptureRecord {
  capture_labels?: string[]
  blocked_senders?: Array<{ kind: 'address' | 'domain'; value: string }>
  exclude_group_addresses?: boolean
  exclude_personal_domains?: boolean
  contact_creation?: ContactCreation
}
export interface UpdateBody {
  capture_labels?: string[]
  blocked_senders?: Array<{ kind: 'address' | 'domain'; value: string }>
  exclude_group_addresses?: boolean
  exclude_personal_domains?: boolean
  contact_creation?: ContactCreation
}
export type UpdateResult =
  | { kind: 'unchanged' }
  | { kind: 'invalid'; message: string }
  | { kind: 'changes'; body: UpdateBody }

export const NO_LABELS = 'Choose at least one label.'

export function valuesFromRecord(r: CaptureRecord): SettingsValues {
  const stored = r.capture_labels ?? []
  return {
    labels: SYSTEM_IDS.filter((id) => stored.includes(id)),
    otherLabels: stored.filter((id) => !SYSTEM_IDS.includes(id)),
    blocked: (r.blocked_senders ?? []).map((b) => b.value),
    excludeGroupAddresses: r.exclude_group_addresses ?? false,
    excludePersonalDomains: r.exclude_personal_domains ?? false,
    contactCreation: r.contact_creation ?? 'sent',
  }
}

/** The labels as sent: checked system labels in the offered order, then the editor's ids, deduplicated. */
function labelList(v: SettingsValues): string[] {
  return [...new Set([...SYSTEM_IDS.filter((id) => v.labels.includes(id)), ...v.otherLabels])]
}
const sameSet = (a: readonly string[], b: readonly string[]): boolean => {
  const x = new Set(a)
  const y = new Set(b)
  return x.size === y.size && [...x].every((v) => y.has(v))
}
const lower = (list: readonly string[]) => list.map((v) => v.trim().toLowerCase())

/** D7: a value containing `@` is an address, else a domain. */
export const blockedEntry = (value: string): { kind: 'address' | 'domain'; value: string } => ({
  kind: value.includes('@') ? 'address' : 'domain',
  value,
})

export function buildUpdate(initial: SettingsValues, current: SettingsValues): UpdateResult {
  const body: UpdateBody = {}
  const labels = labelList(current)
  if (labels.length === 0) return { kind: 'invalid', message: NO_LABELS }
  if (!sameSet(labels, labelList(initial))) body.capture_labels = labels
  if (!sameSet(lower(current.blocked), lower(initial.blocked))) body.blocked_senders = current.blocked.map(blockedEntry)
  if (current.excludeGroupAddresses !== initial.excludeGroupAddresses)
    body.exclude_group_addresses = current.excludeGroupAddresses
  if (current.excludePersonalDomains !== initial.excludePersonalDomains)
    body.exclude_personal_domains = current.excludePersonalDomains
  if (current.contactCreation !== initial.contactCreation) body.contact_creation = current.contactCreation
  return Object.keys(body).length === 0 ? { kind: 'unchanged' } : { kind: 'changes', body }
}

/** D7: what a `connections.update` answer means. `400` is shown, `403 not_connection_owner` and `404` mean ownership or existence changed (read the view again). */
export function saveAction(r: { status: number; code?: string }): 'saved' | 'invalid' | 'reload' | 'failed' {
  if (r.status === 200) return 'saved'
  if (r.status === 400) return 'invalid'
  if (r.status === 404 || (r.status === 403 && r.code === 'not_connection_owner')) return 'reload'
  return 'failed'
}
