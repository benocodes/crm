/**
 * [[UI247]] D2/D9: the device user code's shape as the page knows it. The pin lives in `@vibase/auth`
 * (`DEVICE_USER_CODE_ALPHABET`, `DEVICE_USER_CODE_LENGTH`), which the page bundle must not import (Better Auth);
 * `device-code.test.ts` holds this copy equal to it.
 */
export const DEVICE_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
export const DEVICE_CODE_LENGTH = 8

/** True for an unseparated or `XXXX-XXXX` code of the pinned length and alphabet (case already normalised by `normaliseCode`). */
export function isCompleteDeviceCode(code: string): boolean {
  const bare = code.replace(/-/g, '')
  return bare.length === DEVICE_CODE_LENGTH && [...bare].every((c) => DEVICE_CODE_ALPHABET.includes(c))
}
