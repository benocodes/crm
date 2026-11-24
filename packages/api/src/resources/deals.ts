import { sql } from 'kysely'
import { z } from 'zod'
import { codecs, readMaybe } from '@vibase/storage'
import { ApiError } from '../errors.js'
import { extendDefinition, type ExtensionFields } from '../custom/extension-fields.js'
import {
  createSchema,
  filterNotes,
  filterOptions,
  recordSchema,
  updateRefusals,
  updateSchema,
} from '../declarations/builtin.js'
import { DEAL_STATUSES, dealsDeclaration } from '../declarations/deals.js'
import { deleteDealOperation } from '../identity/cascades.js'
import type { Bag } from '../storage/additional-props.js'
import { withPropertyBag } from '../storage/bag-filter.js'
import { definePreparedResource, type DerivedDecl, type CustomFilter } from '../storage/definition.js'
import { withColumnFilters } from '../storage/column-filters.js'
import { withAggregate } from '../storage/aggregate.js'
import { withColumnSorts } from '../storage/sorts.js'
import { defaultBuiltIns, type BuiltInLookup } from './built-ins.js'
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
  additional_props: Bag
  created_by: string
  created_at: string
  updated_at: string
}

// [[CORE554]]: the record, create and update schemas, the filters and the sorts are derived from the declaration (`declarations/deals.ts`).
// [[CORE130]] D7: integer minor units, an ISO 4217-shaped code (upper-cased on write), a calendar date; the amount needs a currency (judged
// on the resulting row, below). `closed_at` is never input (D11), `pipeline_id` follows the stage (D9), `stage_id` changes through `deals.move_stage`.
const record = recordSchema<DealRecord>(dealsDeclaration)
const create = createSchema(dealsDeclaration)
const update = updateSchema(dealsDeclaration)

const needsCurrency = () =>
  new ApiError(400, 'validation_error', 'an amount needs a currency: send currency with amount_minor')

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
  schema: z.enum(DEAL_STATUSES).describe('Only deals whose stage is of this kind: open, won or lost.'),
  where: (_qc, value) =>
    sql<boolean>`exists (select 1 from "pipeline_stages" where "pipeline_stages"."id" = ${sql.ref('deals.stage_id')} and "pipeline_stages"."organization_id" = ${sql.ref('deals.organization_id')} and "pipeline_stages"."kind" = ${value as string})`,
}

/**
 * Deals ([[CORE130]]): a potential sale in one stage of one pipeline, records on the `api` surface. `pipeline_id` is the stage's, selected in the
 * insert itself (`createComputed`), and `closed_at` follows the stage kind (D11): a create into a won or lost stage is closed at once. The stage
 * must be a live one of this organisation (the generic reference check, re-checked at commit). `stage_id` and `pipeline_id` are refused on update:
 * the stage changes through `deals.move_stage` (`deals/operations.ts`). `status` is derived from the stage and never in an event.
 */
export function defineDeals(ext: ExtensionFields | undefined, builtIns: () => BuiltInLookup) {
  const dealsBase = withAggregate(
    withColumnFilters(
      withColumnSorts(
        extendDefinition(
          definePreparedResource({
            surface: 'api',
            name: 'deals',
            eventName: 'deal',
            table: 'deals',
            record,
            derived: dealDerived,
            create,
            update,
            createOnly: updateRefusals(dealsDeclaration),
            filters: filterOptions(dealsDeclaration),
            associable: true,
            // [[CORE130]] D14: a deal links to the records around it; deal-deal and deal-interaction links are refused (the 400 names this list).
            neighbours: ['companies', 'contacts', 'notes', 'tags', 'tasks', 'threads'],
            override: { delete: (env, id) => deleteDealOperation(env, id as string, builtIns()) },
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
              closed_at: sql<
                string | null
              >`case when ${stageKind(values.stage_id as string, env.organizationId)} = 'open' then null else ${codecs.timestamp.write(env.now)} end`,
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
                  read: readMaybe(
                    qc.db
                      .selectFrom('deals')
                      .select(['deals.amount_minor', 'deals.currency'])
                      .where('deals.id', '=', id)
                      .where('deals.organization_id', '=', env.organizationId)
                      .where('deals.deleted_at', 'is', null),
                  ),
                  refuse: (row) => {
                    if (!row) return
                    const amount = 'amount_minor' in values ? values.amount_minor : row.amount_minor
                    const currency = 'currency' in values ? values.currency : row.currency
                    if (amount != null && currency == null) throw needsCurrency()
                  },
                },
              ]
            },
          }),
          ext,
        ),
        dealsDeclaration.sorts,
      ),
      filterNotes(dealsDeclaration),
    ),
    {
      // [[CORE199]] D15: money fields of the aggregate, with the column that holds their currency: summing across currencies is refused.
      amount_minor: 'currency',
    },
  )

  /** [[CORE549]] D10: the list takes the bag filter, `additional_props=<key>.<condition>`. */
  return withPropertyBag(dealsBase)
}

export const deals = defineDeals(undefined, defaultBuiltIns)
