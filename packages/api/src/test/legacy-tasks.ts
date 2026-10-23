// Test-only. The pre-migration `tasks` definition on the LEGACY interactive path. `tasks` itself is now served
// by the prepared executor ([[CORE35]]); the suites that exercise the legacy generic CRUD and the routing,
// auth and registry machinery around it keep using this stand-in until [[CORE37]] removes the legacy path.
import { z } from 'zod'
import { defineResource } from '../resources/define.js'
import { taskCompletion, type TaskRecord } from '../resources/tasks.js'

const record = z.object({
  id: z.uuid(),
  organization_id: z.uuid(),
  title: z.string(),
  notes: z.string().nullable(),
  status: z.enum(['open', 'done']),
  due_at: z.string().nullable(),
  completed_at: z.string().nullable(),
  assignee_id: z.uuid().nullable(),
  created_by: z.uuid(),
  created_at: z.string(),
  updated_at: z.string(),
})
const fields = {
  title: z.string().trim().min(1).max(500),
  notes: z.string().max(10_000).nullable().optional(),
  status: z.enum(['open', 'done']).optional(),
  due_at: z.iso.datetime({ offset: true }).nullable().optional(),
  assignee_id: z.uuid().nullable().optional(),
}
const create = z.strictObject(fields)

export const legacyTasks = defineResource<TaskRecord>({
  name: 'tasks',
  eventName: 'task',
  table: 'tasks',
  record,
  create,
  update: create.partial(),
  filters: { status: { schema: z.enum(['open', 'done']) }, assignee_id: { schema: z.uuid() } },
  references: { assignee_id: { table: 'principals' } },
  beforeWrite: (_ctx, { input, before }) => ({ ...input, ...taskCompletion(input, before, new Date()) }),
})
