import type { PreparedEnv, PreparedResource } from './definition.js'

// STUB (red commit): the projection is not built yet.
export type ContentLevel = 'subject' | 'everything'
export type Caller = Pick<PreparedEnv, 'scopes' | 'actor'>

export function contentLevel(_def: PreparedResource, _caller: Caller, _record?: unknown): ContentLevel {
  return 'everything'
}

export function projectRecord<R>(_def: PreparedResource, _caller: Caller, record: R): R {
  return record
}
