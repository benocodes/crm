import { describe, expect, it } from 'vitest'
import { DEFAULT_TICK_BUDGET, TickBudget, countFetch, parseTickBudget } from './budget.js'

// API7 D24 (API220): the per-tick budget of D1 queries plus outbound fetches. The composition counts; the phases only ask `remaining()`.
describe('parseTickBudget (D24)', () => {
  it('absent or blank is the default of 50, with no problem', () => {
    expect(DEFAULT_TICK_BUDGET).toBe(50)
    for (const raw of [undefined, '', '   ']) expect(parseTickBudget(raw)).toEqual({ limit: 50, problem: null })
  })

  it('an integer from 50 to 1000 is taken', () => {
    for (const raw of ['50', '51', '500', '1000', ' 200 ']) expect(parseTickBudget(raw)).toEqual({ limit: Number(raw.trim()), problem: null })
  })

  it('anything else runs at the default and names the variable, never the value', () => {
    for (const raw of ['49', '1001', '0', '-5', 'abc', '50.5', '1e3', '0x40', '10 0']) {
      const r = parseTickBudget(raw)
      expect(r.limit, raw).toBe(50)
      expect(r.problem, raw).toBe('CRON_TICK_BUDGET')
    }
  })
})

describe('TickBudget', () => {
  it('remaining is the limit less what was spent, never below zero', () => {
    const b = new TickBudget(10)
    expect(b.remaining()).toBe(10)
    b.spend(3)
    b.spend()
    expect(b.used).toBe(4)
    expect(b.remaining()).toBe(6)
    b.spend(20)
    expect(b.remaining()).toBe(0)
  })

  it('a slice may spend at most its share, and never more than the parent has left', () => {
    const b = new TickBudget(30)
    b.spend(10)
    const half = b.slice(Math.floor(b.remaining() / 2))
    expect(half.remaining()).toBe(10)
    b.spend(4) // the slice's spending is the parent's: its share shrinks with it
    expect(half.remaining()).toBe(6)
    b.spend(5)
    expect(half.remaining()).toBe(1)
    const wide = new TickBudget(8).slice(100)
    expect(wide.remaining()).toBe(8)
  })
})

describe('countFetch', () => {
  it('spends one per call, whatever the answer, and passes the arguments through', async () => {
    const b = new TickBudget(50)
    const seen: unknown[] = []
    const f = countFetch(async (...a: unknown[]) => (seen.push(a), new Response('x', { status: 500 })), b)
    await f('https://a.example', { method: 'POST' })
    await f('https://b.example')
    expect(b.used).toBe(2)
    expect(seen).toEqual([['https://a.example', { method: 'POST' }], ['https://b.example']])
    const failing = countFetch(async () => Promise.reject(new Error('down')), b)
    await expect(failing()).rejects.toThrow('down')
    expect(b.used).toBe(3)
  })
})
