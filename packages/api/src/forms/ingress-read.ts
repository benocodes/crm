import type { QueryContext, Read, Row } from '@vibase/storage'

// CHN424 red stub: the read arrives with the implementation.
export interface FormIngress {
  form_id: string
  organization_id: string
  name: string
  enabled: boolean
  allowed_origins: string[]
  email_field: string | null
  phone_field: string | null
  name_field: string | null
  consent_text: string | null
  tag_ids: string[]
}
export function formIngressRead(
  _qc: QueryContext,
  _publicId: string,
): { read: Read; decode: (row: Row | null) => FormIngress | null } {
  throw new Error('not implemented')
}
