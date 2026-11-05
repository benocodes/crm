import { z } from 'zod'
import type { TenantOperation } from '../registry.js'
import { deals } from '../resources/deals.js'
import { moveStageOperation } from './move-stage.js'

const moveBody = z.strictObject({ stage_id: z.uuid() })

/** The deal commands ([[CORE130]] D10): everything else on deals is the generic CRUD of its definition. */
export function dealOperations(): TenantOperation[] {
  return [
    {
      kind: 'tenant',
      surface: 'api',
      name: 'deals.move_stage',
      summary: 'Move a deal (also called an opportunity) to another stage of its pipeline',
      description:
        'The only way to change a deal\'s stage. The stage must be a stage of the deal\'s own pipeline (see pipeline_stages_list). Moving into a won or lost stage closes the deal (closed_at); moving to an open stage reopens it. Moving to the stage the deal is already in changes nothing. Emits deal.stage_changed.',
      tags: ['deals'],
      method: 'post',
      path: '/deals/{id}/move-stage',
      scope: { resource: 'deals', action: 'write' },
      validation: 'adapter',
      request: { params: z.object({ id: z.uuid() }), body: moveBody },
      response: { status: 200, schema: deals.record },
      prepare: (env, input) => moveStageOperation(env, input.params.id as string, (input.body as z.infer<typeof moveBody>).stage_id),
    },
  ]
}
