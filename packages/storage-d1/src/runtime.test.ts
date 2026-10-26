import { describe, expect, it } from 'vitest'
import { CommitOutcomeUnknown, StatementFailed, StorageError, UnitDriftError, defineOperation, step, unit } from '@vault/storage'
import { sql } from 'kysely'
import { classifyD1Error, createD1Runtime, D1_MAX_PARAMETERS } from './index.js'
import type { D1Like } from './binding.js'

const ORG = '0190b2c4-0000-7000-8000-00000000a001'

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
    const runtime = createD1Runtime({ ...d1, prepare: () => ({}) as never }, { organizationId: ORG })
    const err = await runtime.execute({ actorId: ORG, organizationId: ORG }, withParameters(D1_MAX_PARAMETERS + 1)).catch((e: unknown) => e)
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
    createD1Runtime(failing(message), { organizationId: ORG })
      .execute({ actorId: ORG, organizationId: ORG }, op)
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
