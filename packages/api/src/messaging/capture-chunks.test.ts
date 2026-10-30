import { describe, expect, it } from 'vitest'
import { captureMessage } from '../test/capture-kit.js'
import { captureChunks, captureMeasure, normalizeParticipants } from './capture-chunks.js'
import type { CaptureMessage, CaptureParticipant } from './capture.js'

const ORG = '0190b2c4-0000-7000-8000-000000000001'
const p = (role: CaptureParticipant['role'], value: string, name?: string): CaptureParticipant => ({ kind: 'email', value, role, ...(name === undefined ? {} : { name }) })

describe('normalizeParticipants', () => {
  it('normalises values and keeps the order', () => {
    const r = normalizeParticipants([p('from', 'Jane@Acme.TEST '), p('to', 'bob@x.test')])
    expect(r.participants.map((x) => x.value)).toEqual(['jane@acme.test', 'bob@x.test'])
    expect(r.participants.map((x) => x.role)).toEqual(['from', 'to'])
    expect(r.dropped).toBe(0)
    expect(r.skip).toBeNull()
  })

  it('drops a non-ASCII participant and counts it', () => {
    const r = normalizeParticipants([p('from', 'jane@acme.test'), p('to', 'jöe@x.test')])
    expect(r.participants.map((x) => x.value)).toEqual(['jane@acme.test'])
    expect(r.dropped).toBe(1)
    expect(r.skip).toBeNull()
  })

  it('skips a message whose sender is refused', () => {
    const r = normalizeParticipants([p('from', 'jöe@x.test'), p('to', 'bob@x.test')])
    expect(r.skip).toBe('unsupported_sender')
    expect(r.dropped).toBe(1)
    expect(r.participants.map((x) => x.value)).toEqual(['bob@x.test'])
  })

  it('skips a message with no sender', () => {
    const r = normalizeParticipants([p('to', 'bob@x.test')])
    expect(r.skip).toBe('unsupported_sender')
    expect(r.dropped).toBe(0)
  })

  it('dedupes per role and keeps the first name', () => {
    const r = normalizeParticipants([p('from', 'f@x.test'), p('to', 'A@x.test', 'A'), p('to', 'a@x.test', 'a'), p('cc', 'a@x.test')])
    expect(r.participants.filter((x) => x.role === 'to')).toEqual([{ kind: 'email', value: 'a@x.test', role: 'to', name: 'A' }])
    expect(r.participants.filter((x) => x.role === 'cc')).toHaveLength(1)
    expect(r.participants).toHaveLength(3)
  })
})

describe('captureChunks', () => {
  const msg = (addresses: string[], stored = 0, failed = 0): CaptureMessage =>
    captureMessage(ORG, {
      participants: addresses.map((a, i) => p(i === 0 ? 'from' : 'to', a)),
      attachments: [
        ...captureMessage(ORG, { attachments: stored }).attachments,
        ...Array.from({ length: failed }, (_, i) => ({ ...captureMessage(ORG, { attachments: 1 }).attachments[0]!, position: stored + i, fetch_status: 'failed' as const, fetch_error: 'x', file: null })),
      ],
    })
  const ids = (chunks: CaptureMessage[][]) => chunks.map((c) => c.map((m) => m.external_id))

  it('keeps one chunk in input order', () => {
    const batch = [msg(['a@x.test']), msg(['b@x.test']), msg(['c@x.test'])]
    const r = captureChunks(batch, 5, captureMeasure)
    expect(r.chunks).toEqual([batch])
    expect(r.skipped).toEqual([])
  })

  it('splits by message count', () => {
    const batch = Array.from({ length: 7 }, () => msg(['a@x.test']))
    const r = captureChunks(batch, 3, captureMeasure)
    expect(r.chunks.map((c) => c.length)).toEqual([3, 3, 1])
    expect(ids(r.chunks).flat()).toEqual(batch.map((m) => m.external_id))
  })

  it('splits by the union of distinct addresses', () => {
    const [m1, m2, m3] = [msg(['a@x.test', 'b@x.test', 'c@x.test']), msg(['c@x.test', 'd@x.test']), msg(['e@x.test'])]
    const r = captureChunks([m1!, m2!, m3!], 4, captureMeasure)
    expect(r.chunks).toEqual([[m1, m2], [m3]])
  })

  it('splits by stored attachments only', () => {
    const [m1, m2] = [msg(['a@x.test'], 2, 1), msg(['a@x.test'], 2)]
    const r = captureChunks([m1!, m2!], 3, captureMeasure)
    expect(r.chunks).toEqual([[m1], [m2]])
  })

  it('skips a message with too many participants', () => {
    const [m1, m2, m3] = [msg(['a@x.test']), msg(['a@x.test', 'b@x.test', 'c@x.test', 'd@x.test']), msg(['e@x.test'])]
    const r = captureChunks([m1!, m2!, m3!], 3, captureMeasure)
    expect(r.skipped).toEqual([{ item: m2, reason: 'too_many_participants' }])
    expect(r.chunks).toEqual([[m1, m3]])
  })

  it('skips a message with too many stored attachments', () => {
    const m = msg(['a@x.test'], 3)
    const r = captureChunks([m], 2, captureMeasure)
    expect(r.skipped).toEqual([{ item: m, reason: 'too_many_attachments' }])
    expect(r.chunks).toEqual([])
  })

  it('returns nothing for an empty batch', () => {
    expect(captureChunks([], 3, captureMeasure)).toEqual({ chunks: [], skipped: [] })
  })

  it('measures distinct kind:value addresses and stored attachments', () => {
    const m = msg(['a@x.test', 'a@x.test', 'b@x.test'], 2, 1)
    expect(captureMeasure(m)).toEqual({ addresses: ['email:a@x.test', 'email:b@x.test'], stored: 2 })
  })
})
