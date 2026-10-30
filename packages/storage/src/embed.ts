import { sql, type RawBuilder } from 'kysely'
import { COLUMN_KINDS, type ColumnKind, type PhysicalTable } from './database.js'
import { ts } from './program.js'
import type { QueryContext } from './types.js'

/**
 * An embedded child set of a record ([[CORE25]] D50, P8): the rows of `table` whose `key` column points at the parent,
 * as a JSON array of objects holding `columns`, ordered by `orderBy`. `[]` when there are none (never null). Rendered by
 * ONE helper so the record select and an event's `after` (`recordJson`) agree.
 */
export interface EmbedSpec {
  readonly table: PhysicalTable
  readonly key: string
  readonly columns: readonly string[]
  readonly orderBy: readonly string[]
}

/** Throws unless `table`, `key`, every column and every orderBy are modelled: a load-time check as much as a render-time one. */
export function checkEmbed(spec: EmbedSpec): void {
  const kinds = (COLUMN_KINDS as Record<string, Record<string, ColumnKind>>)[spec.table]
  if (!kinds) throw new Error(`embed: table "${spec.table}" is not modelled`)
  for (const c of [spec.key, ...spec.columns, ...spec.orderBy]) if (!(c in kinds)) throw new Error(`embed: "${c}" is not a column of ${spec.table}`)
  if (!('organization_id' in kinds)) throw new Error(`embed: ${spec.table} has no organization_id`)
}

/**
 * The embed as a scalar subquery correlated on `child.<key> = parent.id AND child.organization_id = parent.organization_id`.
 * `ctx` is where it lands: 'select' (a record select, any value type is fine) or 'json' (nested inside `recordJson`'s object,
 * where D1 must see JSON, not text, hence the `json(...)` wrap).
 */
export function embedJson(qc: QueryContext, parent: PhysicalTable, spec: EmbedSpec, ctx: 'select' | 'json'): RawBuilder<unknown> {
  checkEmbed(spec)
  const kinds = COLUMN_KINDS[spec.table] as Record<string, ColumnKind>
  const ref = (c: string) => sql.ref(`${spec.table}.${c}`)
  const pairs = spec.columns.map((c) => {
    const kind = kinds[c]
    const value =
      kind === 'timestamp'
        ? ts.iso(qc, `${spec.table}.${c}`)
        : qc.dialect === 'd1' && kind === 'boolean'
          ? sql`json(iif(${ref(c)}, 'true', 'false'))`
          : qc.dialect === 'd1' && (kind === 'json' || kind === 'string_array')
            ? sql`json(${ref(c)})`
            : sql`${ref(c)}`
    return sql`${sql.lit(c)}, ${value}`
  })
  const order = sql.join(spec.orderBy.map((c) => ref(c)))
  const where = sql`${ref(spec.key)} = ${sql.ref(`${parent}.id`)} and ${ref('organization_id')} = ${sql.ref(`${parent}.organization_id`)}`
  if (qc.dialect === 'postgres') {
    return sql`(select coalesce(jsonb_agg(jsonb_build_object(${sql.join(pairs)}) order by ${order}), '[]'::jsonb) from ${sql.table(spec.table)} where ${where})`
  }
  const inner = sql`(select json_group_array(json_object(${sql.join(pairs)}) order by ${order}) from ${sql.table(spec.table)} where ${where})`
  return ctx === 'json' ? sql`json(${inner})` : inner
}
