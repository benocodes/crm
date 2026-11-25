import { sql } from 'kysely'
import { readMaybe, StorageError, type QueryContext, type Read, type Row } from '@vibase/storage'

/**
 * What [[CHN421]]'s ingress needs of a form ([[CHN420]] D14): plain data, so a workflow step or a queue message can carry it (invariant 7). `tag_ids` are the live tags only, sorted; `allowed_origins` are the stored
 * rows, sorted. The actor of a submission is `{ id: form_id, kind: 'agent' }`.
 */
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
  /** The visitor check this form requires: `none` skips it, `turnstile` demands a passed Turnstile token. */
  challenge: 'none' | 'turnstile'
  tag_ids: string[]
}

/**
 * A plan-phase read composable into a prepared program's `reads` (`reads: (qc) => ({ form: f.read })`), then `f.decode(found.maybe(key))` in `build` or `decode`. ONE query per call: both lists are aggregated in the
 * row. It reads by `public_id` alone (a D1 database is one organisation, the ingress takes the organisation from the deployment marker). `decode` answers null when no live form has that public id (unknown or
 * deleted); a disabled form is returned with `enabled: false`, so the caller chooses its answer without a second read. D1 only.
 * [[CHN424]] P6: shipped dormant, with no caller; [[CHN421]] wires it.
 */
export function formIngressRead(
  qc: QueryContext,
  publicId: string,
): { read: Read; decode: (row: Row | null) => FormIngress | null } {
  if (qc.dialect !== 'd1') throw new StorageError('formIngressRead is D1 only')
  const query = qc.db
    .selectFrom('forms')
    .select([
      'forms.id as form_id',
      'forms.organization_id',
      'forms.name',
      'forms.enabled',
      'forms.email_field',
      'forms.phone_field',
      'forms.name_field',
      'forms.consent_text',
      'forms.challenge',
      sql<string>`(select json_group_array("form_allowed_origins"."origin" order by "form_allowed_origins"."origin") from "form_allowed_origins" where "form_allowed_origins"."form_id" = "forms"."id" and "form_allowed_origins"."organization_id" = "forms"."organization_id")`.as(
        'allowed_origins',
      ),
      sql<string>`(select json_group_array("form_tags"."tag_id" order by "form_tags"."tag_id") from "form_tags" join "tags" on "tags"."id" = "form_tags"."tag_id" where "form_tags"."form_id" = "forms"."id" and "form_tags"."organization_id" = "forms"."organization_id" and "tags"."deleted_at" is null)`.as(
        'tag_ids',
      ),
    ])
    .where('forms.public_id', '=', publicId)
    .where('forms.deleted_at', 'is', null)
  return { read: readMaybe(query), decode: decodeFormIngress }
}

const list = (value: unknown): string[] => {
  const parsed = typeof value === 'string' ? (JSON.parse(value) as unknown) : value
  return Array.isArray(parsed) ? [...(parsed as string[])].sort() : []
}
const orNull = (v: unknown): string | null => (v === null || v === undefined ? null : String(v))

export function decodeFormIngress(row: Row | null): FormIngress | null {
  if (!row) return null
  return {
    form_id: String(row.form_id),
    organization_id: String(row.organization_id),
    name: String(row.name),
    enabled: row.enabled === true || row.enabled === 1 || row.enabled === '1',
    allowed_origins: list(row.allowed_origins),
    email_field: orNull(row.email_field),
    phone_field: orNull(row.phone_field),
    name_field: orNull(row.name_field),
    consent_text: orNull(row.consent_text),
    // Anything but an explicit 'none' keeps the check (closed on every doubt).
    challenge: row.challenge === 'none' ? 'none' : 'turnstile',
    tag_ids: list(row.tag_ids),
  }
}
