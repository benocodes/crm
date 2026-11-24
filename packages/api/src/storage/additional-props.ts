import { z } from 'zod'
import { ApiError } from '../errors.js'

// [[CORE318]] D2, D3, D4, D7: the schemaless property bag of the four built-in objects. The bag is a flat object of scalars written as a one-level
// merge patch on the stamp-guarded before row. The limits live here (API validation, 400 validation_error), never in the database, whose CHECK
// only asks for a JSON object.

export type BagValue = string | number | boolean
export type Bag = Record<string, BagValue>
export type BagPatch = Record<string, BagValue | null>

export const BAG_LIMITS = { keys: 50, bytes: 8192, string: 1000, keyLength: 64 } as const
/** D7: lowercase snake_case, one optional `<prefix>:` separator, no dot, no double underscore. */
export const BAG_KEY = /^[a-z0-9]+(_[a-z0-9]+)*(:[a-z0-9]+(_[a-z0-9]+)*)?$/

/** The compact UTF-8 size of a bag as stored. */
export const bagBytes = (bag: Bag): number => new TextEncoder().encode(JSON.stringify(bag)).length

/** The refusal text for a key, or null when it is acceptable. */
export function keyProblem(key: string): string | null {
  if (key.length > BAG_LIMITS.keyLength) return `key "${key}" is longer than ${BAG_LIMITS.keyLength} characters`
  if (!BAG_KEY.test(key))
    return `key "${key}" must be lowercase snake_case with at most one ':' prefix separator (letters a-z, digits, single underscores; no dot, capital or double underscore)`
  return null
}

/** The refusal text for a value, or null when it is acceptable (null removes a key and is accepted by the caller before this). */
export function valueProblem(key: string, value: unknown): string | null {
  if (typeof value === 'string') {
    return value.length > BAG_LIMITS.string
      ? `additional_props.${key}: a string is at most ${BAG_LIMITS.string} characters`
      : null
  }
  if (typeof value === 'number')
    return Number.isFinite(value) ? null : `additional_props.${key}: a number must be finite`
  if (typeof value === 'boolean') return null
  return `additional_props.${key}: a value must be a string, number or boolean (no objects, arrays or null; null removes the key)`
}

/** The refusal text when a whole bag breaks the key-count or size limit, or null when it fits. */
export function bagProblem(bag: Bag): string | null {
  const keys = Object.keys(bag).length
  if (keys > BAG_LIMITS.keys) return `additional_props: more than ${BAG_LIMITS.keys} keys (${keys})`
  const bytes = bagBytes(bag)
  if (bytes > BAG_LIMITS.bytes)
    return `additional_props: more than ${BAG_LIMITS.bytes} bytes of compact JSON (${bytes})`
  return null
}

export const ADDITIONAL_PROPS_DESCRIPTION =
  'A flat object of extra facts about this record that no typed field holds. Keys: lowercase snake_case, at most 64 characters, at most one ":" prefix separator, no dot or double underscore. ' +
  `Values: a string of at most ${BAG_LIMITS.string} characters, a finite number or a boolean; no nested objects, arrays or stored null. At most ${BAG_LIMITS.keys} keys and ${BAG_LIMITS.bytes} bytes of compact JSON in all. ` +
  'Writing is a merge patch: the keys you send are set, a key sent as null is removed, keys you do not name are kept; the whole bag cannot be replaced and additional_props: null is refused. ' +
  "Convention: a plain fact about the thing takes a plain shared key (linkedin_title) so agents reuse it; a judgment (a grade, a classification) takes the judging agent's prefix (scorer:lead_grade). " +
  'Reads return the whole bag, {} when empty.'

/** The write input: an object of scalars and nulls, each key and value checked, refused with the key and the rule named. */
export const additionalPropsInput = z
  .record(z.string(), z.unknown())
  .superRefine((patch, ctx) => {
    for (const [key, value] of Object.entries(patch)) {
      const problem = keyProblem(key) ?? (value === null ? null : valueProblem(key, value))
      if (problem) ctx.addIssue({ code: 'custom', message: problem, path: [key] })
    }
  })
  .describe(ADDITIONAL_PROPS_DESCRIPTION)

/** The record's bag: always an object, `{}` when empty. */
export const additionalPropsRecord = z
  .record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
  .describe(ADDITIONAL_PROPS_DESCRIPTION)

/** A bag with a patch applied (D4): keys set, `null` removes, unnamed keys kept. Refuses a result over the key-count or size limit (D2). */
export function applyBagPatch(before: Bag, patch: BagPatch): Bag {
  const out: Bag = { ...before }
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete out[key]
    else out[key] = value
  }
  const problem = bagProblem(out)
  if (problem) throw new ApiError(400, 'validation_error', problem)
  return out
}

/**
 * [[CORE318]] D6: the survivor's bag after the source's keys are filled in, in the source's key order. A source key the survivor has is skipped, and
 * so is a key that would push the result past the key-count or size limit (it stays on the source). Never throws.
 */
export function fillBag(survivor: Bag, source: Bag): Bag {
  const out: Bag = { ...survivor }
  for (const [key, value] of Object.entries(source)) {
    if (Object.hasOwn(out, key)) continue
    const next = { ...out, [key]: value }
    if (bagProblem(next) === null) out[key] = value
  }
  return out
}
