// [[UI468]] P2, P3 ([[UI458]] D7): STUB for the red commit; the pure capture-settings form model arrives with the implementation.
export type ContactCreation = 'sent' | 'sent_and_received' | 'none'
export interface SettingsValues {
  labels: string[]
  otherLabels: string[]
  blocked: string[]
  excludeGroupAddresses: boolean
  excludePersonalDomains: boolean
  contactCreation: ContactCreation
}
export interface CaptureRecord {
  capture_labels: string[]
  blocked_senders: Array<{ kind: 'address' | 'domain'; value: string }>
  exclude_group_addresses: boolean
  exclude_personal_domains: boolean
  contact_creation: ContactCreation
}
export type UpdateBody = Record<string, unknown>
export type UpdateResult =
  | { kind: 'unchanged' }
  | { kind: 'invalid'; message: string }
  | { kind: 'changes'; body: UpdateBody }
export const SYSTEM_LABEL_OPTIONS: { id: string; name: string }[] = []
export function valuesFromRecord(_r: CaptureRecord): SettingsValues {
  return {
    labels: [],
    otherLabels: [],
    blocked: [],
    excludeGroupAddresses: false,
    excludePersonalDomains: false,
    contactCreation: 'sent',
  }
}
export function buildUpdate(_initial: SettingsValues, _current: SettingsValues): UpdateResult {
  return { kind: 'unchanged' }
}
export function saveAction(_r: { status: number; code?: string }): 'saved' | 'invalid' | 'reload' | 'failed' {
  return 'failed'
}
