// Type fixtures ([[CORE35]] Step 1.1): compile-time proof that the generic helpers keep checking. Not a
// Vitest file (never discovered); `pnpm typecheck` includes it. Every `@ts-expect-error` sits on the exact
// offending expression and has a positive sibling; no `any` is involved around a call.
import { type Expression, type ExpressionBuilder, type SqlBool } from 'kysely'
import { eq, projectAs, publicSelect, selectColumns, type ColumnOf, type PublicColumn, type QueryContext, type StorageDatabase, type SyncHook, type Table, type ValueOf } from './index.js'

declare const qc: QueryContext

// --- positive siblings -------------------------------------------------------------------------------

const okSelect = selectColumns(qc, 'tasks', ['id', 'title', 'status'])
const okFilter = eq('tasks', 'status', 'open')
const okNullable = eq('tasks', 'assignee_id', null)
const okPublic = publicSelect(qc, 'api_keys', ['id', 'prefix'])
const okProjection = projectAs<{ id: string }>()(selectColumns(qc, 'tasks', ['id', 'title']))

// The inferred output of a helper is the exact Pick of the table's row.
async function inferred() {
  const rows = await okSelect.execute()
  const first: { id: string; title: string; status: 'open' | 'done' } = rows[0]!
  // @ts-expect-error title is a string, not a number
  const wrong: number = first.title
  return [first, wrong]
}
type StatusValue = ValueOf<'tasks', 'status'>
const status: StatusValue = 'done'
const columns: ColumnOf<'tasks'> = 'completed_at'
const publicColumns: PublicColumn<'api_keys'> = 'prefix'

// --- negative cases ----------------------------------------------------------------------------------

// unknown table
// @ts-expect-error 'nope' is not a table
selectColumns(qc, 'nope', ['id'])

// unknown column
// @ts-expect-error 'nope' is not a column of tasks
selectColumns(qc, 'tasks', ['nope'])

// a column of another table
// @ts-expect-error key_hash belongs to api_keys, not tasks
selectColumns(qc, 'tasks', ['key_hash'])

// wrong value type
// @ts-expect-error title is text
eq('tasks', 'title', 5)
// @ts-expect-error status is 'open' | 'done'
eq('tasks', 'status', 'blocked')
// @ts-expect-error assignee_id is a string or null, never undefined
eq('tasks', 'assignee_id', undefined)

// absent alias (Kysely's own checking, reachable through the exported context)
// @ts-expect-error 'tasks' is not in scope once the table is aliased to t
qc.db.selectFrom('tasks as t').select('tasks.title')

// incompatible projection
// @ts-expect-error id is a string, the record asks for a number
projectAs<{ id: number }>()(selectColumns(qc, 'tasks', ['id']))
// @ts-expect-error the projection lacks the record's `title`
projectAs<{ id: string; title: string }>()(selectColumns(qc, 'tasks', ['id']))

// secret column in a public projection
// @ts-expect-error key_hash is a secret column
publicSelect(qc, 'api_keys', ['id', 'key_hash'])

// async hook where a synchronous one is required
declare function defineHook<R extends object>(hook: SyncHook<{ title: string }, R>): void
defineHook((input) => ({ title: input.title }))
// @ts-expect-error a hook may not return a Promise
defineHook(async (input) => ({ title: input.title }))

// an extension guard referencing another table's column
declare function guard<T extends Table>(table: T, make: (eb: ExpressionBuilder<StorageDatabase, T>) => Expression<SqlBool>): void
guard('tasks', (eb) => eb('tasks.title', '=', 'x'))
// @ts-expect-error companies is not in scope of a tasks guard
guard('tasks', (eb) => eb('companies.name', '=', 'x'))
// @ts-expect-error a tasks guard may not read api_keys.key_hash
guard('tasks', (eb) => eb('api_keys.key_hash', '=', 'x'))

export { inferred, okFilter, okNullable, okProjection, okPublic, publicColumns, status, columns }
