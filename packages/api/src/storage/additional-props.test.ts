import { describe, expect, it } from 'vitest'
import { additionalPropsInput, applyBagPatch, bagBytes, fillBag, keyProblem, valueProblem } from './additional-props.js'

// [[CORE318]] D2, D4, D6, D7: the pure rules of the property bag. The REST suite proves them end to end; JSON cannot carry a non-finite number, so that rule lives here.
describe('additional_props rules', () => {
  it('refuses a non-finite number and names the key', () => {
    for (const n of [Number.POSITIVE_INFINITY, Number.NaN])
      expect(valueProblem('n', n)).toMatch(/additional_props\.n.*finite/)
    expect(valueProblem('n', 1.5)).toBeNull()
    expect(additionalPropsInput.safeParse({ n: Number.POSITIVE_INFINITY }).success).toBe(false)
  })
  it('accepts a bare and a prefixed snake_case key and refuses the rest', () => {
    for (const k of ['a', 'a1', 'linkedin_title', 'scorer:lead_grade']) expect(keyProblem(k), k).toBeNull()
    for (const k of ['', 'A', 'a.b', 'a__b', '_a', 'a_', 'a:b:c', ':a', 'a:', 'a-b', 'a b', 'é'])
      expect(keyProblem(k), k).not.toBeNull()
  })
  it('counts bytes of compact UTF-8, not characters', () => {
    expect(bagBytes({ a: 'é' })).toBe('{"a":"é"}'.length + 1)
  })
  it('a patch sets, removes and keeps; an unknown key removed is a no-op', () => {
    expect(applyBagPatch({ a: 1, b: 2 }, { a: null, c: true, z: null })).toEqual({ b: 2, c: true })
  })
  it('fill keeps the survivor key, adds source keys in order, and stops short of a limit without failing', () => {
    expect(fillBag({ a: 1 }, { a: 2, b: 3 })).toEqual({ a: 1, b: 3 })
    expect(fillBag({}, {})).toEqual({})
    const full = Object.fromEntries(Array.from({ length: 50 }, (_, i) => [`k${i}`, i]))
    expect(fillBag(full, { extra: 1 })).toEqual(full)
    expect(Object.hasOwn(fillBag({}, { constructor: 1 }), 'constructor')).toBe(true)
  })
})
