import { z } from 'zod'
import { ApiError } from '../errors.js'

// [[CORE133]] D9: the opaque cursor of a sorted list, base64url of the JSON array `[sort, order, value or null, id]`.
// Unsigned: a cursor is "tampered" only when it is malformed. A well-formed cursor someone edited is a legitimate position,
// because the caller can already read every value it could encode.

export type SortOrder = 'asc' | 'desc'
export const SORT_ORDERS: readonly SortOrder[] = ['asc', 'desc']
/** The sortable metadata kinds, and the cursor value each one carries. */
export type SortKind = 'timestamp' | 'uuid' | 'text' | 'integer'
export type SortValue = string | number | null
/** Where a sorted page starts after: the last row's sort value (`null` for a row with none) and its id. */
export interface SortPosition {
  readonly value: SortValue
  readonly id: string
}
/** A parsed sort request. `position` is absent on the first page. */
export interface SortRequest {
  readonly field: string
  readonly order: SortOrder
  readonly kind: SortKind
  readonly position: SortPosition | null
}

const bad = (why: string) => new ApiError(400, 'validation_error', `after is not a valid cursor for this sort: ${why}`)
const UUID = z.uuid()
const ISO = z.iso.datetime()
const BASE64URL = /^[A-Za-z0-9_-]+$/

/** A cursor value fits the kind of the sorted field: ISO text for a timestamp, a string for text, a whole number for an integer, or null. */
function valueOf(kind: SortKind, value: unknown): SortValue {
  if (value === null) return null
  if (kind === 'timestamp' && ISO.safeParse(value).success) return value as string
  if (kind === 'uuid' && UUID.safeParse(value).success) return (value as string).toLowerCase()
  if (kind === 'text' && typeof value === 'string') return value
  if (kind === 'integer' && typeof value === 'number' && Number.isSafeInteger(value)) return value
  throw bad('the value does not fit the sorted field')
}

export function encodeCursor(field: string, order: SortOrder, value: SortValue, id: string): string {
  const bytes = new TextEncoder().encode(JSON.stringify([field, order, value, id]))
  let binary = ''
  for (const b of bytes) binary += String.fromCharCode(b)
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '')
}

/** Decodes `after` for the requested sort and order; anything malformed, or bound to another sort or order, is `400 validation_error`. */
export function decodeCursor(raw: unknown, field: string, order: SortOrder, kind: SortKind): SortPosition {
  if (typeof raw !== 'string' || !BASE64URL.test(raw)) throw bad('not base64url text')
  let parsed: unknown
  try {
    const binary = atob(raw.replaceAll('-', '+').replaceAll('_', '/'))
    const text = new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(binary, (c) => c.charCodeAt(0)))
    parsed = JSON.parse(text)
  } catch {
    throw bad('it does not decode')
  }
  if (!Array.isArray(parsed) || parsed.length !== 4) throw bad('it is not a four-element array')
  const [cursorSort, cursorOrder, value, id] = parsed as unknown[]
  if (typeof cursorSort !== 'string' || (cursorOrder !== 'asc' && cursorOrder !== 'desc')) throw bad('the sort or order is malformed')
  if (typeof id !== 'string' || !UUID.safeParse(id).success) throw bad('the id is not a UUID')
  const position = { value: valueOf(kind, value), id: id.toLowerCase() }
  if (cursorSort !== field || cursorOrder !== order) throw bad(`it belongs to sort=${cursorSort} order=${cursorOrder}, not sort=${field} order=${order}`)
  if (field === 'id' && position.value !== position.id) throw bad('the value does not fit the sorted field')
  return position
}
