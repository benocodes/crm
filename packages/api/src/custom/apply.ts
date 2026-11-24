import type { D1Like } from '@vibase/storage-d1'
import type { FieldDeclaration, FieldKind, ObjectDeclaration } from './declaration.js'
import { bagColumnDefinition, columnDefinition, createTableStatements, ident, literal } from './ddl.js'

// Apply ([[CORE315]] D11, D31, D32; [[CORE542]]): makes a D1 database's `__c` tables match the extensions file. Three parts (P1): `readLiveSchema` turns a D1 binding into a plain snapshot, `planApply` is a pure function from
// (declarations, snapshot) to the plan, and `applyExtensions` runs the plan: the violation reads first, then the DDL as one batch, and nothing at all when anything is refused (P2). The live schema is the only state (P3):
// nothing is recorded anywhere, and a second run over an applied schema plans nothing. Apply reads and writes only tables whose name ends `__c` (P7).

/** The columns every custom table has and apply never compares ([[CORE315]] D19; `additional_props` is [[CORE318]]'s, P7). */
const BOOKKEEPING = [
  'id',
  'organization_id',
  'created_by',
  'created_at',
  'updated_at',
  'deleted_at',
  'additional_props',
]
/** D1 allows 100 columns per table (P5). */
export const COLUMN_LIMIT = 100

export interface LiveColumn {
  name: string
  type: string
  notnull: boolean
  /** `pragma_table_info`'s `dflt_value`: the SQL text of the default, or null. */
  default: string | null
}
export interface LiveTable {
  /** The table's `CREATE TABLE` text from `sqlite_master`; `ADD COLUMN` appends the column's own definition to it, which is how a kind is read back (P3). */
  sql: string
  columns: LiveColumn[]
  indexes: { name: string; sql: string }[]
}
/** The live custom schema as plain data: what a reader produces from a binding, or from `wrangler d1 execute --remote --json` (D30). */
export interface LiveSchema {
  tables: Record<string, LiveTable>
}
export interface Refusal {
  /** A stable code: `kind_changed`, `target_changed`, `required_to_optional`, `optional_to_required`, `required_without_default`, `default_changed`, `unique_removed`, `column_cap`, `unique_violation`. */
  rule: string
  object: string
  field?: string
  message: string
  /** `unique_violation` only: the value that more than one live row holds, and those rows' ids. */
  value?: unknown
  ids?: string[]
}
/** A read the plan needs run before any DDL: it returns the groups of live rows a new unique index would refuse. */
export interface ViolationRead {
  object: string
  field: string
  sql: string
}
export interface ApplyPlan {
  statements: string[]
  created: string[]
  added: { object: string; field: string }[]
  indexed: { object: string; index: string }[]
  /** D31: a `__c` table (no `field`) or column with no declaration. Nothing is dropped. */
  archived: { object: string; field?: string }[]
  refused: Refusal[]
  reads: ViolationRead[]
}
export interface ApplyReport {
  created: string[]
  added: { object: string; field: string }[]
  indexed: { object: string; index: string }[]
  archived: { object: string; field?: string }[]
  refused: Refusal[]
  /** How many DDL statements ran (0 when anything was refused). */
  statements: number
}

/** The SQL a reader runs (a remote reader runs the same text): the custom tables, then per table its columns and its indexes. */
export const LIVE_TABLES_SQL = `select name, sql from sqlite_master where type = 'table' and name like '%\\_\\_c' escape '\\' order by name`
export const LIVE_COLUMNS_SQL = `select name, type, "notnull", dflt_value from pragma_table_info(?)`
export const LIVE_INDEXES_SQL = `select name, sql from sqlite_master where type = 'index' and tbl_name = ? and sql is not null order by name`

/** A reader of rows: the one thing a snapshot needs from a database. The binds are positional (`?`); a transport with no binds (wrangler's `--command`) inlines them. */
export type RowReader = <T>(sql: string, ...binds: unknown[]) => Promise<T[]> | T[]

/** Builds the snapshot from any row reader (D30): the D1 binding's, or a `wrangler d1 execute --remote --json` call's. D1 refuses `pragma_table_info` in a join, so each table is read on its own. */
export async function liveSchemaFrom(rows: RowReader): Promise<LiveSchema> {
  const tables: Record<string, LiveTable> = {}
  for (const t of await rows<{ name: string; sql: string }>(LIVE_TABLES_SQL)) {
    const columns = await rows<{ name: string; type: string; notnull: number; dflt_value: string | null }>(
      LIVE_COLUMNS_SQL,
      t.name,
    )
    tables[t.name] = {
      sql: t.sql,
      columns: columns.map((c) => ({ name: c.name, type: c.type, notnull: c.notnull === 1, default: c.dflt_value })),
      indexes: await rows<{ name: string; sql: string }>(LIVE_INDEXES_SQL, t.name),
    }
  }
  return { tables }
}

/** Reads the live custom schema from a D1 binding. */
export const readLiveSchema = (d1: D1Like): Promise<LiveSchema> =>
  liveSchemaFrom(
    async <T>(sql: string, ...binds: unknown[]) =>
      ((
        await d1
          .prepare(sql)
          .bind(...binds)
          .all()
      ).results ?? []) as T[],
  )

/** The refusals a violation read's groups make (D22): one per value that more than one live row holds. Shared by the binding's apply and a remote apply. */
export function violationRefusals(r: ViolationRead, groups: { value: unknown; ids: unknown }[]): Refusal[] {
  return groups.map((g) => {
    const ids = String(g.ids).split(',').sort()
    return {
      rule: 'unique_violation',
      object: r.object,
      field: r.field,
      value: g.value,
      ids,
      message: `${r.object}.${r.field} cannot be unique: ${JSON.stringify(g.value)} is held by ${ids.length} live rows (${ids.join(', ')})`,
    }
  })
}

/** The column definitions of a `CREATE TABLE` text, by column name: the text between the outer parentheses, split at top-level commas (quotes and nested parentheses respected). */
function columnDefinitions(createSql: string): Map<string, string> {
  const out = new Map<string, string>()
  const open = createSql.indexOf('(')
  if (open < 0) return out
  let depth = 0
  let quote: string | null = null
  let start = open + 1
  const push = (end: number) => {
    const def = createSql.slice(start, end).trim()
    const name = /^"((?:[^"]|"")*)"/.exec(def)?.[1]
    if (name !== undefined) out.set(name.replaceAll('""', '"'), def)
  }
  for (let i = open + 1; i < createSql.length; i++) {
    const c = createSql[i]!
    if (quote !== null) {
      if (c === quote) quote = null
    } else if (c === '"' || c === "'") quote = c
    else if (c === '(') depth++
    else if (c === ')') {
      if (depth === 0) {
        push(i)
        break
      }
      depth--
    } else if (c === ',' && depth === 0) {
      push(i)
      start = i + 1
    }
  }
  return out
}

interface LiveField {
  kind: FieldKind
  target?: string
  required: boolean
  default: string | null
  unique: boolean
}
/**
 * The kind a column was created as, read from its definition text (P3): `createTableStatements` gives each kind its own mark, so kinds that share a storage type tell apart (a text has a length CHECK, a timestamp a strftime CHECK,
 * a boolean `IN (0, 1)`, a reference its REFERENCES clause; an enum is TEXT with none of them, an integer INTEGER with none). String literals (a default's text) are blanked first so they cannot pose as a mark.
 */
function liveKind(def: string): { kind: FieldKind; target?: string } {
  const bare = def.replace(/'(?:[^']|'')*'/g, "''")
  const ref = /\bREFERENCES\s+"((?:[^"]|"")*)"/.exec(bare)
  if (ref) return { kind: 'reference', target: ref[1]!.replaceAll('""', '"') }
  if (/\blength\(/.test(bare)) return { kind: 'text' }
  if (/strftime\(/.test(bare)) return { kind: 'timestamp' }
  if (/\bIN \(0, 1\)/.test(bare)) return { kind: 'boolean' }
  return /^"(?:[^"]|"")*"\s+INTEGER\b/i.test(bare) ? { kind: 'integer' } : { kind: 'enum' }
}

function liveFields(key: string, table: LiveTable): Map<string, LiveField> {
  const defs = columnDefinitions(table.sql)
  const indexes = new Map(table.indexes.map((i) => [i.name, i.sql]))
  const out = new Map<string, LiveField>()
  for (const c of table.columns) {
    if (BOOKKEEPING.includes(c.name)) continue
    const { kind, target } = liveKind(defs.get(c.name) ?? `${ident(c.name)} ${c.type}`)
    out.set(c.name, {
      kind,
      ...(target !== undefined ? { target } : {}),
      required: c.notnull,
      default: c.default,
      unique: /^\s*CREATE\s+UNIQUE\b/i.test(indexes.get(`idx_${key}_${c.name}_unique`) ?? ''),
    })
  }
  return out
}

const INDEX_NAME = /^CREATE (?:UNIQUE )?INDEX IF NOT EXISTS "((?:[^"]|"")*)"/

/** Rows a new unique index on `field` would refuse: groups of live rows holding one value. Existing column: its own values; a new column with a constant default: every live row holds the default. */
function violationRead(key: string, field: string, f: FieldDeclaration, isNew: boolean): ViolationRead {
  const t = ident(key)
  const sql = isNew
    ? `select ${literal(f.default!)} as value, group_concat(id) as ids from ${t} where deleted_at is null group by organization_id having count(*) > 1`
    : `select ${ident(field)} as value, group_concat(id) as ids from ${t} where deleted_at is null and ${ident(field)} is not null group by organization_id, ${ident(field)} having count(*) > 1`
  return { object: key, field, sql }
}

/** The plan for a set of declarations against the live schema (D11, D31, D32, P2 to P5): pure, so a remote reader's snapshot feeds the same function. */
export function planApply(objects: Record<string, ObjectDeclaration>, live: LiveSchema): ApplyPlan {
  const creates: string[] = []
  const adds: string[] = []
  const indexes: string[] = []
  const plan: ApplyPlan = { statements: [], created: [], added: [], indexed: [], archived: [], refused: [], reads: [] }
  const refuse = (rule: string, object: string, field: string | undefined, message: string) =>
    plan.refused.push({ rule, object, ...(field !== undefined ? { field } : {}), message })

  for (const [key, decl] of Object.entries(objects)) {
    const table = live.tables[key]
    if (table === undefined) {
      creates.push(...createTableStatements(key, decl))
      plan.created.push(key)
      continue
    }
    const fields = liveFields(key, table)
    let added = 0
    // [[CORE318]] D13: a table made before the bag existed gets the column, in the same plan and batch as the rest of the DDL; a table that has it plans nothing.
    if (!table.columns.some((c) => c.name === 'additional_props')) {
      adds.push(`ALTER TABLE ${ident(key)} ADD COLUMN ${bagColumnDefinition(key)}`)
      plan.added.push({ object: key, field: 'additional_props' })
      added++
    }
    for (const [name, f] of Object.entries(decl.fields)) {
      const lf = fields.get(name)
      const at = `${key}.${name}`
      if (lf === undefined) {
        if (f.required === true && f.default === undefined) {
          refuse(
            'required_without_default',
            key,
            name,
            `${at} is a new required field with no default: existing rows would have no value`,
          )
          continue
        }
        adds.push(`ALTER TABLE ${ident(key)} ADD COLUMN ${columnDefinition(name, f)}`)
        plan.added.push({ object: key, field: name })
        added++
        if (f.unique === true && f.default !== undefined) plan.reads.push(violationRead(key, name, f, true))
        continue
      }
      if (lf.kind !== f.kind) {
        refuse(
          'kind_changed',
          key,
          name,
          `${at} is a ${lf.kind} field and the file declares ${f.kind}: a kind never changes`,
        )
        continue
      }
      if (f.kind === 'reference' && lf.target !== f.target) {
        refuse(
          'target_changed',
          key,
          name,
          `${at} references ${lf.target} and the file declares ${f.target}: a target never changes`,
        )
        continue
      }
      if (lf.required && f.required !== true)
        refuse('required_to_optional', key, name, `${at} is required and the file declares it optional`)
      if (!lf.required && f.required === true)
        refuse('optional_to_required', key, name, `${at} is optional and the file declares it required`)
      const want = f.default === undefined ? null : literal(f.default)
      if (lf.default !== want)
        refuse(
          'default_changed',
          key,
          name,
          `${at} has default ${lf.default ?? 'none'} and the file declares ${want ?? 'none'}: a default cannot be changed in place`,
        )
      if (lf.unique && f.unique !== true)
        refuse(
          'unique_removed',
          key,
          name,
          `${at} is unique and the file declares it not: the live index would still refuse what the file allows`,
        )
      if (!lf.unique && f.unique === true) plan.reads.push(violationRead(key, name, f, false))
    }
    for (const name of fields.keys())
      if (decl.fields[name] === undefined) plan.archived.push({ object: key, field: name })
    if (table.columns.length + added > COLUMN_LIMIT)
      refuse(
        'column_cap',
        key,
        undefined,
        `${key} would have ${table.columns.length + added} columns, over D1's ${COLUMN_LIMIT} (archived columns count)`,
      )
    const have = new Set(table.indexes.map((i) => i.name))
    for (const s of createTableStatements(key, decl).slice(1)) {
      const name = INDEX_NAME.exec(s)?.[1]?.replaceAll('""', '"')
      if (name !== undefined && !have.has(name)) {
        indexes.push(s)
        plan.indexed.push({ object: key, index: name })
      }
    }
  }
  for (const key of Object.keys(live.tables)) if (objects[key] === undefined) plan.archived.push({ object: key })
  plan.statements = [...creates, ...adds, ...indexes]
  return plan
}

/** Reads the live schema, plans, runs the violation reads, and (only when nothing is refused) runs the DDL as one batch. */
export async function applyExtensions(d1: D1Like, objects: Record<string, ObjectDeclaration>): Promise<ApplyReport> {
  const plan = planApply(objects, await readLiveSchema(d1))
  const refused = [...plan.refused]
  for (const r of plan.reads)
    refused.push(
      ...violationRefusals(r, ((await d1.prepare(r.sql).all()).results ?? []) as { value: unknown; ids: unknown }[]),
    )
  if (refused.length > 0)
    return { created: [], added: [], indexed: [], archived: plan.archived, refused, statements: 0 }
  if (plan.statements.length > 0) await d1.batch(plan.statements.map((s) => d1.prepare(s)))
  return {
    created: plan.created,
    added: plan.added,
    indexed: plan.indexed,
    archived: plan.archived,
    refused: [],
    statements: plan.statements.length,
  }
}
