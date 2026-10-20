import { describe, expect, it } from 'vitest'
import { resolveActiveOrganization } from './organization.js'

const A = '0190a000-0000-7000-8000-00000000000a'
const B = '0190a000-0000-7000-8000-00000000000b'
const active = { organizationId: A, role: 'owner' as const }

describe('resolveActiveOrganization', () => {
  it('active, no header', () => {
    expect(resolveActiveOrganization(active, undefined)).toEqual({ organizationId: A, role: 'owner' })
  })
  it('none, no header', () => {
    expect(resolveActiveOrganization(null, undefined)).toEqual({ organizationId: null, forbidden: false })
  })
  it('matching header, case-insensitive', () => {
    expect(resolveActiveOrganization(active, A.toUpperCase())).toEqual({ organizationId: A, role: 'owner' })
  })
  it('other header', () => {
    expect(resolveActiveOrganization(active, B)).toEqual({ organizationId: null, forbidden: true })
  })
  it('header, no active', () => {
    expect(resolveActiveOrganization(null, A)).toEqual({ organizationId: null, forbidden: true })
  })
  it('empty header', () => {
    expect(resolveActiveOrganization(active, '')).toEqual({ organizationId: null, forbidden: true })
  })
})
