import { describe, expect, it } from 'vitest'
import { Found, queryContext, toCompiled, type Dialect, type PreparedOperation, type Row, type Step, type Unit } from '@vault/storage'
import { ApiError } from '../errors.js'
import { apiKeyAuthOperation } from './api-keys.js'
import { firstSightOperation, firstSightRecheckOperation, lookupUserOperation } from './first-sight.js'
import { reconcileOperation, refreshUserOperation, repairOperation } from '../directory/sync.js'
import { bootstrapOperation } from '../bootstrap.js'
import { SYSTEM_PRINCIPAL_READ } from '../directory/system-principal.js'
import type { InternalEnv } from '../storage/internal.js'

// Pure checks of the auth, directory and bootstrap programs (CORE41 Step 1.3): the statements each builds, in order,
// on both dialects. `Found` is built by hand from rows shaped like the plan reads return them. No database.

const dialects: readonly Dialect[] = ['postgres', 'd1']
const NOW = new Date('2026-10-22T10:00:00.000Z')
let n = 0
const id = (k: number) => `0190b2c4-0000-7000-8000-${String(k).padStart(12, '0')}`
const env: InternalEnv = { now: NOW, newId: () => id(900 + ++n) }
const ORG = id(1)
const USER = id(2)
const AGENT = id(3)
const KEY = id(4)
const SYSTEM = id(5)
const HASH = 'a'.repeat(64)
const PLAINTEXT = 'vk_the-plaintext-key-that-must-never-reach-a-statement'

const sec = (s: number) => new Date(NOW.getTime() - s * 1000).toISOString()
/** Postgres hands a text[] as an array and a timestamp as a Date; D1 hands JSON text and ISO text. Both decode the same. */
const scopes = (dialect: Dialect, list: string[]) => (dialect === 'postgres' ? list : JSON.stringify(list))

interface Built {
  unit: Unit<unknown>
  steps: Array<{ label?: string; sql: string; parameters: readonly unknown[]; expect?: Step['expect'] }>
  dialect: Dialect
}
function build(op: PreparedOperation<unknown>, dialect: Dialect, found: Record<string, Row | readonly Row[] | null>): Built {
  const qc = queryContext(dialect)
  const unit = op.build(Found.from(found), qc)
  const steps = unit.steps.map((s) => {
    const c = toCompiled(s.query)
    return { ...(s.label ? { label: s.label } : {}), sql: c.sql, parameters: c.parameters, ...(s.expect ? { expect: s.expect } : {}) }
  })
  return { unit, steps, dialect }
}
const decode = (b: Built, found: Record<string, Row | readonly Row[] | null>, rows: readonly Row[] = []) => b.unit.decode(rows, Found.from(found))
const refusal = (fn: () => unknown): ApiError => {
  try {
    fn()
  } catch (e) {
    if (e instanceof ApiError) return e
    throw e
  }
  throw new Error('expected an ApiError')
}
const sqls = (b: Built) => b.steps.map((s) => s.sql)
const isAssertion = (s: Built['steps'][number], dialect: Dialect) =>
  dialect === 'd1' ? /^insert into "unit_assertion"/i.test(s.sql) : s.expect === 'holds'

describe('API-key authentication (C3, P6)', () => {
  const keyRow = (dialect: Dialect, over: Record<string, unknown> = {}) => ({
    key_id: KEY,
    agent_id: AGENT,
    organization_id: ORG,
    scopes: scopes(dialect, ['tasks:read']),
    last_used_at: null,
    expires_at: null,
    revoked_at: null,
    disabled_at: null,
    ...over,
  })

  it.each(dialects)('never used: one statement that sets last_used_at only, no event, and the principal on %s', (dialect) => {
    const found = { 'auth:key': keyRow(dialect) }
    const b = build(apiKeyAuthOperation(HASH, NOW), dialect, found)
    expect(b.steps).toHaveLength(1)
    expect(b.steps[0]!.sql).toMatch(/^update "api_keys" set "last_used_at" = /i)
    expect(b.steps[0]!.sql).not.toMatch(/updated_at/i)
    expect(b.unit.events).toEqual([])
    expect(decode(b, found)).toMatchObject({ actor: { id: AGENT, kind: 'agent' }, organizationId: ORG })
    expect((decode(b, found) as { scopes: { toStrings(): string[] } }).scopes.toStrings()).toEqual(['tasks:read'])
  })

  it.each(dialects)('used 59 seconds ago: no statement, still the principal on %s', (dialect) => {
    const found = { 'auth:key': keyRow(dialect, { last_used_at: sec(59) }) }
    const b = build(apiKeyAuthOperation(HASH, NOW), dialect, found)
    expect(b.steps).toHaveLength(0)
    expect(decode(b, found)).toMatchObject({ actor: { id: AGENT } })
  })

  it.each(dialects)('used 61 seconds ago: one statement on %s', (dialect) => {
    const b = build(apiKeyAuthOperation(HASH, NOW), dialect, { 'auth:key': keyRow(dialect, { last_used_at: sec(61) }) })
    expect(b.steps).toHaveLength(1)
  })

  it.each(dialects)('the stamp guard compares to the cutoff and carries no expectation on %s', (dialect) => {
    const b = build(apiKeyAuthOperation(HASH, NOW), dialect, { 'auth:key': keyRow(dialect) })
    expect(b.steps[0]!.expect).toBeUndefined()
    expect(b.steps[0]!.parameters).toContain(sec(60))
    expect(b.steps[0]!.parameters).toContain(NOW.toISOString())
  })

  it.each([
    ['revoked', { revoked_at: sec(10) }],
    ['expiring exactly now', { expires_at: NOW.toISOString() }],
    ['expired', { expires_at: sec(1) }],
    ['of a disabled agent', { disabled_at: sec(10) }],
  ])('a key %s writes nothing and is null', (_n, over) => {
    for (const dialect of dialects) {
      const found = { 'auth:key': keyRow(dialect, over) }
      const b = build(apiKeyAuthOperation(HASH, NOW), dialect, found)
      expect(b.steps).toHaveLength(0)
      expect(decode(b, found)).toBeNull()
    }
  })

  it('an unknown key is null with no statement', () => {
    const b = build(apiKeyAuthOperation(HASH, NOW), 'd1', { 'auth:key': null })
    expect(b.steps).toHaveLength(0)
    expect(decode(b, { 'auth:key': null })).toBeNull()
  })

  it('a future expiry is valid', () => {
    const found = { 'auth:key': keyRow('d1', { expires_at: new Date(NOW.getTime() + 1000).toISOString() }) }
    expect(decode(build(apiKeyAuthOperation(HASH, NOW), 'd1', found), found)).not.toBeNull()
  })
})

describe('first sight (C4, P7)', () => {
  const args = { provider: 'clerk', subject: 'user_new', email: 'ada@x.test', name: 'Ada', emailVerified: true, principalId: id(50), now: NOW }
  const login = { userId: USER, linkedOrganizationId: null, latestMembership: null }

  it.each(dialects)('a known subject is that login with no statement on %s', (dialect) => {
    const found = { 'auth:subject': { id: USER }, 'auth:email': { id: USER } }
    const b = build(firstSightOperation(args), dialect, found)
    expect(b.steps).toHaveLength(0)
    expect(decode(b, found)).toEqual(login)
  })

  it.each(dialects)('an email held by another user refuses 409 account_conflict on %s', (dialect) => {
    const err = refusal(() => build(firstSightOperation(args), dialect, { 'auth:subject': null, 'auth:email': { id: USER } }))
    expect(err).toMatchObject({ status: 409, code: 'account_conflict' })
  })

  it.each(dialects)('neither found: principal, user ON CONFLICT DO NOTHING, assertion, result; no event, on %s', (dialect) => {
    const found = { 'auth:subject': null, 'auth:email': null }
    const b = build(firstSightOperation(args), dialect, found)
    expect(b.steps.map((s) => s.label)).toEqual(['first-mutation', undefined, undefined, 'result'])
    expect(b.steps[0]!.sql).toMatch(/^insert into "principals"/i)
    expect(b.steps[1]!.sql).toMatch(/^insert into "users"/i)
    expect(b.steps[1]!.sql).toMatch(/on conflict do nothing/i)
    expect(isAssertion(b.steps[2]!, dialect)).toBe(true)
    expect(b.steps[3]!.sql).toMatch(/^select/i)
    expect(b.unit.events).toEqual([])
    // The assertion is followed only by the ungated result select (a gated statement after it would see changes() = 0 on D1).
    expect(b.steps.slice(3).some((s) => /changes\(\)/i.test(s.sql))).toBe(false)
    // the stored values: normalised email, stamps = now, the minted principal id
    const params = b.steps.flatMap((s) => s.parameters)
    expect(params).toContain('ada@x.test')
    expect(params).toContain(NOW.toISOString())
    expect(params).toContain(args.principalId)
    expect(decode(b, found, [{ id: args.principalId }])).toEqual({ ...login, userId: args.principalId })
  })

  it.each(dialects)('a result with no row (a lost race) is drift on %s', (dialect) => {
    const b = build(firstSightOperation(args), dialect, { 'auth:subject': null, 'auth:email': null })
    expect(() => decode(b, {}, [])).toThrowError(/changed while/)
  })

  it.each(dialects)('the recheck is read-only: login, account_conflict or conflict on %s', (dialect) => {
    const op = firstSightRecheckOperation({ provider: 'clerk', subject: 'user_new', email: 'ada@x.test' })
    expect(op.mutates).toBe(false)
    const hit = { 'auth:subject': { id: USER }, 'auth:email': { id: USER } }
    expect(decode(build(op, dialect, hit), hit)).toEqual(login)
    expect(refusal(() => build(op, dialect, { 'auth:subject': null, 'auth:email': { id: id(9) } }))).toMatchObject({ status: 409, code: 'account_conflict' })
    expect(refusal(() => build(op, dialect, { 'auth:subject': null, 'auth:email': null }))).toMatchObject({ status: 409, code: 'conflict' })
  })

  it('lookup is read-only and builds no statement', () => {
    const op = lookupUserOperation({ provider: 'clerk', subject: 'user_1', organizationExternalId: 'org_1' })
    expect(op.mutates).toBe(false)
    expect(build(op, 'd1', { 'auth:user': { id: USER } }).steps).toEqual([])
  })
})

describe('the directory programs (C6, P8-P11)', () => {
  const orgRow = { id: ORG, name: 'Acme', created_at: sec(1000), updated_at: sec(1000), __stamp: sec(1000) }
  const mem = (k: number, user: string, role: 'owner' | 'member', subject: string) => ({
    id: id(100 + k),
    organization_id: ORG,
    user_id: user,
    role,
    created_by: SYSTEM,
    created_at: sec(1000),
    updated_at: sec(1000),
    subject,
  })
  const userOf = (k: number) => id(200 + k)
  const reconcileArgs = (members: Array<{ subject: string; role: 'owner' | 'member' }>, over: Record<string, unknown> = {}) => ({
    provider: 'clerk',
    externalId: 'org_acme',
    organization: { name: 'Acme' },
    members,
    newOrganizationId: id(60),
    env,
    ...over,
  })

  /** A snapshot that deletes `del` members, re-roles `up` of them to owner and creates `add` new ones. */
  function snapshot(del: number, up: number, add: number) {
    const live = [
      ...Array.from({ length: del }, (_, i) => mem(i, userOf(i), 'member', `gone_${i}`)),
      ...Array.from({ length: up }, (_, i) => mem(50 + i, userOf(50 + i), 'member', `up_${i}`)),
    ]
    const members = [
      ...Array.from({ length: up }, (_, i) => ({ subject: `up_${i}`, role: 'owner' as const })),
      ...Array.from({ length: add }, (_, i) => ({ subject: `new_${i}`, role: 'member' as const })),
    ]
    const users = [...live.filter((m) => m.subject.startsWith('up_')).map((m) => ({ id: m.user_id, auth_subject: m.subject })), ...Array.from({ length: add }, (_, i) => ({ id: userOf(80 + i), auth_subject: `new_${i}` }))]
    return { found: { 'dir:org': orgRow, 'dir:live': live, 'dir:users': users, [SYSTEM_PRINCIPAL_READ]: { id: SYSTEM } }, members }
  }

  it.each(dialects)('reconcile costs the same number of statements for 1 and for 10 changed members on %s', (dialect) => {
    const small = snapshot(1, 1, 1)
    const big = snapshot(3, 3, 4)
    const a = build(reconcileOperation(reconcileArgs(small.members)), dialect, small.found)
    const b = build(reconcileOperation(reconcileArgs(big.members)), dialect, big.found)
    expect(a.steps.length).toBeGreaterThan(5)
    expect(b.steps.length).toBe(a.steps.length)
  })

  it.each(dialects)('reconcile with nothing to change builds no statement on %s', (dialect) => {
    const live = [mem(1, userOf(1), 'owner', 'u1')]
    const found = { 'dir:org': orgRow, 'dir:live': live, 'dir:users': [{ id: userOf(1), auth_subject: 'u1' }], [SYSTEM_PRINCIPAL_READ]: null }
    const b = build(reconcileOperation(reconcileArgs([{ subject: 'u1', role: 'owner' }])), dialect, found)
    expect(b.steps).toEqual([])
    expect(b.unit.events).toEqual([])
    expect(decode(b, found)).toEqual({ organizationId: ORG, created: 0, updated: 0, deleted: 0 })
  })

  it.each(dialects)('the system principal is created lazily: absent and a change inserts it first, then asserts it on %s', (dialect) => {
    const s = snapshot(0, 0, 1)
    const found = { ...s.found, [SYSTEM_PRINCIPAL_READ]: null }
    const b = build(reconcileOperation(reconcileArgs(s.members)), dialect, found)
    expect(b.steps[0]!.sql).toMatch(/^insert into "principals"/i)
    expect(b.steps[0]!.sql).toMatch(/on conflict do nothing/i)
    expect(b.steps[0]!.label).toBe('first-mutation')
    expect(isAssertion(b.steps[1]!, dialect)).toBe(true)
    // present: no insert
    const present = build(reconcileOperation(reconcileArgs(s.members)), dialect, s.found)
    expect(sqls(present).some((q) => /insert into "principals"/i.test(q))).toBe(false)
  })

  it.each(dialects)('a unit that writes no event never inserts the system principal on %s', (dialect) => {
    const found = { 'dir:org': orgRow, 'dir:live': [], 'dir:users': [], [SYSTEM_PRINCIPAL_READ]: null }
    const b = build(reconcileOperation(reconcileArgs([])), dialect, found)
    expect(sqls(b).some((q) => /principals/i.test(q))).toBe(false)
  })

  it.each(dialects)('no statement gated on the previous one directly follows an assertion, in any directory program on %s', (dialect) => {
    const s = snapshot(2, 2, 2)
    const builds: Built[] = [
      build(reconcileOperation(reconcileArgs(s.members)), dialect, { ...s.found, [SYSTEM_PRINCIPAL_READ]: null }),
      build(reconcileOperation(reconcileArgs(s.members, { organization: { name: 'Renamed' } })), dialect, s.found),
      build(reconcileOperation(reconcileArgs(s.members)), dialect, { ...s.found, 'dir:org': null, [SYSTEM_PRINCIPAL_READ]: null }),
      build(
        repairOperation({ provider: 'clerk', externalId: 'org_acme', userId: userOf(7), role: 'member', knownOrganizationId: null, fetchedName: 'Acme', newOrganizationId: id(61), env }),
        dialect,
        { 'dir:org': null, 'dir:membership': null, [SYSTEM_PRINCIPAL_READ]: null },
      ),
    ]
    for (const b of builds) {
      b.steps.forEach((step, i) => {
        if (i > 0 && isAssertion(b.steps[i - 1]!, dialect)) {
          // the step after an assertion must not read changes() (D1) - an event after an assertion is the set form, or follows its own insert
          expect(step.sql, `step ${i} after an assertion`).not.toMatch(/changes\(\)/i)
        }
      })
    }
  })

  it.each(dialects)('a new organisation: the event follows its insert directly, then the link assertion on %s', (dialect) => {
    const b = build(
      repairOperation({ provider: 'clerk', externalId: 'org_acme', userId: userOf(7), role: 'member', knownOrganizationId: null, fetchedName: 'Acme', newOrganizationId: id(61), env }),
      dialect,
      { 'dir:org': null, 'dir:membership': null, [SYSTEM_PRINCIPAL_READ]: null },
    )
    const q = sqls(b)
    const at = q.findIndex((s) => /^insert into "organizations"/i.test(s))
    expect(at).toBeGreaterThan(0)
    expect(q[at]).toMatch(/on conflict do nothing/i)
    expect(q[at + 1]).toMatch(/^insert into "events"/i)
    expect(isAssertion(b.steps[at + 2]!, dialect)).toBe(true)
    expect(b.unit.events.map((e) => e.type)).toEqual(['organization.created', 'membership.created'])
  })

  it.each(dialects)('repair of a known organisation with a matching live membership builds no statement on %s', (dialect) => {
    const found = { 'dir:org': orgRow, 'dir:membership': mem(1, userOf(7), 'member', 'x'), [SYSTEM_PRINCIPAL_READ]: null }
    const b = build(repairOperation({ provider: 'clerk', externalId: 'org_acme', userId: userOf(7), role: 'member', knownOrganizationId: ORG, fetchedName: null, newOrganizationId: id(61), env }), dialect, found)
    expect(b.steps).toEqual([])
    expect(decode(b, found)).toBe(ORG)
  })

  it.each(dialects)('repair re-roles with one guarded update and a membership.updated event whose before is the planned record on %s', (dialect) => {
    const found = { 'dir:org': orgRow, 'dir:membership': mem(1, userOf(7), 'member', 'x'), [SYSTEM_PRINCIPAL_READ]: { id: SYSTEM } }
    const b = build(repairOperation({ provider: 'clerk', externalId: 'org_acme', userId: userOf(7), role: 'owner', knownOrganizationId: ORG, fetchedName: null, newOrganizationId: id(61), env }), dialect, found)
    expect(b.steps[0]!.sql).toMatch(/^update "memberships"/i)
    expect(b.steps[0]!.expect).toBe('affected')
    expect(b.unit.events.map((e) => e.type)).toEqual(['membership.updated'])
    const before = JSON.parse(String(b.steps[1]!.parameters.find((p) => typeof p === 'string' && p.startsWith('{"id"'))))
    expect(before).toMatchObject({ id: id(101), role: 'member', updated_at: sec(1000) })
  })

  it.each(dialects)('refresh builds one guarded update that stamps updated_at, with no event, on %s', (dialect) => {
    const found = { 'refresh:user': { id: USER, email: 'old@x.test', name: 'Old', email_verified: false, __stamp: sec(1000) }, 'refresh:email': null }
    const b = build(refreshUserOperation({ provider: 'clerk', subject: 'user_1', email: 'new@x.test', name: 'New', emailVerified: true, env }), dialect, found)
    expect(b.steps.filter((s) => /^update "users"/i.test(s.sql))).toHaveLength(1)
    expect(b.steps.find((s) => /^update "users"/i.test(s.sql))!.sql).toMatch(/"updated_at" = /i)
    expect(b.steps.find((s) => /^update "users"/i.test(s.sql))!.expect).toBe('affected')
    expect(b.unit.events).toEqual([])
    expect(decode(b, found, [{ applied: 1 }])).toBe('updated')
  })

  it.each(dialects)('refresh outcomes unknown, conflict and unchanged write nothing on %s', (dialect) => {
    const op = refreshUserOperation({ provider: 'clerk', subject: 'user_1', email: 'same@x.test', name: 'Same', emailVerified: true, env })
    const user = { id: USER, email: 'same@x.test', name: 'Same', email_verified: dialect === 'postgres' ? true : 1, __stamp: sec(1000) }
    const unknown = { 'refresh:user': null, 'refresh:email': null }
    expect([build(op, dialect, unknown).steps.length, decode(build(op, dialect, unknown), unknown)]).toEqual([0, 'unknown'])
    const conflict = { 'refresh:user': user, 'refresh:email': { id: id(9) } }
    expect([build(op, dialect, conflict).steps.length, decode(build(op, dialect, conflict), conflict)]).toEqual([0, 'conflict'])
    const unchanged = { 'refresh:user': user, 'refresh:email': { id: USER } }
    expect([build(op, dialect, unchanged).steps.length, decode(build(op, dialect, unchanged), unchanged)]).toEqual([0, 'unchanged'])
  })
})

const BOOTSTRAP_ARGS = {
    organizationId: ORG,
    organizationName: 'Acme',
    link: null,
    email: 'owner@x.test',
    userName: 'Owner',
    login: null,
    agentName: 'bot',
    scopes: ['tasks:read'],
    ids: { user: USER, membership: id(70), agent: AGENT, apiKey: KEY },
    secret: { key: PLAINTEXT, hash: HASH, prefix: PLAINTEXT.slice(0, 11) },
    now: NOW,
  }

describe('bootstrap (C7, P14)', () => {
  const args = BOOTSTRAP_ARGS

  it.each(dialects)('never carries the plaintext key in a statement and writes no event on %s', (dialect) => {
    const found = { 'bs:user': null, 'bs:holder': null, 'bs:org': null }
    const b = build(bootstrapOperation(args), dialect, found)
    const params = b.steps.flatMap((s) => s.parameters)
    expect(params).toContain(HASH)
    expect(params).not.toContain(PLAINTEXT)
    expect(sqls(b).join('\n')).not.toContain(PLAINTEXT)
    expect(sqls(b).some((q) => /"events"/i.test(q))).toBe(false)
    expect(b.unit.events).toEqual([])
    expect(decode(b, found)).toMatchObject({ organizationId: ORG, userId: USER, agentId: AGENT, apiKeyId: KEY, key: PLAINTEXT })
  })

  it.each(dialects)('an organisation row that already exists is refused on %s', (dialect) => {
    expect(() => build(bootstrapOperation(args), dialect, { 'bs:user': null, 'bs:holder': null, 'bs:org': { id: ORG } })).toThrowError(`organization ${ORG} is already initialised`)
  })
})

describe('no database clock anywhere (D2)', () => {
  it.each(dialects)('no program reads now(), current_timestamp or the SQLite clock on %s', (dialect) => {
    const args = BOOTSTRAP_ARGS
    const s = (members: Array<{ subject: string; role: 'owner' | 'member' }>) => members
    const builds: Built[] = [
      build(apiKeyAuthOperation(HASH, NOW), dialect, { 'auth:key': { key_id: KEY, agent_id: AGENT, organization_id: ORG, scopes: scopes(dialect, []), last_used_at: null, expires_at: null, revoked_at: null, disabled_at: null } }),
      build(firstSightOperation({ provider: 'clerk', subject: 's', email: 'a@x.test', name: null, emailVerified: false, principalId: id(50), now: NOW }), dialect, { 'auth:subject': null, 'auth:email': null }),
      build(
        reconcileOperation({ provider: 'clerk', externalId: 'o', organization: { name: 'N' }, members: s([{ subject: 'a', role: 'owner' }]), newOrganizationId: id(60), env }),
        dialect,
        { 'dir:org': null, 'dir:live': [], 'dir:users': [{ id: USER, auth_subject: 'a' }], [SYSTEM_PRINCIPAL_READ]: null },
      ),
      build(
        repairOperation({ provider: 'clerk', externalId: 'o', userId: USER, role: 'member', knownOrganizationId: null, fetchedName: 'N', newOrganizationId: id(61), env }),
        dialect,
        { 'dir:org': null, 'dir:membership': null, [SYSTEM_PRINCIPAL_READ]: null },
      ),
      build(refreshUserOperation({ provider: 'clerk', subject: 'u', email: 'b@x.test', name: null, emailVerified: true, env }), dialect, {
        'refresh:user': { id: USER, email: 'a@x.test', name: null, email_verified: false, __stamp: sec(5) },
        'refresh:email': null,
      }),
      build(bootstrapOperation(args), dialect, { 'bs:user': null, 'bs:holder': null, 'bs:org': null }),
    ]
    for (const b of builds) for (const q of sqls(b)) expect(q).not.toMatch(/now\(\)|current_timestamp|current_date|strftime\('now'|datetime\('now'|'now'/i)
  })
})
