import { z } from 'zod'
import { codecs } from '@vault/storage'
import { definePreparedResource } from '../storage/definition.js'

export type TaskRecord = {
  id: string
  organization_id: string
  title: string
  notes: string | null
  status: 'open' | 'done'
  due_at: string | null
  completed_at: string | null
  assignee_id: string | null
  created_by: string
  created_at: string
  updated_at: string
}

/**
 * The completion rule: `completed_at` follows `status`. Returns only the keys to change, so an update that
 * does not send `status`, or keeps a task done, leaves `completed_at` alone. This pure function is the ORACLE
 * of the rule: create applies it directly (there is no stored state yet); update expresses it as a SQL CASE
 * over the stored row (`computed` below), and a test proves the two agree on every case.
 */
export function taskCompletion(
  input: Record<string, unknown>,
  before: { status: 'open' | 'done' } | null,
  now: Date,
): { completed_at?: Date | null } {
  if (input.status === 'done') return before?.status === 'done' ? {} : { completed_at: now }
  if (input.status === 'open') return { completed_at: null }
  return {}
}

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
const update = create.partial()

export const tasks = definePreparedResource({
  name: 'tasks',
  eventName: 'task',
  table: 'tasks',
  record,
  create,
  update,
  filters: {
    status: { schema: z.enum(['open', 'done']) },
    assignee_id: { schema: z.uuid() },
  },
  references: { assignee_id: { table: 'principals' } },
  // Extension 1 (create only): there is no stored row yet, so the pure rule applies directly.
  prepare: ({ values, meta }) => {
    if (meta.op !== 'create') return {}
    const c = taskCompletion(values, null, meta.now)
    return 'completed_at' in c ? { completed_at: c.completed_at ? codecs.timestamp.write(c.completed_at) : null } : {}
  },
  // Extension 2 (update): the completion CASE over the STORED status, evaluated at commit.
  computed: ({ eb, values, now }) => {
    if (values.status === 'done') {
      return { completed_at: eb.case().when('tasks.status', '=', 'done').then(eb.ref('tasks.completed_at')).else(codecs.timestamp.write(now)).end() }
    }
    if (values.status === 'open') return { completed_at: null }
    return {}
  },
})
