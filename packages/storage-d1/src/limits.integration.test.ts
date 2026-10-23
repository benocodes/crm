import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { D1Like } from './binding.js'
import { openLocalD1, type LocalD1 } from './test/index.js'

// Step 3.2: D1's limits, measured on the pinned local binding (Miniflare 4.20260730.0 / workerd). Documented
// Cloudflare limits (read 2026-10-22): 100 bound parameters per statement, 100 KB statement length, 1,000
// queries per invocation on Workers Paid (50 on Free), 30 s per query. REMOTE VERIFICATION: NOT RUN.
let local: LocalD1
let d1: D1Like
beforeAll(async () => {
  local = await openLocalD1(['LIMITS'], { migrate: false })
  d1 = local.bindings.LIMITS!
})
afterAll(() => local.dispose())

const works = async (fn: () => Promise<unknown>): Promise<boolean> => fn().then(() => true, () => false)
const ids = (n: number) => Array.from({ length: n }, (_, i) => `0190b2c4-0000-7000-8000-${String(i).padStart(12, '0')}`)

describe('measured D1 limits (local binding)', () => {
  it('bound parameters per statement: 100 pass, 101 fail (the reason a set is bound as ONE parameter, D19)', async () => {
    const at = (n: number) => d1.prepare(`select ${Array.from({ length: n }, () => '?').join(' + ')} as v`).bind(...Array(n).fill(1)).first()
    expect(await works(() => at(100))).toBe(true)
    expect(await works(() => at(101))).toBe(false)
  })

  it('a set of any size up to the cap travels as one json_each parameter', async () => {
    for (const n of [0, 1, 100, 500, 5000]) {
      const r = await d1.prepare('select count(*) as n from json_each(?)').bind(JSON.stringify(ids(n))).first()
      expect(r!.n).toBe(n)
    }
  })

  it('statement length: 100 KB passes, over 100 KB fails', async () => {
    const pad = (bytes: number) => `select 1 as v /*${'x'.repeat(bytes - 'select 1 as v /**/'.length)}*/`
    expect(await works(() => d1.prepare(pad(100_000)).first())).toBe(true)
    expect(await works(() => d1.prepare(pad(100_001)).first())).toBe(false)
  })

  it('LIKE/GLOB patterns longer than 50 bytes are refused (why timestamps are validated with strftime, not GLOB)', async () => {
    expect(await works(() => d1.prepare(`select 'a' glob ?`).bind('a'.repeat(50)).first())).toBe(true)
    expect(await works(() => d1.prepare(`select 'a' glob ?`).bind('a'.repeat(51)).first())).toBe(false)
  })

  it('statements in one batch: the local binding runs 1,000 as one transaction (Cloudflare caps queries per invocation: 1,000 paid, 50 free)', async () => {
    const batch = (n: number) => d1.batch(Array.from({ length: n }, () => d1.prepare('select 1')))
    expect(await works(() => batch(50))).toBe(true)
    expect(await works(() => batch(1000))).toBe(true)
  })

  it('foreign keys are always enforced and cannot be turned off by a statement', async () => {
    expect((await d1.prepare('pragma foreign_keys').first())!.foreign_keys).toBe(1)
    await works(() => d1.prepare('pragma foreign_keys = off').run())
    expect((await d1.prepare('pragma foreign_keys').first())!.foreign_keys).toBe(1)
  })
})
