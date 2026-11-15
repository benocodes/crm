// OPS340 D6: the request transport owns its connection: a bounded keep-alive pool, never the global `fetch`, destroyed on dispose.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { openLocalD1, type LocalD1 } from './index.js'
import { MAX_SOCKETS, transportStats } from './request-transport.js'

let local: LocalD1 | undefined
afterEach(async () => {
  vi.unstubAllGlobals()
  await local?.dispose()
  local = undefined
})

const open = async () => {
  local = await openLocalD1(['D'], { transport: 'request' })
  return local
}

describe('the request transport connection (OPS340 D6)', () => {
  it('(a) never reaches the global fetch, even when a test replaces it', async () => {
    const calls: unknown[] = []
    vi.stubGlobal('fetch', (...args: unknown[]) => {
      calls.push(args)
      throw new Error('global fetch must not be used by the harness')
    })
    const l = await open()
    const d1 = l.bindings.D!
    await d1.prepare('CREATE TABLE x (n INTEGER)').run()
    await d1.batch([1, 2, 3].map((n) => d1.prepare('INSERT INTO x (n) VALUES (?)').bind(n)))
    const rows = await d1.prepare('SELECT count(*) AS c FROM x').first()
    expect(rows).toEqual({ c: 3 })
    expect(calls).toEqual([])
  })

  it('(b) a long sequential run and a burst of 10x the pool stay within the socket bound', async () => {
    const l = await open()
    const d1 = l.bindings.D!
    const stats = transportStats(l)!
    expect(stats.maxSockets).toBe(MAX_SOCKETS)
    for (let i = 0; i < 300; i++) expect(await d1.prepare('SELECT ? AS i').bind(i).first()).toEqual({ i })
    const burst = MAX_SOCKETS * 10
    const rows = await Promise.all(
      Array.from({ length: burst }, (_, i) => d1.prepare('SELECT ? AS i').bind(i).first()),
    )
    expect(rows.map((r) => (r as { i: number }).i)).toEqual(Array.from({ length: burst }, (_, i) => i))
    const after = transportStats(l)!
    expect(after.requests).toBeGreaterThanOrEqual(300 + burst)
    expect(after.peakOpen).toBeLessThanOrEqual(MAX_SOCKETS)
    expect(after.opened).toBeLessThanOrEqual(MAX_SOCKETS * 2)
    // Real overlap: the statements of a Promise.all are in flight together (D10).
    expect(after.peakInFlight).toBeGreaterThan(1)
  })

  it('(c) dispose destroys the agent and leaves no socket open', async () => {
    const l = await open()
    const d1 = l.bindings.D!
    await Promise.all(Array.from({ length: 20 }, () => d1.prepare('SELECT 1').all()))
    const stats = transportStats(l)!
    expect(stats.open).toBeGreaterThan(0)
    expect(stats.closed).toBe(false)
    await l.dispose()
    local = undefined
    expect(stats.closed).toBe(true)
    expect(stats.open).toBe(0)
  })
})
