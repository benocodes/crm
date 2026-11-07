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

/** CORE170 D3/D11: convention first, then declared names; kinds have one metadata source. */
export function resolveSorts(metadata: SortMetadata): Readonly<Record<string, SortKind>> {
  const convention = ['id', 'created_at', 'updated_at'].filter((name) => Object.hasOwn(metadata.columns, name))
  const declared = metadata.sorts ?? []
  for (const [i, name] of declared.entries()) {
    if (convention.includes(name)) throw new Error(`sorts "${name}" repeats the convention (${metadata.name})`)
    if (declared.indexOf(name) !== i) throw new Error(`sorts "${name}" is listed twice (${metadata.name})`)
  }
  return Object.freeze(Object.fromEntries([...convention, ...declared].map((name): [string, SortKind] => {
    const kind = Object.hasOwn(metadata.columns, name) ? metadata.columns[name] : metadata.derived?.[name]?.kind
    if (!kind) throw new Error(`sorts "${name}" is unknown (${metadata.name})`)
    if (!Object.hasOwn(metadata.record.shape, name)) throw new Error(`sorts "${name}" is not a field of the record (${metadata.name})`)
    if (kind !== 'timestamp' && kind !== 'uuid' && kind !== 'text' && kind !== 'integer') throw new Error(`sorts "${name}" has unsupported kind ${kind} (${metadata.name})`)
    return [name, kind]
  })))
}

/** Explicit opt-in until the rollout cycles adopt column sorts; legacy derived-only definitions are unchanged. */
export function withColumnSorts<T extends PreparedResource>(def: T, names: readonly string[] = def.sorts ?? []): T & { readonly sortKinds: Readonly<Record<string, SortKind>>; readonly sorts: readonly string[] } {
  const sortKinds = resolveSorts({ ...def, columns: COLUMN_KINDS[def.table as keyof typeof COLUMN_KINDS], sorts: names })
  for (const key of ['sort', 'order']) {
    if (key in (def.filters ?? {}) || key in (def.joinFilters ?? {})) throw new Error(`"${key}" is a parameter of a sorted list and cannot also be a filter (${def.name})`)
  }
  return { ...def, sorts: Object.freeze(Object.keys(sortKinds)), sortKinds }
}
