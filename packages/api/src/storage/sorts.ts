import { COLUMN_KINDS, type ColumnKind } from '@vault/storage'
import type { SortKind } from '../resources/sort-cursor.js'
import type { PreparedResource } from './definition.js'

export interface SortMetadata {
  readonly name: string
  readonly columns: Readonly<Record<string, ColumnKind>>
  readonly record: { readonly shape: Readonly<Record<string, unknown>> }
  readonly derived?: Readonly<Record<string, { readonly kind: string }>>
  readonly sorts?: readonly string[]
}

// Minimal loadable red-phase seam; assertions exercise the missing metadata resolution.
export function resolveSorts(_metadata: SortMetadata): Readonly<Record<string, SortKind>> {
  return {}
}

export function withColumnSorts<T extends PreparedResource>(def: T, names: readonly string[] = def.sorts ?? []): T {
  resolveSorts({ ...def, columns: COLUMN_KINDS[def.table as keyof typeof COLUMN_KINDS], sorts: names })
  return def
}
