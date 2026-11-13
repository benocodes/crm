import { sql, type Expression, type Kysely, type SqlBool } from 'kysely'
import { COLUMN_KINDS, bind, type ColumnKind, type QueryContext } from '@vibase/storage'

// [[AGT8]] D11, D49, D51: the one statement that creates an execution row, shared by a direct enqueue and a queued approval. A guarded
// INSERT ... SELECT (the guards are the resolution's commit-time checks and, for an approval, "the request's transition applied"), so a refused guard writes
// nothing and the statements after it, which are gated on this one's effect, write nothing either.

/** The stored columns of a new execution; the lease columns start empty. */
export interface NewExecution {
  id: string
  at: string
  organizationId: string
  createdBy: string
  authorisedBy: string
  actionRequestId: string | null
  operation: string
  arguments: Record<string, unknown>
  resolution: Record<string, unknown>
  clientRef: string
  idempotencyKey: string | null
  inputHash: string
  deadlineAt: string
}

const KINDS = COLUMN_KINDS.action_executions as Record<string, ColumnKind>
const DEFAULT_CLIENT_REF_DOMAIN = 'vault.invalid'
export const DEADLINE_MS = 10 * 60_000

export const clientRefOf = (id: string, domain: string | undefined): string => `${id}@${domain ?? DEFAULT_CLIENT_REF_DOMAIN}`

export function executionColumns(e: NewExecution): Record<string, string | number | null> {
  return {
    id: e.id,
    created_at: e.at,
    updated_at: e.at,
    organization_id: e.organizationId,
    created_by: e.createdBy,
    authorised_by: e.authorisedBy,
    action_request_id: e.actionRequestId,
    connection_id: typeof e.resolution.connection_id === 'string' ? e.resolution.connection_id : null,
    operation: e.operation,
    arguments: JSON.stringify(e.arguments),
    resolution: JSON.stringify(e.resolution),
    status: 'queued',
    client_ref: e.clientRef,
    idempotency_key: e.idempotencyKey,
    input_hash: e.inputHash,
    deadline_at: e.deadlineAt,
    dispatched_at: null,
    done_at: null,
    attempts: 0,
    next_attempt_at: e.at,
    lease_until: null,
    lease_token: null,
    last_error_code: null,
    result: null,
    error_code: null,
    error_message: null,
  }
}

/**
 * `INSERT INTO action_executions (...) SELECT <bound values> WHERE <guards>`; with `onConflictNothing` a duplicate idempotency key or request link writes
 * nothing (a concurrent same-key call: invariant 3, never a caught 23505). The WHERE is always present (a SELECT without a FROM and a bare ON CONFLICT).
 */
export function insertExecution(qc: QueryContext, e: NewExecution, guards: Expression<SqlBool>[], opts: { onConflictNothing: boolean }) {
  const L = qc.db as unknown as Kysely<Record<string, Record<string, unknown>>>
  const values = executionColumns(e)
  let select = L.selectNoFrom(Object.entries(values).map(([c, v]) => bind(qc, KINDS[c]!, v as never).as(c))).where(sql<SqlBool>`1 = 1`)
  for (const g of guards) select = select.where(g)
  const insert = L.insertInto('action_executions').columns(Object.keys(values)).expression(select)
  return opts.onConflictNothing ? insert.onConflict((oc) => oc.doNothing()) : insert
}
