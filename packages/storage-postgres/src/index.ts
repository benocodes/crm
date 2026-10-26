import { CompiledQuery, sql, type Kysely, type Transaction } from 'kysely'
import { withOrganization, withServiceRole, type Database } from '@vault/db'
import {
  DEFAULT_MAX_SET_SIZE,
  StatementFailed,
  StorageError,
  UnitDriftError,
  planUnit,
  queryContext,
  toCompiled,
  type ConstraintKind,
  type ExecutionResult,
  type PostgresBinding,
  type PreparedOperation,
  type Row,
  type Runtime,
  type StorageIdentity,
} from '@vault/storage'

// The Postgres runtime ([[CORE35]] C2), enterprise tier (D14). It delegates role and session setup to the
// tenancy wrappers (AGENTS.md invariant 1), runs the plan phase and the commit phase in ONE transaction under
// the organisation writer lock (so drift cannot happen), validates the final record before commit, counts the
// statements it really sends, and never catches 23505 inside the transaction (ON CONFLICT is the program's job).

/** The organisation writer lock key: same hashing as the existing `lockKeys` convention (api identity/locks). */
export const orgWriterKey = (organizationId: string): string => `org-writer:${organizationId}`

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const KIND: Record<string, ConstraintKind> = { '23503': 'foreign_key', '23505': 'unique', '23514': 'check', '23502': 'not_null' }

/** Maps a Postgres error to the engine-neutral failure kind; `null` when it is not a statement failure. */
export function classifyPostgresError(err: unknown): ConstraintKind | null {
  const code = (err as { code?: unknown } | null)?.code
  if (typeof code !== 'string' || !/^[0-9A-Z]{5}$/.test(code)) return null
  return KIND[code] ?? 'other'
}

export interface PostgresRuntimeOptions {
  /** The cap on any bounded set (D7). A policy of this runtime, not of any domain program. Default 100. */
  maxSetSize?: number
}

export function createPostgresRuntime(db: Kysely<Database>, options: PostgresRuntimeOptions = {}): Runtime {
  const maxSetSize = options.maxSetSize ?? DEFAULT_MAX_SET_SIZE
  return {
    dialect: 'postgres',
    maxSetSize,
    async execute<T>(identity: StorageIdentity, prepared: PreparedOperation<T>): Promise<ExecutionResult<T>> {
      const qc = queryContext('postgres', maxSetSize)
      // Refusals come before any SQL (CORE41 C1): a mutating account unit, and an internal organisation that is not a UUID.
      if (identity.kind === 'account' && prepared.mutates) throw new StorageError(`account units are read-only (${prepared.name})`)
      if (identity.kind === 'internal' && identity.organizationId !== null && !UUID.test(identity.organizationId)) {
        throw new StorageError('an internal identity names an organisation that is not a UUID')
      }
      // The organisation whose writer lock a mutating unit takes: the tenant's own, or the one an internal unit names.
      const lockOrganization = identity.kind === 'tenant' ? identity.organizationId : identity.kind === 'internal' ? identity.organizationId : null
      const scope = <R>(fn: (trx: Transaction<Database>) => Promise<R>): Promise<R> =>
        identity.kind === 'tenant'
          ? withOrganization(db, { principalId: identity.actorId, organizationId: identity.organizationId }, fn)
          : withServiceRole(db, fn)
      return scope(async (trx) => {
        let statements = 0
        const run = async (compiled: CompiledQuery<unknown>) => {
          statements += 1
          try {
            return await trx.executeQuery(compiled)
          } catch (err) {
            const kind = classifyPostgresError(err)
            throw kind ? new StatementFailed(prepared.name, kind, err) : err
          }
        }
        let locks = 0
        if (prepared.mutates && lockOrganization !== null) {
          locks = 1
          await run(sql`select pg_advisory_xact_lock(hashtextextended(${orgWriterKey(lockOrganization)}, 0))`.compile(trx))
        }
        const planned = await planUnit(prepared, qc, async (reads) => {
          const out: Record<string, readonly Row[]> = {}
          for (const read of reads) out[read.key] = (await run(CompiledQuery.raw(read.sql, [...read.parameters]))).rows as Row[]
          return out
        })
        let resultRows: readonly Row[] = []
        for (const step of planned.unit.steps) {
          const res = await run(toCompiled(step.query))
          // No drift is possible under the lock; a statement that was planned to change a row and did not is a bug or a lost race: abort.
          const affected = Number(res.numAffectedRows ?? 0n)
          if (step.expect === 'affected' && affected === 0) throw new UnitDriftError(prepared.name)
          if (typeof step.expect === 'object' && affected !== step.expect.rows) throw new UnitDriftError(prepared.name)
          if (step.expect === 'holds' && (res.rows as Row[])[0]?.holds !== true) throw new UnitDriftError(prepared.name)
          if (step.label === 'result') resultRows = res.rows as Row[]
        }
        // Decoding (which validates the record with Zod) happens BEFORE commit: a malformed record rolls everything back.
        const value = planned.unit.decode(resultRows, planned.found)
        return {
          value,
          events: planned.unit.events,
          stats: { reads: planned.reads, writes: planned.unit.steps.length, locks, statements, roundTrips: 1 },
        }
      })
    },
  }
}

export function postgresBinding(db: Kysely<Database>, options: PostgresRuntimeOptions = {}): PostgresBinding {
  return { kind: 'postgres', runtime: createPostgresRuntime(db, options) }
}
