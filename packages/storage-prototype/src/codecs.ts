import { ApiError, tasks, contacts, identities } from '@vault/api'
export const jsonValue = (v: any): any => (typeof v === 'string' ? JSON.parse(v) : v)
export function decodeTask(rows: Record<string, any>[]) {
  if (!rows.length) throw new ApiError(404, 'not_found', 'task not found')
  return {
    value: tasks.record.parse(jsonValue(rows[0].value)),
    eventOrder: rows[0].event_id ? [{ id: rows[0].event_id, ordinal: 0 }] : [],
  }
}
export function decodeResolve(rows: Record<string, any>[]) {
  const value = rows.map((row) => {
    const r = jsonValue(row.value)
    return {
      identity: identities.record.parse(r.identity),
      contact: r.contact === null ? null : contacts.record.parse(r.contact),
      created: r.created as boolean,
    }
  })
  const ids = rows.flatMap((r) => [r.contact_event, r.identity_event].filter(Boolean)) as string[]
  return { value, eventOrder: ids.map((id, ordinal) => ({ id, ordinal })) }
}
