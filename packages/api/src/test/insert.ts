// Test-only. Shared by the direct-insert setup devices (Engine.insert, the contract sessions' insert).
import { COLUMN_KINDS, uuidv7, type ColumnKind } from '@vault/storage'

export const SEED_AT = '2026-10-22T08:00:00.000Z'

export const kindsOf = (table: string): Record<string, ColumnKind> => {
  const kinds = (COLUMN_KINDS as Record<string, Record<string, ColumnKind>>)[table]
  if (!kinds) throw new Error(`no modelled table "${table}"`)
  return kinds
}

/** Fills `id`, `organization_id`, `created_by`, `created_at` and `updated_at` when the table has them and the row omits them. */
export function withTenantDefaults(table: string, row: Record<string, unknown>, tenant: { organizationId: string; userId: string }): Record<string, unknown> {
  const kinds = kindsOf(table)
  const out = { ...row }
  if ('id' in kinds) out.id ??= uuidv7()
  if ('organization_id' in kinds) out.organization_id ??= tenant.organizationId
  if ('created_by' in kinds) out.created_by ??= tenant.userId
  if ('created_at' in kinds) out.created_at ??= SEED_AT
  if ('updated_at' in kinds) out.updated_at ??= SEED_AT
  return out
}

/** A value as D1 binds it: booleans 1/0, arrays and objects (json columns) as JSON text. */
export const d1Value = (v: unknown): unknown =>
  typeof v === 'boolean' ? (v ? 1 : 0) : v !== null && typeof v === 'object' && !(v instanceof Date) ? JSON.stringify(v) : (v ?? null)
