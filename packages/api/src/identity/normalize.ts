import { ApiError } from '../errors.js'

export type IdentityKind = 'email' | 'phone'
export const IDENTITY_KINDS: readonly IdentityKind[] = ['email', 'phone']

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const PHONE = /^\+[1-9][0-9]{6,14}$/
const DOMAIN = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/

/** Normalises an address for storage and lookup. Throws ApiError(400, 'invalid_identity'). */
export function normalizeIdentityValue(kind: IdentityKind, value: string): string {
  if (kind === 'email') {
    const v = value.trim().toLowerCase()
    if (v.length > 254 || !EMAIL.test(v)) throw new ApiError(400, 'invalid_identity', 'invalid email address')
    return v
  }
  const v = value.replace(/[\s\-.()]/g, '')
  if (!PHONE.test(v)) throw new ApiError(400, 'invalid_identity', 'invalid phone number (E.164 required)')
  return v
}

/** Normalises a company domain. Throws ApiError(400, 'validation_error'). */
export function normalizeDomain(value: string): string {
  const v = value.trim().toLowerCase()
  if (!DOMAIN.test(v)) throw new ApiError(400, 'validation_error', 'domain: invalid domain')
  return v
}
