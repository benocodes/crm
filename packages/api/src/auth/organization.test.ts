import { describe, expect, it } from 'vitest'
import { resolveOrganization } from './organization.js'

const A = '0190a000-0000-7000-8000-00000000000a'
const B = '0190a000-0000-7000-8000-00000000000b'
const C = '0190a000-0000-7000-8000-00000000000c'
const m = (id: string, role: 'owner' | 'member' = 'owner') => ({ organizationId: id, role })

describe('resolveOrganization', () => {
  it('one membership, no header', () => {
    expect(resolveOrganization([m(A)], undefined)).toEqual({ organizationId: A, role: 'owner' })
  })
  it('several, no header', () => {
    expect(resolveOrganization([m(A), m(B)], undefined)).toEqual({ organizationId: null, forbidden: false })
  })
  it('none, no header', () => {
    expect(resolveOrganization([], undefined)).toEqual({ organizationId: null, forbidden: false })
  })
  it('header picks one', () => {
    expect(resolveOrganization([m(A), m(B, 'member')], B)).toEqual({ organizationId: B, role: 'member' })
  })
  it('header is case-insensitive', () => {
    expect(resolveOrganization([m(A)], A.toUpperCase())).toEqual({ organizationId: A, role: 'owner' })
  })
  it('header for a non-member organisation', () => {
    expect(resolveOrganization([m(A)], C)).toEqual({ organizationId: null, forbidden: true })
  })
  it.each(['nope', ''])('header %j is forbidden', (h) => {
    expect(resolveOrganization([m(A)], h)).toEqual({ organizationId: null, forbidden: true })
  })
})
