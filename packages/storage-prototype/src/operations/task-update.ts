import { sql } from 'kysely'
import { SqlKit, raw } from '../sql-kit.js'
export function taskUpdate(k: SqlKit) {
  const o = k.op,
    { id, patch } = o.input
  const target = k.value(id, 'uuid'),
    org = k.value(o.context.organizationId, 'uuid')
  k.add(
    'snapshot',
    k.scratch(
      k.project('tasks', 't'),
      sql`FROM tasks t WHERE t.id=${target} AND t.organization_id=${org} AND t.deleted_at IS NULL`,
      'before',
      raw('0'),
      k.value(o.rowId, 'uuid'),
    ),
  )
  const from = sql`FROM ${raw(k.rows)} s JOIN tasks t ON t.id=${k.field('s.payload', 'id', 'uuid')} WHERE ${k.scope()} AND s.slot='before'`
  if (Object.keys(patch).length) {
    const assignments = Object.entries(patch).map(([key, v]) => sql`${raw(key)}=${k.value(v)}`)
    if (patch.status !== undefined)
      assignments.push(
        sql`completed_at=CASE WHEN ${k.value(patch.status)}='open' THEN NULL WHEN status<>'done' THEN ${k.value(o.now, 'timestamp')} ELSE completed_at END`,
      )
    if (k.dialect === 'd1') assignments.push(sql`updated_at=${k.now()}`)
    k.add(
      'first-mutation',
      sql`UPDATE tasks SET ${sql.join(assignments)} WHERE id=${target} AND organization_id=${org} AND EXISTS(SELECT 1 FROM ${raw(k.rows)} s WHERE ${k.scope()} AND s.slot='before')`,
    )
    k.event(
      'first-event',
      k.value(o.eventId, 'uuid'),
      'task',
      'updated',
      target,
      k.json(raw('s.payload')),
      k.project('tasks', 't'),
      from,
    )
  } else {
    // Keep stable stage labels for generic fault infrastructure, without an update/event.
    k.add('first-mutation', sql`SELECT 1 WHERE false`)
    k.add('first-event', sql`SELECT 1 WHERE false`)
  }
  k.add(
    'result',
    sql`SELECT ${k.project('tasks', 't')} AS value, e.id AS event_id FROM ${raw(k.rows)} s JOIN tasks t ON t.id=${k.field('s.payload', 'id', 'uuid')} LEFT JOIN events e ON e.id=${k.value(o.eventId, 'uuid')} WHERE ${k.scope()} AND s.slot='before'`,
  )
}
