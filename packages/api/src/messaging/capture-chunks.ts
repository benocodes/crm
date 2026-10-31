import { ApiError } from '../errors.js'
import { normalizeIdentityValue } from '../identity/normalize.js'
import type { CaptureMessage, CaptureParticipant } from './capture.js'

export type CaptureSkipReason = 'unsupported_sender' | 'too_many_participants' | 'too_many_attachments'

/**
 * Normalises a message's participants before capture ([[CORE25]] D48). A value `normalizeIdentityValue` refuses is dropped and
 * counted (never logged: it is an address); duplicates by `(role, kind, value)` keep the first, with its name; order is kept.
 * `skip` is `unsupported_sender` when no `from` survives.
 */
export function normalizeParticipants(raw: readonly CaptureParticipant[]): { participants: CaptureParticipant[]; dropped: number; skip: 'unsupported_sender' | null } {
  const participants: CaptureParticipant[] = []
  const seen = new Set<string>()
  let dropped = 0
  for (const p of raw) {
    let value: string
    try {
      value = normalizeIdentityValue(p.kind, p.value)
    } catch (err) {
      if (err instanceof ApiError) {
        dropped++
        continue
      }
      throw err
    }
    const key = `${p.role}\u0000${p.kind}\u0000${value}`
    if (seen.has(key)) continue
    seen.add(key)
    participants.push({ ...p, value })
  }
  return { participants, dropped, skip: participants.some((p) => p.role === 'from') ? null : 'unsupported_sender' }
}

/**
 * Splits a batch into chunks the unit can take ([[CORE25]] D47, [[CORE68]] P11), greedily in input order. `measure` gives a
 * message's distinct address keys and the number of attachments it stores; a chunk holds at most `cap` messages, `cap`
 * distinct addresses (the union) and `cap` stored attachments. A message that alone exceeds the cap in addresses or in
 * stored attachments fits no chunk and is skipped with that reason. No empty chunks.
 */
export function captureChunks<T>(
  batch: readonly T[],
  cap: number,
  measure: (m: T) => { addresses: readonly string[]; stored: number },
): { chunks: T[][]; skipped: Array<{ item: T; reason: 'too_many_participants' | 'too_many_attachments' }> } {
  const chunks: T[][] = []
  const skipped: Array<{ item: T; reason: 'too_many_participants' | 'too_many_attachments' }> = []
  let current: T[] = []
  let addresses = new Set<string>()
  let stored = 0
  for (const item of batch) {
    const m = measure(item)
    if (m.addresses.length > cap) {
      skipped.push({ item, reason: 'too_many_participants' })
      continue
    }
    if (m.stored > cap) {
      skipped.push({ item, reason: 'too_many_attachments' })
      continue
    }
    const union = new Set([...addresses, ...m.addresses])
    if (current.length > 0 && (current.length + 1 > cap || union.size > cap || stored + m.stored > cap)) {
      chunks.push(current)
      current = []
      addresses = new Set()
      stored = 0
      for (const a of m.addresses) addresses.add(a)
    } else {
      addresses = union
    }
    current.push(item)
    stored += m.stored
  }
  if (current.length > 0) chunks.push(current)
  return { chunks, skipped }
}

/** The measure for a `CaptureMessage`: distinct `kind:value` addresses and the count of stored attachments. */
export function captureMeasure(m: CaptureMessage): { addresses: string[]; stored: number } {
  return {
    addresses: [...new Set(m.participants.map((p) => `${p.kind}:${p.value}`))],
    stored: m.attachments.filter((a) => a.fetch_status === 'stored').length,
  }
}
