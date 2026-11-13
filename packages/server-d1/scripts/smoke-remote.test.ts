import { describe, expect, it } from 'vitest'
import { RemoteRefusal } from './remote.js'
import { afterHealthOk, operatorKeyOf, parseSmokeArgs, percentile } from './smoke-remote.js'

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

describe('afterHealthOk (CORE61 D7)', () => {
  const ok = { status: 'ok', initialised: true, version: 'abc', migrations: { status: 'current' } }
  it('passes when initialised, the version matches and migrations are current', () => {
    expect(afterHealthOk(200, ok, 'abc')).toBe(true)
  })
  it.each(['behind', 'ahead', 'unknown'])('fails when migrations.status is %s', (status) => {
    expect(afterHealthOk(200, { ...ok, migrations: { status } }, 'abc')).toBe(false)
  })
  it('fails when migrations is absent (an older Worker)', () => {
    expect(afterHealthOk(200, { status: 'ok', initialised: true, version: 'abc' }, 'abc')).toBe(false)
  })
})

describe('operatorKeyOf ([[OPS265]] D15)', () => {
  it('reads VIBASE_SMOKED1_OPERATOR_KEY', () => expect(operatorKeyOf({ VIBASE_SMOKED1_OPERATOR_KEY: 'vk_a' })).toBe('vk_a'))
  it('refuses when only the old VAULT_ name is set, and the refusal names the new variable', () => {
    expect(() => operatorKeyOf({ VAULT_SMOKED1_OPERATOR_KEY: 'vk_old' })).toThrow(RemoteRefusal)
    expect(() => operatorKeyOf({ VAULT_SMOKED1_OPERATOR_KEY: 'vk_old' })).toThrow('VIBASE_SMOKED1_OPERATOR_KEY must be set')
  })
})
