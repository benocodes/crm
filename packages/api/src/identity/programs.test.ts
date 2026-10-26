import { describe, expect, it } from 'vitest'
import { SetLimitExceeded, compileOperation, type Dialect } from '@vault/storage'
import { ApiError } from '../errors.js'
import { ScopeSet } from '../scopes.js'
import type { PreparedEnv } from '../storage/definition.js'
import { createOperation } from '../storage/crud.js'
import { identities } from '../resources/identities.js'
import { mergeOperation, mergeReadKeys } from './merge.js'
import { resolveOperation } from './resolve.js'

// Pure compilation of the identity programs (CORE36 Step 1.4): no database.
const ORG = '0190b2c4-0000-7000-8000-00000000a001'
const USER = '0190b2c4-0000-7000-8000-00000000b001'
const uuid = (n: number) => `0190b2c4-0000-7000-8000-${String(n).padStart(12, '0')}`
const SURVIVOR = uuid(900)
const SOURCE = uuid(901)
const AT = '2026-10-22T08:00:00.000Z'

const env = (): PreparedEnv => {
  let n = 100
  return {
    actor: { id: USER, kind: 'user' },
    organizationId: ORG,
    scopes: ScopeSet.parse(['contacts:read', 'contacts:write']),
    now: new Date('2026-10-22T10:00:00.000Z'),
    newId: () => uuid(++n),
  }
}
const apiError = (fn: () => unknown): ApiError => {
  try {
    fn()
  } catch (e) {
    expect(e).toBeInstanceOf(ApiError)
    return e as ApiError
  }
  throw new Error('did not throw')
}

describe('contacts.merge preparation', () => {
  it('refuses a self-merge (ids compared lower-cased) before any read is compiled', () => {
    const e = apiError(() => mergeOperation(env(), SURVIVOR, SURVIVOR.toUpperCase()))
    expect([e.status, e.code, e.message]).toEqual([400, 'merge_into_self', 'a contact cannot be merged into itself'])
  })
  it('treats a non-UUID id as not found', () => {
    const e = apiError(() => mergeOperation(env(), SURVIVOR, 'nope'))
    expect([e.status, e.code, e.message]).toEqual([404, 'not_found', 'contact not found'])
  })
})

describe('identities.resolve preparation', () => {
  it('prefixes a normalisation failure with the entry index', () => {
    const e = apiError(() => resolveOperation(env(), [{ kind: 'email', value: 'ok@example.com' }, { kind: 'phone', value: 'abc' }]))
    expect(e.code).toBe('invalid_identity')
    expect(e.message.startsWith('identities[1]: ')).toBe(true)
  })
  it('writes nothing for an empty batch and answers []', () => {
    const compiled = compileOperation(resolveOperation(env(), []), 'd1')
    expect(compiled.reads).toHaveLength(0)
    expect(compiled.statements).toHaveLength(0)
  })
  it('refuses more entries than the runtime cap', () => {
    const entries = Array.from({ length: 4 }, (_, i) => ({ kind: 'email' as const, value: `a${i}@example.com` }))
    expect(() => compileOperation(resolveOperation(env(), entries), 'd1', {}, { maxSetSize: 3 })).toThrow(SetLimitExceeded)
  })
})

describe.each(['postgres', 'd1'] as const)('statement counts are constant in the set size (D5) on %s', (dialect: Dialect) => {
  const resolveCount = (n: number) =>
    compileOperation(
      resolveOperation(env(), Array.from({ length: n }, (_, i) => ({ kind: 'email' as const, value: `n${i}@example.com`, name: `N${i}` }))),
      dialect,
    ).statements.length

  it('resolve: 1 new address and 10 new addresses compile to the same number of statements', () => {
    expect(resolveCount(1)).toBeGreaterThan(0)
    expect(resolveCount(10)).toBe(resolveCount(1))
  })

  const contactRow = (id: string) => ({
    id,
    organization_id: ORG,
    name: null,
    company_id: null,
    merged_into_id: null,
    created_by: USER,
    created_at: AT,
    updated_at: AT,
    __stamp: AT,
  })
  const identityRow = (n: number) => ({
    id: uuid(n),
    organization_id: ORG,
    kind: 'email',
    value: `m${n}@example.com`,
    contact_id: SOURCE,
    own: false,
    created_by: USER,
    created_at: AT,
    updated_at: AT,
  })
  const mergeCount = (n: number) =>
    compileOperation(mergeOperation(env(), SURVIVOR, SOURCE), dialect, {
      [mergeReadKeys.survivor]: contactRow(SURVIVOR),
      [mergeReadKeys.source]: contactRow(SOURCE),
      [mergeReadKeys.refs(0)]: Array.from({ length: n }, (_, i) => identityRow(i + 1)),
    }).statements.length

  it('merge: a source with 1 identity and with 10 identities compile to the same number of statements', () => {
    expect(mergeCount(1)).toBeGreaterThan(0)
    expect(mergeCount(10)).toBe(mergeCount(1))
  })
})

describe('identities create: the owner rule is pure preparation', () => {
  it.each([
    [{ kind: 'email', value: 'a@b.com', contact_id: uuid(1), own: true }],
    [{ kind: 'email', value: 'a@b.com' }],
  ])('refuses %j before any read', (body) => {
    const e = apiError(() => createOperation(identities, env(), body))
    expect([e.status, e.code, e.message]).toEqual([400, 'validation_error', 'exactly one of contact_id or own: true is required'])
  })
})
