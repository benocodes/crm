import { describe, expect, it } from 'vitest'
import { rankedHints, resolveThreads, type PlannedThreads, type ThreadInput } from './thread-resolution.js'

const input = (external_id: string, over: Partial<ThreadInput> = {}): ThreadInput => ({
  external_id,
  in_reply_to: null,
  thread_hints: [],
  provider_thread_id: `pt-${external_id}`,
  subject: `S ${external_id}`,
  ...over,
})
const planned = (over: Partial<{ existing: Record<string, string>; aliases: Record<string, string>; ancestors: Record<string, { rank: number; thread_id: string }> }> = {}): PlannedThreads => ({
  existing: new Map(Object.entries(over.existing ?? {})),
  aliases: new Map(Object.entries(over.aliases ?? {})),
  ancestors: new Map(Object.entries(over.ancestors ?? {})),
})
const counter = () => {
  let n = 0
  return () => `T${++n}`
}

describe('rankedHints', () => {
  it('lists in_reply_to then the hints, without duplicates, nulls or the message itself', () => {
    expect(rankedHints({ external_id: 'self@x', in_reply_to: 'p@x', thread_hints: ['p@x', 'q@x', 'self@x'] })).toEqual(['p@x', 'q@x'])
    expect(rankedHints({ external_id: 'self@x', in_reply_to: null, thread_hints: ['q@x'] })).toEqual(['q@x'])
  })
})

describe('resolveThreads', () => {
  it('treats a message already in the database as existing', () => {
    const r = resolveThreads([input('a')], planned({ existing: { a: 'T9' } }), counter())
    expect(r.decisions).toEqual([{ external_id: 'a', outcome: 'existing', thread_id: 'T9', chosen_rank: null }])
    expect(r.new_threads).toEqual([])
    expect(r.absent).toEqual([])
  })

  it('treats the second of two messages with one key as existing, in the first thread', () => {
    const r = resolveThreads([input('a'), input('a')], planned(), counter())
    expect(r.decisions.map((d) => [d.outcome, d.thread_id])).toEqual([['new', 'T1'], ['existing', 'T1']])
  })

  it('uses the planned alias of the pair', () => {
    const r = resolveThreads([input('a')], planned({ aliases: { 'pt-a': 'T7' } }), counter())
    expect(r.decisions[0]).toMatchObject({ outcome: 'alias', thread_id: 'T7' })
    expect(r.aliases_to_add).toEqual([])
    expect(r.new_threads).toEqual([])
  })

  it('uses an alias set earlier in the chunk', () => {
    const r = resolveThreads([input('a', { provider_thread_id: 'g1' }), input('b', { provider_thread_id: 'g1' })], planned(), counter())
    expect(r.decisions.map((d) => [d.outcome, d.thread_id])).toEqual([['new', 'T1'], ['alias', 'T1']])
    expect(r.aliases_to_add).toEqual([{ provider_thread_id: 'g1', thread_id: 'T1' }])
  })

  it('joins the planned database ancestor and adds the pair alias', () => {
    const r = resolveThreads([input('a', { in_reply_to: 'h0', thread_hints: ['h1'] })], planned({ ancestors: { a: { rank: 1, thread_id: 'T5' } } }), counter())
    expect(r.decisions[0]).toEqual({ external_id: 'a', outcome: 'ancestor', thread_id: 'T5', chosen_rank: 1 })
    expect(r.aliases_to_add).toEqual([{ provider_thread_id: 'pt-a', thread_id: 'T5' }])
  })

  it('prefers a nearer ancestor earlier in the chunk', () => {
    const h = ['h0', 'h1', 'h2']
    const r = resolveThreads([input('h0'), input('c', { in_reply_to: 'h0', thread_hints: ['h1', 'h2'] })], planned({ ancestors: { c: { rank: 2, thread_id: 'T8' } } }), counter())
    expect(h).toHaveLength(3)
    expect(r.decisions[1]).toEqual({ external_id: 'c', outcome: 'ancestor', thread_id: 'T1', chosen_rank: 0 })
    expect(r.absent).not.toContain('h1')
    expect(r.absent).not.toContain('h2')
  })

  it('prefers a nearer database ancestor over a farther one in the chunk', () => {
    const r = resolveThreads([input('h2'), input('c', { in_reply_to: 'h0', thread_hints: ['h1', 'h2'] })], planned({ ancestors: { c: { rank: 1, thread_id: 'T8' } } }), counter())
    expect(r.decisions[1]).toEqual({ external_id: 'c', outcome: 'ancestor', thread_id: 'T8', chosen_rank: 1 })
    expect(r.absent).toContain('h0')
    expect(r.absent).not.toContain('h1')
  })

  it('starts a new thread with the message subject and must find every hint absent', () => {
    const r = resolveThreads([input('a', { in_reply_to: 'k0', thread_hints: ['k1'], subject: 'Hello' })], planned(), counter())
    expect(r.decisions[0]).toEqual({ external_id: 'a', outcome: 'new', thread_id: 'T1', chosen_rank: null })
    expect(r.new_threads).toEqual([{ thread_id: 'T1', subject: 'Hello' }])
    expect(new Set(r.absent)).toEqual(new Set(['a', 'k0', 'k1']))
  })

  it('collects the must-be-absent set over the chunk', () => {
    const r = resolveThreads(
      [input('n1', { in_reply_to: 'h0', thread_hints: ['h1', 'h2'] }), input('n2', { in_reply_to: 'k0' })],
      planned({ ancestors: { n1: { rank: 1, thread_id: 'T5' } } }),
      counter(),
    )
    expect(new Set(r.absent)).toEqual(new Set(['n1', 'n2', 'h0', 'k0']))
  })
})
