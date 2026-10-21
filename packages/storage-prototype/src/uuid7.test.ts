import { expect, test } from 'vitest'
import { uuid7 } from './uuid7.js'
test('RFC9562 deterministic layout and entropy', () => {
  expect(uuid7(0x123456789abc, new Uint8Array(16))).toBe('12345678-9abc-7000-8000-000000000000')
  expect(uuid7(42, new Uint8Array(16))).not.toBe(uuid7(42, new Uint8Array(16).fill(255)))
})
test.each([-1, 0.5, 2**48, NaN])('rejects invalid millisecond %s', n => expect(() => uuid7(n)).toThrow())
