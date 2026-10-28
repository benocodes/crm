import { describe, expect, it } from 'vitest'
import { parseSmokeArgs, percentile } from './smoke-remote.js'

describe('percentile (nearest rank)', () => {
  const xs = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100]
  it('p50, p95, p100', () => {
    expect(percentile(xs, 50)).toBe(50)
    expect(percentile(xs, 95)).toBe(100)
    expect(percentile(xs, 100)).toBe(100)
  })
  it('a single sample', () => expect(percentile([7], 95)).toBe(7))
})

describe('parseSmokeArgs', () => {
  it('reads the flags', () => {
    expect(parseSmokeArgs(['--', '--base', 'https://h', '--phase', 'after', '--expect-version', 'abc'])).toEqual({ base: 'https://h', phase: 'after', expectVersion: 'abc' })
  })
  it('rejects a bad phase', () => {
    expect(() => parseSmokeArgs(['--base', 'https://h', '--phase', 'during', '--expect-version', 'abc'])).toThrow()
  })
})
