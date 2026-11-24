import { z } from 'zod'
import { BOOKKEEPING_FIELDS, IDENTITY_FIELDS, type BuiltInDeclaration } from './builtin.js'

/**
 * Deals ([[CORE554]], [[CORE130]]): a potential sale in one stage of one pipeline. `pipeline_id` follows the stage and `closed_at` follows the stage
 * kind, both set by `resources/deals.ts`; `stage_id` is create-only (it changes through `deals.move_stage`).
 */
export const dealsDeclaration = {
  table: 'deals',
  label: 'Deals',
  description:
    'A potential sale (also called an opportunity): a name, an optional amount and expected close date, an owner, sitting in one stage of one pipeline. Change the stage with deals.move_stage; link companies and contacts through associations.',
  fields: {
    ...IDENTITY_FIELDS,
    name: {
      kind: 'text',
      required: true,
      trim: true,
      minLength: 1,
      maxLength: 200,
      description: 'The deal name, 1 to 200 characters; not unique.',
    },
    pipeline_id: {
      kind: 'reference',
      target: 'pipelines',
      input: 'system',
      updateRefusal: 'a deal moves between stages of its pipeline with deals.move_stage',
      description: "The deal's pipeline; always the pipeline of its stage.",
      filter: { schema: z.uuid() },
    },
    stage_id: {
      kind: 'reference',
      target: 'pipeline_stages',
      required: true,
      input: 'create_only',
      updateRefusal: 'use deals.move_stage to change the stage',
      description: "The deal's stage; set when the deal is created and changed only with deals.move_stage.",
      filter: { schema: z.uuid() },
    },
    status: {
      kind: 'enum',
      values: ['open', 'won', 'lost'],
      derived: true,
      description: "The kind of the deal's stage: open, won or lost. Derived, read-only; filter with ?status=.",
      apiDescription: "The kind of the deal's stage: open, won or lost. Derived, read-only.",
    },
    amount_minor: {
      kind: 'integer',
      nullable: true,
      min: 0,
      max: Number.MAX_SAFE_INTEGER,
      description:
        "The deal value in the currency's minor units (cents; for a currency without a minor unit such as JPY, the unit). Optional; needs a currency.",
      apiDescription: "Optional, in the currency's minor units (cents; for JPY the unit). Needs a currency.",
      filterNote:
        'It compares the minor units of each deal in its own currency and does not need a currency filter: for one currency send amount_minor=gt.500000&currency=eq.USD.',
    },
    currency: {
      kind: 'text',
      nullable: true,
      pattern: { regex: /^[A-Za-z]{3}$/, message: 'currency must be a three letter ISO 4217 code' },
      description: 'Optional ISO 4217 code such as USD, stored upper case. Required when an amount is set.',
      apiDescription: 'Optional ISO 4217 code such as USD; stored upper case.',
      filter: { schema: z.string(), normalize: (v) => (v as string).toUpperCase() },
    },
    expected_close_date: {
      kind: 'text',
      format: 'date',
      nullable: true,
      description: 'Optional calendar date (YYYY-MM-DD) the deal is expected to close.',
      apiDescription: 'Optional calendar date, YYYY-MM-DD.',
    },
    owner_id: {
      kind: 'reference',
      target: 'principals',
      nullable: true,
      description: 'Optional: the user or agent responsible for the deal.',
      filter: { schema: z.uuid() },
    },
    closed_at: {
      kind: 'timestamp',
      nullable: true,
      input: 'system',
      description:
        'When the deal last became won or lost; null while it is open. Set by Vibase when the deal enters a won or lost stage (also at creation), cleared when it is reopened.',
    },
    ...BOOKKEEPING_FIELDS,
    created_by: { ...BOOKKEEPING_FIELDS.created_by, filter: { schema: z.uuid() } },
  },
  sorts: ['name'],
  filterOrder: ['pipeline_id', 'stage_id', 'owner_id', 'created_by', 'currency'],
} satisfies BuiltInDeclaration<'deals'>
