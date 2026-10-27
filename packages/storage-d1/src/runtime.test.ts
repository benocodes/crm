import { describe, expect, it } from 'vitest'
import { CommitOutcomeUnknown, ForeignOrganizationError, StatementFailed, StorageError, UnitDriftError, defineOperation, step, unit } from '@vault/storage'
import { sql } from 'kysely'
import { classifyD1Error, createD1Runtime, d1Binding, D1_MAX_PARAMETERS } from './index.js'
import type { D1Like } from './binding.js'

const ORG = '0190b2c4-0000-7000-8000-00000000a001'
const OPTS = { organizationId: ORG, authProvider: 'clerk', authOrgId: 'org_x' }
const tenant = { kind: 'tenant' as const, actorId: ORG, organizationId: ORG }

describe('the D1 runtime refuses a statement it cannot send without calling it an unknown commit', () => {
  const sent: string[] = []
  const d1: D1Like = {
    prepare: () => {
      throw new Error('prepare must not be reached for an over-limit statement')
    },
    batch: async (s) => {
      sent.push(`batch:${s.length}`)
      return []
    },
  }
  const withParameters = (n: number) =>
    defineOperation<null>({
      name: 'too.many',
      mutates: true,
      reads: () => ({}),
      build: (_f, qc) =>
        unit({
          steps: [step(sql`select ${sql.join(Array.from({ length: n }, (_, i) => sql`${i}`))}`.compile(qc.db), 'first-mutation')],
          events: [],
          decode: () => null,
        }),
    })

  it(`a statement over ${D1_MAX_PARAMETERS} parameters is a StorageError, nothing is sent and it is not CommitOutcomeUnknown`, async () => {
    const runtime = createD1Runtime({ ...d1, prepare: () => ({}) as never }, OPTS)
    const err = await runtime.execute(tenant, withParameters(D1_MAX_PARAMETERS + 1)).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(StorageError)
    expect(err).not.toBeInstanceOf(CommitOutcomeUnknown)
    expect((err as Error).message).toMatch(/101 parameters/)
    expect(sent).toEqual([])
  })

  it('classifies SQLite errors as statement failures and a lost transport as unknown', () => {
    expect(classifyD1Error(new Error('D1_ERROR: FOREIGN KEY constraint failed: SQLITE_CONSTRAINT'))).toEqual({ statement: true, kind: 'foreign_key' })
    expect(classifyD1Error(new Error('D1_ERROR: Network connection lost'))).toEqual({ statement: false })
  })
})

describe('a failed unit assertion is drift (CORE36 C2, D4)', () => {
  const op = defineOperation<null>({
    name: 'assertion.demo',
    mutates: true,
    reads: () => ({}),
    build: (_f, qc) => unit({ steps: [step(sql`select 1`.compile(qc.db), 'first-mutation')], events: [], decode: () => null }),
  })
  const failing = (message: string): D1Like => ({
    prepare: () => ({ bind: () => ({}) }) as never,
    batch: async () => {
      throw new Error(message)
    },
  })
  const run = (message: string) =>
    createD1Runtime(failing(message), OPTS)
      .execute(tenant, op)
      .catch((e: unknown) => e)

  it('classifies the named constraint before the generic CHECK pattern', () => {
    expect(classifyD1Error(new Error('D1_ERROR: CHECK constraint failed: unit_assertion_holds: SQLITE_CONSTRAINT'))).toEqual({ drift: true })
  })
  it('raises UnitDriftError for the assertion constraint', async () => {
    expect(await run('D1_ERROR: CHECK constraint failed: unit_assertion_holds: SQLITE_CONSTRAINT (extended: SQLITE_CONSTRAINT_CHECK)')).toBeInstanceOf(UnitDriftError)
  })
  it('keeps any other CHECK failure a StatementFailed of kind check', async () => {
    const err = await run('D1_ERROR: CHECK constraint failed: identities_kind: SQLITE_CONSTRAINT')
    expect(err).toBeInstanceOf(StatementFailed)
    expect((err as StatementFailed).kind).toBe('check')
  })
})

describe('arrays are bound as JSON text (CORE40 C1)', () => {
  it('a string array parameter reaches D1 as the JSON text of the array', async () => {
    const bound: unknown[][] = []
    const d1: D1Like = {
      prepare: () => ({ bind: (...values: unknown[]) => (bound.push(values), {}) }) as never,
      batch: async () => [{ results: [], meta: {} }] as never,
    }
    const op = defineOperation<null>({
      name: 'array.demo',
      mutates: true,
      reads: () => ({}),
      build: (_f, qc) => unit({ steps: [step(sql`select ${['x', 'y']}`.compile(qc.db), 'first-mutation')], events: [], decode: () => null }),
    })
    await createD1Runtime(d1, OPTS).execute(tenant, op)
    expect(bound).toEqual([['["x","y"]']])
  })
})

describe('storage identities (CORE41 C1, D19)', () => {
  const OTHER = '0190b2c4-0000-7000-8000-00000000a002'
  const spy = () => {
    const calls: string[] = []
    const d1: D1Like = {
      prepare: (q) => (calls.push(q), { bind: () => ({}) }) as never,
      batch: async () => [] as never,
    }
    return { d1, calls }
  }
  const read = defineOperation<number>({ name: 'read', mutates: false, reads: () => ({}), build: () => unit({ steps: [], events: [], decode: () => 1 }) })
  const write = defineOperation<number>({ name: 'write', mutates: true, reads: () => ({}), build: () => unit({ steps: [], events: [], decode: () => 1 }) })

  it('refuses an internal identity for another organisation before any SQL', async () => {
    const { d1, calls } = spy()
    const err = await createD1Runtime(d1, OPTS).execute({ kind: 'internal', organizationId: OTHER }, read).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ForeignOrganizationError)
    expect(calls).toEqual([])
  })
  it('admits an internal identity with no organisation', async () => {
    expect((await createD1Runtime(spy().d1, OPTS).execute({ kind: 'internal', organizationId: null }, read)).value).toBe(1)
  })
  it('admits an internal identity for the configured organisation', async () => {
    expect((await createD1Runtime(spy().d1, OPTS).execute({ kind: 'internal', organizationId: ORG }, write)).value).toBe(1)
  })
  it('refuses a mutating account unit before any SQL, and admits a read-only one', async () => {
    const { d1, calls } = spy()
    const runtime = createD1Runtime(d1, OPTS)
    const err = await runtime.execute({ kind: 'account', actorId: ORG }, write).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(StorageError)
    expect((err as Error).message).toMatch(/account units are read-only/)
    expect(calls).toEqual([])
    expect((await runtime.execute({ kind: 'account', actorId: ORG }, read)).value).toBe(1)
  })
  it('still refuses a tenant identity for another organisation before any SQL', async () => {
    const { d1, calls } = spy()
    const err = await createD1Runtime(d1, OPTS).execute({ kind: 'tenant', actorId: ORG, organizationId: OTHER }, read).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ForeignOrganizationError)
    expect(calls).toEqual([])
  })
  it('the binding carries the deployment auth link', () => {
    const binding = d1Binding(spy().d1, { organizationId: ORG, authProvider: 'clerk', authOrgId: 'org_x' })
    expect(binding.authProvider).toBe('clerk')
    expect(binding.authOrgId).toBe('org_x')
    expect(binding.organizationId).toBe(ORG)
  })
})
