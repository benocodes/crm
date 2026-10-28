import { CodecError } from './errors.js'
import type { Dialect } from './types.js'

// Codecs for the real driver differences ([[CORE35]] C1): timestamps (Date | text), JSON (object | text),
// booleans (boolean | 0/1) and arrays (native | JSON text). Reads produce the one public shape; writes
// produce what each dialect binds. Malformed values are rejected, never coerced.

const ISO = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(\.\d+)?(Z|[+-]\d{2}(?::?\d{2})?)$/

function parseTimestamp(value: string): string {
  const m = ISO.exec(value)
  if (!m) throw new CodecError(`not a timestamp with a time and zone: ${JSON.stringify(value)}`)
  const zone = m[8] === 'Z' ? 'Z' : m[8]!.length === 3 ? `${m[8]}:00` : m[8]!.includes(':') ? m[8]! : `${m[8]!.slice(0, 3)}:${m[8]!.slice(3)}`
  const ms = Date.parse(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}${(m[7] ?? '').slice(0, 4)}${zone}`)
  if (Number.isNaN(ms)) throw new CodecError(`not a valid timestamp: ${JSON.stringify(value)}`)
  return new Date(ms).toISOString()
}

const nullable =
  <T>(read: (value: unknown) => T) =>
  (value: unknown): T | null =>
    value === null || value === undefined ? null : read(value)

const timestampRead = (value: unknown): string => {
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) throw new CodecError('invalid Date')
    return value.toISOString()
  }
  if (typeof value === 'string') return parseTimestamp(value)
  throw new CodecError(`not a timestamp: ${typeof value}`)
}

const jsonRead = (value: unknown): unknown => {
  if (typeof value === 'string') {
    try {
      return JSON.parse(value)
    } catch (cause) {
      throw new CodecError(`not valid JSON text: ${(cause as Error).message}`)
    }
  }
  if (value !== null && typeof value === 'object') return value
  throw new CodecError(`not JSON: ${typeof value}`)
}

const booleanRead = (value: unknown): boolean => {
  if (value === true || value === 1) return true
  if (value === false || value === 0) return false
  throw new CodecError(`not a boolean: ${JSON.stringify(value)}`)
}

const stringArrayRead = (value: unknown): string[] => {
  const parsed = typeof value === 'string' ? jsonRead(value) : value
  if (!Array.isArray(parsed) || parsed.some((v) => typeof v !== 'string')) throw new CodecError('not an array of strings')
  return parsed as string[]
}

// STUB (red phase): the integer codec is implemented in Phase 3.
const integerStub = { read: (_value: unknown): number => 0, readNullable: (_value: unknown): number | null => null, write: (value: number): number => value }

export const codecs = {
  integer: integerStub,
  timestamp: {
    read: timestampRead,
    readNullable: nullable(timestampRead),
    /** ISO-8601 UTC text with milliseconds, from a Date or a text that has a time and a zone. */
    write: (value: Date | string): string => (value instanceof Date ? timestampRead(value) : parseTimestamp(value)),
  },
  json: {
    read: jsonRead,
    readNullable: nullable(jsonRead),
    write: (value: unknown): string | null => (value === null ? null : JSON.stringify(value)),
  },
  boolean: {
    read: booleanRead,
    readNullable: nullable(booleanRead),
    write: (value: boolean, dialect: Dialect): boolean | 0 | 1 => (dialect === 'd1' ? (value ? 1 : 0) : value),
  },
  stringArray: {
    read: stringArrayRead,
    readNullable: nullable(stringArrayRead),
    write: (value: readonly string[], dialect: Dialect): readonly string[] | string => (dialect === 'd1' ? JSON.stringify(value) : value),
  },
} as const
