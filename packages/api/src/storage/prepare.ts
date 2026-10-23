import { COLUMN_KINDS, codecs, type ColumnKind } from '@vault/storage'
import type { Actor } from '../context.js'
import { ApiError } from '../errors.js'
import { parseInput, parseListQuery } from '../resources/define.js'
import type { PreparedResource, Values } from './definition.js'

// Pure preparation of a write or a list query: validation, the agent-field check and normalization.
// No I/O, no clock, synchronous ([[CORE35]] D3 extension 1). Messages and statuses are the old ones.

const kindsOf = (def: PreparedResource): Record<string, ColumnKind> => COLUMN_KINDS[def.table] as Record<string, ColumnKind>

/** Canonical stored forms: lowercase UUID text, ISO-8601 UTC timestamps. Other values are untouched. */
function normalize(def: PreparedResource, values: Values): Values {
  const kinds = kindsOf(def)
  const out: Values = {}
  for (const [key, value] of Object.entries(values)) {
    if (typeof value === 'string' && kinds[key] === 'uuid') out[key] = value.toLowerCase()
    else if (typeof value === 'string' && kinds[key] === 'timestamp') out[key] = codecs.timestamp.write(value)
    else out[key] = value
  }
  return out
}

function checkAgentFields(def: PreparedResource, actor: Actor, input: Values): void {
  if (actor.kind !== 'agent') return
  const writable = new Set(def.agentWritable ?? [...Object.keys(def.create?.shape ?? {}), ...Object.keys(def.update?.shape ?? {})])
  const denied = Object.keys(input).filter((k) => !writable.has(k))
  if (denied.length > 0) throw new ApiError(400, 'field_not_writable', `agents may not write: ${denied.join(', ')}`)
}

export function prepareCreate(def: PreparedResource, actor: Actor, input: unknown): Values {
  if (!def.create) throw new Error(`${def.name} has no create schema`)
  const parsed = parseInput(def.create, input)
  checkAgentFields(def, actor, parsed)
  return normalize(def, parsed)
}

export function prepareUpdate(def: PreparedResource, actor: Actor, input: unknown): Values {
  if (!def.update) throw new Error(`${def.name} has no update schema`)
  const parsed = parseInput(def.update, input)
  checkAgentFields(def, actor, parsed)
  return normalize(def, parsed)
}

export function prepareListQuery(
  def: PreparedResource,
  raw: { after?: unknown; limit?: unknown; filters?: Record<string, string> },
): { after: string | null; limit: number; filters: Record<string, unknown> } {
  const q = parseListQuery(def, raw)
  return { after: q.after === null ? null : q.after.toLowerCase(), limit: q.limit, filters: normalize(def, q.filters) }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
/** A path id that is not a UUID is simply "not found" (old behaviour); the canonical form is lowercase. */
export function canonicalId(def: PreparedResource, id: string): string {
  if (!UUID.test(id)) throw new ApiError(404, 'not_found', `${def.eventName} not found`)
  return id.toLowerCase()
}
