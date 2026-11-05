import { describe, expect, it } from 'vitest'
import { makeWorkerdStepShim } from './workerd-boundary.js'

class Interval {
  constructor(readonly years: number) {}
}
describe('the workerd step shim', () => {
  it('rejects a class instance by constructor name with its property path, and a function', async () => {
    const { step } = makeWorkerdStepShim()
    await expect(step.do('load', async () => ({ row: { ttl: new Interval(1) } }))).rejects.toThrow(/step\("load"\)\.row\.ttl.*"Interval"/)
    await expect(step.do('f', async () => ({ f: () => 1 }))).rejects.toThrow(/\.f.*function/)
  })
  it('accepts plain data, clones it, and turns a thrown error into a bare Error with the message', async () => {
    const { step } = makeWorkerdStepShim()
    const src = { when: new Date(0), n: [1, { a: 'x' }] }
    const out = await step.do('ok', async () => src)
    expect(out).toEqual(src)
    expect(out).not.toBe(src)
    class Custom extends Error {
      code = 'x'
    }
    const err = await step.do('boom', async () => Promise.reject(new Custom('nope'))).catch((e: unknown) => e as Error)
    expect(err.constructor).toBe(Error)
    expect(err.message).toBe('nope')
    expect((err as unknown as { code?: string }).code).toBeUndefined()
  })
})
