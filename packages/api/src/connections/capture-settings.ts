// [[CHN406]] D11 stub for the red run: the real module lands with the implementation commit.
import type { QueryContext, Read, Row } from '@vibase/storage'

export interface CaptureSettings {
  connection_id: string
  capture_labels: string[]
  blocked_addresses: string[]
  blocked_domains: string[]
  exclude_group_addresses: boolean
  exclude_personal_domains: boolean
  contact_creation: 'sent_and_received' | 'sent' | 'none'
}

export function captureSettingsRead(
  _qc: QueryContext,
  _organizationId: string,
  _connectionId: string,
): { read: Read; decode: (row: Row | null) => CaptureSettings | null } {
  throw new Error('not implemented')
}
