import { describe, expect, it } from 'vitest'
import { DEVICE_USER_CODE_ALPHABET, DEVICE_USER_CODE_LENGTH } from '@vibase/auth'
import { DEVICE_CODE_ALPHABET, DEVICE_CODE_LENGTH, isCompleteDeviceCode } from './device-code.js'

describe('the page copy of the device code pin ([[UI381]] D9)', () => {
  it('equals the pin in @vibase/auth', () => {
    expect(DEVICE_CODE_ALPHABET).toBe(DEVICE_USER_CODE_ALPHABET)
    expect(DEVICE_CODE_LENGTH).toBe(DEVICE_USER_CODE_LENGTH)
  })
  it('judges completeness by length and alphabet', () => {
    expect(isCompleteDeviceCode('ABCD-EFGH')).toBe(true)
    expect(isCompleteDeviceCode('ABCDEFGH')).toBe(true)
    expect(isCompleteDeviceCode('ABCD-EFG')).toBe(false)
    expect(isCompleteDeviceCode('ABCD-EFG0')).toBe(false)
    expect(isCompleteDeviceCode('')).toBe(false)
  })
})
