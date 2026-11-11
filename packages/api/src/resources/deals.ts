import { sql } from 'kysely'
import { z } from 'zod'
import { codecs, readMaybe } from '@vault/storage'
import { ApiError } from '../errors.js'
import { deleteDealOperation } from '../identity/cascades.js'
import { definePreparedResource, type DerivedDecl, type CustomFilter } from '../storage/definition.js'
import { withColumnFilters } from '../storage/column-filters.js'
import { withAggregate } from '../storage/aggregate.js'
import { withColumnSorts } from '../storage/sorts.js'
import { linkedToFilter, tagNameFilter } from './tag-filter.js'

export type DealRecord = {
  id: string
  organization_id: string
  name: string
  pipeline_id: string
  stage_id: string
  /** Derived ([[CORE130]] D8): the kind of the deal's stage. */
  status?: 'open' | 'won' | 'lost'
  amount_minor: number | null
  currency: string | null
  expected_close_date: string | null
  owner_id: string | null
  closed_at: string | null
  created_by: string
  created_at: string
  updated_at: string
}

const STATUSES = ['open', 'won', 'lost'] as const

const record = z.object({
  id: z.uuid(),
  organization_id: z.uuid(),
  name: z.string(),
  pipeline_id: z.uuid(),
  stage_id: z.uuid(),
  status: z
    .enum(STATUSES)
    .optional()
    .describe("The kind of the deal's stage: open, won or lost. Derived, read-only."),
  amount_minor: z.number().int().nullable(),
  currency: z.string().nullable(),
  expected_close_date: z.string().nullable(),
  owner_id: z.uuid().nullable(),
  closed_at: z.string().nullable(),
  created_by: z.uuid(),
  created_at: z.string(),
  updated_at: z.string(),
})

// [[CORE130]] D7: integer minor units, an ISO 4217-shaped code (upper-cased on write), a calendar date; the amount needs a currency (judged
// on the resulting row, below). `closed_at` is never input (D11), `pipeline_id` follows the stage (D9), `stage_id` changes through `deals.move_stage`.
const fields = {
  name: z.string().trim().min(1).max(200),
  amount_minor: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).nullable().optional().describe("Optional, in the currency's minor units (cents; for JPY the unit). Needs a currency."),
  currency: z.string().regex(/^[A-Za-z]{3}$/, 'currency must be a three letter ISO 4217 code').nullable().optional().describe('Optional ISO 4217 code such as USD; stored upper case.'),
  expected_close_date: z.iso.date().nullable().optional().describe('Optional calendar date, YYYY-MM-DD.'),
  owner_id: z.uuid().nullable().optional(),
}
const create = z.strictObject({ ...fields, stage_id: z.uuid() })
const update = z.strictObject(fields).partial()

const needsCurrency = () => new ApiError(400, 'validation_error', 'an amount needs a currency: send currency with amount_minor')

/** The kind of the stage `ref` names, as a scalar subquery ([[CORE130]] D8, D11): in the unit's organisation, so another organisation's stage has no kind. */
const stageKind = (stageId: unknown, organizationId: unknown) =>
  sql<string>`(select "pipeline_stages"."kind" from "pipeline_stages" where "pipeline_stages"."id" = ${stageId} and "pipeline_stages"."organization_id" = ${organizationId})`

const dealDerived = {
  status: {
    kind: 'text',
    expression: (_qc, parent) => stageKind(parent('stage_id'), parent('organization_id')),
    filters: ['status'],
  },
} as const satisfies Record<string, DerivedDecl<'text'>>

const statusFilter: CustomFilter = {
  schema: z.enum(STATUSES).describe("Only deals whose stage is of this kind: open, won or lost."),
  where: (_qc, value) =>
    sql<boolean>`exists (select 1 from "pipeline_stages" where "pipeline_stages"."id" = ${sql.ref('deals.stage_id')} and "pipeline_stages"."organization_id" = ${sql.ref('deals.organization_id')} and "pipeline_stages"."kind" = ${value as string})`,
}

/**
 * Deals ([[CORE130]]): a potential sale in one stage of one pipeline, records on the `api` surface. `pipeline_id` is the stage's, selected in the
 * insert itself (`createComputed`), and `closed_at` follows the stage kind (D11): a create into a won or lost stage is closed at once. The stage
 * must be a live one of this organisation (the generic reference check, re-checked at commit). `stage_id` and `pipeline_id` are refused on update:
 * the stage changes through `deals.move_stage` (`deals/operations.ts`). `status` is derived from the stage and never in an event.
 */
export const deals = withAggregate(withColumnFilters(withColumnSorts(definePreparedResource({
  surface: 'api',
  name: 'deals',
  eventName: 'deal',
  table: 'deals',
  record,
  derived: dealDerived,
  create,
  update,
  createOnly: { stage_id: 'use deals.move_stage to change the stage', pipeline_id: 'a deal moves between stages of its pipeline with deals.move_stage' },
  // [[CORE199]] D6, D8: per-column options of the column filter grammar (`withColumnFilters`, below): each UUID operand is validated, and a currency operand is upper-cased as stored.
  filters: { pipeline_id: { schema: z.uuid() }, stage_id: { schema: z.uuid() }, owner_id: { schema: z.uuid() }, created_by: { schema: z.uuid() }, currency: { schema: z.string(), normalize: (v) => (v as string).toUpperCase() } },
  associable: true,
  // [[CORE130]] D14: a deal links to the records around it; deal-deal and deal-interaction links are refused (the 400 names this list).
  neighbours: ['companies', 'contacts', 'notes', 'tags', 'tasks', 'threads'],
  override: { delete: (env, id) => deleteDealOperation(env, id as string) },
  customFilters: {
    status: statusFilter,
    tag_id: linkedToFilter('deals', 'tags', 'Only deals linked to this tag.'),
    tag: tagNameFilter('deals'),
    company_id: linkedToFilter('deals', 'companies', 'Only deals linked to this company (an association).'),
    contact_id: linkedToFilter('deals', 'contacts', 'Only deals linked to this contact (an association).'),
  },
  references: { stage_id: { table: 'pipeline_stages', live: true }, owner_id: { table: 'principals' } },
  prepare: ({ values, meta }) => {
    // Pure parts of the amount rule; a patch that sets only one of the pair is judged against the stored row in `conflicts`.
    if (meta.op === 'create' && values.amount_minor != null && values.currency == null) throw needsCurrency()
    if (meta.op === 'update' && values.amount_minor != null && values.currency === null) throw needsCurrency()
    return typeof values.currency === 'string' ? { currency: values.currency.toUpperCase() } : {}
  },
  createComputed: ({ env, values }) => ({
    pipeline_id: sql<string>`(select "pipeline_stages"."pipeline_id" from "pipeline_stages" where "pipeline_stages"."id" = ${values.stage_id as string} and "pipeline_stages"."organization_id" = ${env.organizationId})`,
    // D11: a new deal is closed at once when it starts in a won or lost stage.
    closed_at: sql<string | null>`case when ${stageKind(values.stage_id as string, env.organizationId)} = 'open' then null else ${codecs.timestamp.write(env.now)} end`,
  }),
  conflicts: ({ qc, env, op, id, values }) => {
    if (op !== 'update' || !id) return []
    const touchesAmount = typeof values.amount_minor === 'number'
    const clearsCurrency = values.currency === null && !('amount_minor' in values)
    if (!touchesAmount && !clearsCurrency) return []
    if (touchesAmount && typeof values.currency === 'string') return []
    // The patch sets only the amount, or clears only the currency: the resulting row is the stored one plus the patch.
    return [
      {
        read: readMaybe(qc.db.selectFrom('deals').select(['deals.amount_minor', 'deals.currency']).where('deals.id', '=', id).where('deals.organization_id', '=', env.organizationId).where('deals.deleted_at', 'is', null)),
        refuse: (row) => {
          if (!row) return
          const amount = 'amount_minor' in values ? values.amount_minor : row.amount_minor
          const currency = 'currency' in values ? values.currency : row.currency
          if (amount != null && currency == null) throw needsCurrency()
        },
      },
    ]
  },
}), ['name']), {
  amount_minor: 'It compares the minor units of each deal in its own currency and does not need a currency filter: for one currency send amount_minor=gt.500000&currency=eq.USD.',
}), {
  // [[CORE199]] D15: money fields of the aggregate, with the column that holds their currency: summing across currencies is refused.
  amount_minor: 'currency',
})
