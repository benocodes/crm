import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { parse } from 'jsonc-parser'
import { unstable_readConfig } from 'wrangler'

// [[CHN432]] D7, P4 (432.6): the two `ratelimits` bindings in the REAL wrangler.jsonc (the CORE259 lesson: not only a test kit's Miniflare). The Worker answering through them is form-route.test.ts.
const CONFIG = fileURLToPath(new URL('../wrangler.jsonc', import.meta.url))
const PACKAGE = fileURLToPath(new URL('../package.json', import.meta.url))
const ENVS = [undefined, 'smoked1', 'hq'] as const
const LIMITS = { FORM_IP_LIMITER: 10, FORM_LIMITER: 60 }

interface Limiter {
  name: string
  namespace_id: string
  simple: { limit: number; period: number }
}
/** The config wrangler itself reads; its public type does not yet list `ratelimits`. */
const read = (env?: string) =>
  unstable_readConfig({ config: CONFIG, ...(env ? { env } : {}) }) as unknown as { ratelimits?: Limiter[] }

describe.each(ENVS)('wrangler.jsonc env %s', (env) => {
  it('declares FORM_IP_LIMITER {10 per 60 s} and FORM_LIMITER {60 per 60 s}, and no other limiter', () => {
    const c = read(env)
    const by = Object.fromEntries((c.ratelimits ?? []).map((r) => [r.name, r]))
    expect(Object.keys(by).sort()).toEqual(['FORM_IP_LIMITER', 'FORM_LIMITER'])
    for (const [name, limit] of Object.entries(LIMITS)) expect(by[name]!.simple, name).toEqual({ limit, period: 60 })
    for (const r of Object.values(by)) expect(r.namespace_id).toMatch(/^[0-9]+$/)
  })
})

describe('across the config', () => {
  it('all six namespace_ids are distinct (bindings sharing an id share counters across Workers)', () => {
    const ids = ENVS.flatMap((env) => (read(env).ratelimits ?? []).map((r) => r.namespace_id))
    expect(ids).toHaveLength(6)
    expect(new Set(ids).size).toBe(6)
  })

  it('wrangler is at least 4.36.0, where ratelimits bindings arrived', () => {
    const pinned = (JSON.parse(readFileSync(PACKAGE, 'utf8')) as { devDependencies: { wrangler: string } })
      .devDependencies.wrangler
    const [maj = 0, min = 0] = pinned.split('.').map(Number)
    expect(maj > 4 || (maj === 4 && min >= 36), pinned).toBe(true)
  })

  it('the hq block says its bindings take effect only when the user deploys', () => {
    const text = readFileSync(CONFIG, 'utf8')
    const hq = text.slice(text.indexOf('"hq": {'))
    const comments = hq.split('\n').filter((l) => l.trim().startsWith('//'))
    expect(comments.some((l) => /ratelimits|FORM_IP_LIMITER/.test(l) && /only when the user deploys/.test(l))).toBe(
      true,
    )
    expect(parse(text).env.hq.ratelimits).toHaveLength(2)
  })
})
