import { z } from 'zod'
import type { PreparedResource } from '../storage/definition.js'

// STUB (red phase): the real definition lands in Phase 3.
export const interactions = { name: 'interactions', record: z.object({}), create: z.strictObject({}) } as never as PreparedResource<any, any>
