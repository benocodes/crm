// Type fixtures at the definePreparedResource call site ([[CORE35]] D3, review F1). Not a Vitest file; `pnpm
// typecheck` includes it. Every `@ts-expect-error` sits on the exact offending expression, each has a positive
// sibling, and nothing is cast around the call.
import { z } from 'zod'
import { definePreparedResource } from './definition.js'

const filter = { schema: z.string() }
const tasksRecord = z.object({ id: z.uuid(), title: z.string(), status: z.enum(['open', 'done']), completed_at: z.string().nullable() })

// --- positive siblings -------------------------------------------------------------------------------

export const ok = definePreparedResource({
  name: 'tasks',
  eventName: 'task',
  table: 'tasks',
  record: tasksRecord,
  filters: { status: filter },
  references: { assignee_id: { table: 'principals' } },
  computed: ({ eb }) => ({ completed_at: eb.case().when('tasks.status', '=', 'done').then(eb.ref('tasks.completed_at')).else('2026-10-22T09:00:00.000Z').end(), title: 'x' }),
  guards: (eb) => [eb('tasks.title', '=', 'x')],
})
// A record may be a subset of the columns, and the inferred record type flows out.
export const title: string = ok.record.parse({}).title

// --- negative cases ----------------------------------------------------------------------------------

// unknown record column
definePreparedResource({
  name: 'tasks',
  eventName: 'task',
  table: 'tasks',
  // @ts-expect-error 'bogus' is not a column of tasks
  record: z.object({ id: z.uuid(), bogus: z.string() }),
})

// secret record column
definePreparedResource({
  name: 'api_keys',
  eventName: 'api_key',
  table: 'api_keys',
  // @ts-expect-error key_hash is a secret column
  record: z.object({ id: z.uuid(), key_hash: z.string() }),
})
export const okKeys = definePreparedResource({ name: 'api_keys', eventName: 'api_key', table: 'api_keys', record: z.object({ id: z.uuid(), prefix: z.string() }) })

// record value incompatible with the column
definePreparedResource({
  name: 'tasks',
  eventName: 'task',
  table: 'tasks',
  // @ts-expect-error title is text, the record says number
  record: z.object({ id: z.uuid(), title: z.number() }),
})

// unknown computed column
definePreparedResource({
  name: 'tasks',
  eventName: 'task',
  table: 'tasks',
  record: tasksRecord,
  // @ts-expect-error 'bogus' is not a column of tasks
  computed: () => ({ bogus: 'x' }),
})

// wrong computed value type
definePreparedResource({
  name: 'tasks',
  eventName: 'task',
  table: 'tasks',
  record: tasksRecord,
  // @ts-expect-error completed_at is a timestamp text or null, not a number
  computed: () => ({ completed_at: 5 }),
})

// unknown filter column
definePreparedResource({
  name: 'tasks',
  eventName: 'task',
  table: 'tasks',
  record: tasksRecord,
  // @ts-expect-error 'bogus' is not a column of tasks
  filters: { bogus: filter },
})

// unknown reference column
definePreparedResource({
  name: 'tasks',
  eventName: 'task',
  table: 'tasks',
  record: tasksRecord,
  // @ts-expect-error 'bogus' is not a column of tasks
  references: { bogus: { table: 'principals' } },
})

// guard on another table
definePreparedResource({
  name: 'tasks',
  eventName: 'task',
  table: 'tasks',
  record: tasksRecord,
  // @ts-expect-error companies is not in scope of a tasks guard
  guards: (eb) => [eb('companies.name', '=', 'x')],
})
