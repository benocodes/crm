import { sql, type Expression, type SqlBool } from 'kysely'
import { z } from 'zod'
import type { QueryContext } from '@vault/storage'
import type { DerivedDecl, JoinFilter } from '../storage/definition.js'

// [[CORE131]] D3, D7: the two derived activity fields of a contact and the six list filters over them. The derivation is one
// scalar subquery per field, correlated on the contact: contact -> its live identities -> their participant rows -> the
// interactions (D10: each step is an index SEARCH). No kind, role or channel is named, so a new interaction kind counts with no change.

const REQUIRES = [{ resource: 'interactions', action: 'read' }] as const
const PG_ISO = 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'

/** `MAX(interactions.occurred_at)` over the interactions of the contact's live identities, as ISO text; `outboundOnly` restricts it to what we sent. */
function latest(outboundOnly: boolean) {
  return (qc: QueryContext, parent: (column: string) => Expression<unknown>): Expression<unknown> => {
    const max = sql`max("interactions"."occurred_at")`
    const value = qc.dialect === 'postgres' ? sql`to_char(${max} at time zone 'UTC', ${sql.lit(PG_ISO)})` : max
    // CROSS JOIN pins SQLite's join order (contact -> identities -> participants -> interactions): left to itself the planner starts
    // from `interaction_participants` by organisation alone and walks every participant row per contact. Postgres ignores the hint.
    return sql`(select ${value}
      from "identities"
      cross join "interaction_participants"
      cross join "interactions"
      where "identities"."contact_id" = ${parent('id')} and "identities"."organization_id" = ${parent('organization_id')} and "identities"."deleted_at" is null
        and "interaction_participants"."organization_id" = "identities"."organization_id" and "interaction_participants"."identity_id" = "identities"."id"
        and "interactions"."organization_id" = "interaction_participants"."organization_id" and "interactions"."id" = "interaction_participants"."interaction_id"${outboundOnly ? sql` and "interactions"."direction" = 'outbound'` : sql``})`
  }
}

/** The derived declarations of `contacts`. */
export const contactDerived = {
  last_contacted_at: {
    kind: 'timestamp',
    expression: latest(true),
    requires: REQUIRES,
    filters: ['contacted_since', 'not_contacted_since', 'never_contacted'],
  },
  last_interacted_at: {
    kind: 'timestamp',
    expression: latest(false),
    requires: REQUIRES,
    filters: ['interacted_since', 'not_interacted_since', 'never_interacted'],
  },
} as const satisfies Record<string, DerivedDecl<'timestamp'>>

/** An ISO-8601 date-time with `Z` or an offset, normalised to UTC milliseconds (the stored form). A date alone or a relative value does not parse. */
const instant = z.iso.datetime({ offset: true })
const utc = (v: unknown): string => new Date(v as string).toISOString()
/** `true` or `false` only: `z.coerce.boolean()` would read "false" as true. */
const flag = z.enum(['true', 'false'])

type Field = keyof typeof contactDerived
const valueOf = (field: Field, qc: QueryContext, parent: (column: string) => Expression<unknown>) => contactDerived[field].expression(qc, parent)
const parentOf = (column: string) => sql.ref(`contacts.${column}`)

const filter = (field: Field, schema: z.ZodType, normalize: JoinFilter['normalize'], where: (value: Expression<unknown>, v: unknown) => Expression<SqlBool>, description: string): JoinFilter => ({
  schema: schema.describe(description),
  ...(normalize ? { normalize } : {}),
  requires: REQUIRES,
  where: (qc, v) => where(valueOf(field, qc, parentOf), v),
})
const since = (field: Field, what: string) =>
  filter(field, instant, utc, (value, v) => sql<SqlBool>`${value} >= ${v as string}`, `Only contacts ${what} at or after this ISO-8601 time (Z or an offset). Needs interactions:read.`)
const notSince = (field: Field, what: string) =>
  filter(field, instant, utc, (value, v) => sql<SqlBool>`(${value} is null or ${value} < ${v as string})`, `Only contacts ${what} before this ISO-8601 time (Z or an offset), including those never ${what.replace(/ (contacted|interacted)$/, '')}. Needs interactions:read.`)
const never = (field: Field, what: string) =>
  filter(field, flag, (v) => v === 'true', (value, v) => (v === true ? sql<SqlBool>`${value} is null` : sql<SqlBool>`${value} is not null`), `true: only contacts never ${what}; false: only contacts ${what} at least once. Needs interactions:read.`)

/** The six join filters of `contacts.list`, ANDed with the others. */
export const contactActivityFilters = {
  contacted_since: since('last_contacted_at', 'last contacted'),
  not_contacted_since: notSince('last_contacted_at', 'last contacted'),
  never_contacted: never('last_contacted_at', 'contacted'),
  interacted_since: since('last_interacted_at', 'last interacted with'),
  not_interacted_since: notSince('last_interacted_at', 'last interacted with'),
  never_interacted: never('last_interacted_at', 'interacted with'),
} as const satisfies Record<string, JoinFilter>
