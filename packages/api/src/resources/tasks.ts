import { codecs } from '@vibase/storage'
import { extendDefinition, type ExtensionFields } from '../custom/extension-fields.js'
import { createSchema, filterOptions, recordSchema, updateSchema } from '../declarations/builtin.js'
import { tasksDeclaration } from '../declarations/tasks.js'
import { deleteTaskOperation } from '../identity/cascades.js'
import type { Bag } from '../storage/additional-props.js'
import { withPropertyBag } from '../storage/bag-filter.js'
import { definePreparedResource } from '../storage/definition.js'
import { withColumnSorts } from '../storage/sorts.js'
import { withAggregate } from '../storage/aggregate.js'
import { withColumnFilters } from '../storage/column-filters.js'
import { defaultBuiltIns, type BuiltInLookup } from './built-ins.js'
import { tagIdFilter, tagNameFilter } from './tag-filter.js'

export type TaskRecord = {
  id: string
  organization_id: string
  title: string
  notes: string | null
  status: 'open' | 'done'
  due_at: string | null
  completed_at: string | null
  assignee_id: string | null
  additional_props: Bag
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

// [[CORE554]]: the record, create and update schemas, the filters and the sorts are derived from the declaration (`declarations/tasks.ts`).
const record = recordSchema<TaskRecord>(tasksDeclaration)
const create = createSchema(tasksDeclaration)
const update = updateSchema(tasksDeclaration)

/** [[CORE559]]: `ext` is the tasks' `extend` entry; `builtIns` the set this definition belongs to (its delete cascade reads it when it runs). */
export function defineTasks(ext: ExtensionFields | undefined, builtIns: () => BuiltInLookup) {
  const tasksBase = withColumnFilters(
    withColumnSorts(
      extendDefinition(
        definePreparedResource({
          surface: 'api',
          name: 'tasks',
          eventName: 'task',
          table: 'tasks',
          associable: true,
          customFilters: { tag_id: tagIdFilter('tasks'), tag: tagNameFilter('tasks') },
          override: { delete: (env, id) => deleteTaskOperation(env, id as string, builtIns()) },
          record,
          create,
          update,
          filters: filterOptions(tasksDeclaration),
          references: { assignee_id: { table: 'principals' } },
          // Extension 1 (create only): there is no stored row yet, so the pure rule applies directly.
          prepare: ({ values, meta }) => {
            if (meta.op !== 'create') return {}
            const c = taskCompletion(values, null, meta.now)
            return 'completed_at' in c
              ? { completed_at: c.completed_at ? codecs.timestamp.write(c.completed_at) : null }
              : {}
          },
          // Extension 2 (update): the completion CASE over the STORED status, evaluated at commit.
          computed: ({ eb, values, now }) => {
            if (values.status === 'done') {
              return {
                completed_at: eb
                  .case()
                  .when('tasks.status', '=', 'done')
                  .then(eb.ref('tasks.completed_at'))
                  .else(codecs.timestamp.write(now))
                  .end(),
              }
            }
            if (values.status === 'open') return { completed_at: null }
            return {}
          },
        }),
        ext,
      ),
      tasksDeclaration.sorts,
    ),
  )

  /** [[CORE549]] D10: the list takes the bag filter, `additional_props=<key>.<condition>`. */
  return withPropertyBag(withAggregate(tasksBase))
}

export const tasks = defineTasks(undefined, defaultBuiltIns)
