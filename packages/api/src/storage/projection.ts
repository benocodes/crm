import type { PreparedEnv, PreparedResource } from './definition.js'

// [[API514]] D6: the ONE projection point of a record's content fields. Every output path that renders a record (the prepared core's list and
// get, an association read that embeds one, the event feed's decode, the webhook payload) calls `projectRecord` or `projectEvent`; none strips
// a key on its own. Synchronous and DB-free. It takes the record, not only the caller's scopes, so [[CORE515]] can make the level depend on
// the record's mailbox at this same point.

/** How much of a record the caller may see: `subject` is the record without its content fields, `everything` is the whole record. */
export type ContentLevel = 'subject' | 'everything'
/** The caller the level is decided for: its closed scopes and its actor. */
export type Caller = Pick<PreparedEnv, 'scopes' | 'actor'>

/** The level this caller has on this record of the definition. A definition with no content fields is always `everything`. */
export function contentLevel(def: Pick<PreparedResource, 'content'>, caller: Caller, _record?: unknown): ContentLevel {
  const content = def.content
  return content === undefined || caller.scopes.has(content.requires) ? 'everything' : 'subject'
}

/** The record at the caller's level: below `everything` a copy without the content keys (absent, not null); at `everything` the record itself. */
export function projectRecord<R>(def: Pick<PreparedResource, 'content'>, caller: Caller, record: R): R {
  if (contentLevel(def, caller, record) === 'everything') return record
  const out = { ...(record as Record<string, unknown>) }
  for (const field of def.content!.fields) delete out[field]
  return out as R
}

/** What `projectEvent` needs of an event: the resource type and the stored record images. */
export interface ProjectableEvent {
  resource_type: string
  before: unknown
  after: unknown
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/**
 * An event as the caller may see it ([[API514]] D11): the `before` and `after` of an event of a resource whose definition declares content
 * go through `projectRecord`. The stored event is never changed (a read-time copy), and an event of any other type is returned as is.
 */
export function projectEvent<E extends ProjectableEvent>(
  defs: readonly Pick<PreparedResource, 'eventName' | 'content'>[],
  caller: Caller,
  event: E,
): E {
  const def = defs.find((d) => d.eventName === event.resource_type && d.content !== undefined)
  if (def === undefined) return event
  const side = (image: unknown) => (isRecord(image) ? projectRecord(def, caller, image) : image)
  return { ...event, before: side(event.before), after: side(event.after) }
}
