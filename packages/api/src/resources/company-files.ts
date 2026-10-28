import { z } from 'zod'
import type { PreparedResource } from '../storage/definition.js'

// STUB (red phase): the real definition lands in Phase 3.
export const companyFiles = { name: 'company_files', record: z.object({}), create: z.strictObject({}) } as never as PreparedResource<any, any>
