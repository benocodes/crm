// Test-only (spec CORE38 D10, CORE47 P3-P5): reads the physical constraint shape of both engines and diffs them.
// Only the enterprise side may import both engines (invariant 10), so this lives in @vault/storage-postgres.
import { sql, type Kysely } from 'kysely'
import type { D1Like } from '@vault/storage-d1'

export type Aspect = 'table' | 'primaryKey' | 'foreignKey' | 'uniqueKey' | 'index' | 'namedCheck'
export interface TableShape { primaryKey: string[]; foreignKeys: string[]; uniqueKeys: string[]; indexes: string[]; namedChecks: string[] }
export interface SchemaShape { tables: string[]; byTable: Record<string, TableShape> }
export interface EngineDifference { aspect: Aspect; engine: 'postgres' | 'd1'; table: string; item: string; reason: string; d1Fragment?: string }

const ASPECT_ORDER: Aspect[] = ['table', 'primaryKey', 'foreignKey', 'uniqueKey', 'index', 'namedCheck']

/** Lower-case, casts dropped, parentheses removed, whitespace collapsed: Postgres's and SQLite's spellings of a predicate agree. */
export function normalizePredicate(predicate: string | null): string {
  if (predicate === null) return ''
  return predicate
    .toLowerCase()
    .replace(/::(?:character varying|timestamp with(?:out)? time zone|double precision|[a-z_][a-z0-9_]*)(?:\[\])?/g, '')
    .replace(/[()]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

export function fkItem(cols: string[], refTable: string, refCols: string[], onDelete: string): string {
  return `(${cols.join(', ')}) -> ${refTable}(${refCols.join(', ')}) on delete ${onDelete.toLowerCase()}`
}

export function uniqueItem(cols: string[], predicate: string | null): string {
  const p = normalizePredicate(predicate)
  return `(${cols.join(', ')})${p ? ` where ${p}` : ''}`
}

export function indexItem(name: string, cols: string[], predicate: string | null): string {
  const p = normalizePredicate(predicate)
  return `${name} (${cols.join(', ')})${p ? ` where ${p}` : ''}`
}

/** The names of `CONSTRAINT <name> CHECK` clauses of a CREATE TABLE text, in order of appearance. */
export function d1CheckNames(createTableSql: string): string[] {
  return [...createTableSql.matchAll(/\bCONSTRAINT\s+"?([A-Za-z0-9_]+)"?\s+CHECK\b/gi)].map((m) => m[1]!)
}

const byText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)

/** One entry per item present on one engine only. Per-table aspects are compared for tables present on both. */
export function diffShapes(pg: SchemaShape, d1: SchemaShape): EngineDifference[] {
  const out: EngineDifference[] = []
  const add = (aspect: Aspect, engine: 'postgres' | 'd1', table: string, item: string) => out.push({ aspect, engine, table, item, reason: '' })
  for (const t of pg.tables) if (!d1.tables.includes(t)) add('table', 'postgres', t, t)
  for (const t of d1.tables) if (!pg.tables.includes(t)) add('table', 'd1', t, t)
  const keys: Array<[Aspect, (s: TableShape) => string[]]> = [
    ['primaryKey', (s) => s.primaryKey],
    ['foreignKey', (s) => s.foreignKeys],
    ['uniqueKey', (s) => s.uniqueKeys],
    ['index', (s) => s.indexes],
    ['namedCheck', (s) => s.namedChecks],
  ]
  for (const t of pg.tables.filter((x) => d1.tables.includes(x))) {
    const a = pg.byTable[t]
    const b = d1.byTable[t]
    if (!a || !b) continue
    for (const [aspect, pick] of keys) {
      const left = pick(a)
      const right = pick(b)
      for (const item of left) if (!right.includes(item)) add(aspect, 'postgres', t, item)
      for (const item of right) if (!left.includes(item)) add(aspect, 'd1', t, item)
    }
  }
  return out.sort((x, y) => ASPECT_ORDER.indexOf(x.aspect) - ASPECT_ORDER.indexOf(y.aspect) || byText(x.table, y.table) || byText(x.item, y.item))
}

const emptyTable = (): TableShape => ({ primaryKey: [], foreignKeys: [], uniqueKeys: [], indexes: [], namedChecks: [] })
const finish = (s: TableShape): TableShape => ({
  primaryKey: s.primaryKey,
  foreignKeys: [...s.foreignKeys].sort(byText),
  uniqueKeys: [...s.uniqueKeys].sort(byText),
  indexes: [...s.indexes].sort(byText),
  namedChecks: [...s.namedChecks].sort(byText),
})
const pkItem = (cols: string[]) => `(${cols.join(', ')})`
const PG_ON_DELETE: Record<string, string> = { a: 'no action', r: 'restrict', c: 'cascade', n: 'set null', d: 'set default' }

/** Postgres: the `public` base tables (migration bookkeeping excluded) and, for `tables`, their constraints and indexes. */
export async function postgresShape(owner: Kysely<any>, tables: readonly string[]): Promise<SchemaShape> {
  const all = await sql<{ table_name: string }>`select table_name from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE' and table_name not like 'kysely\\_migration%' order by table_name`.execute(owner)
  const names = all.rows.map((r) => r.table_name)
  const constraints = await sql<{ conname: string; contype: string; tbl: string; cols: string[]; reftbl: string | null; refcols: string[] | null; confdeltype: string }>`
    select c.conname, c.contype, t.relname as tbl, c.confdeltype,
      (select array_agg(a.attname::text order by k.ord) from unnest(c.conkey) with ordinality as k(attnum, ord) join pg_attribute a on a.attrelid = c.conrelid and a.attnum = k.attnum) as cols,
      rt.relname as reftbl,
      (select array_agg(a.attname::text order by k.ord) from unnest(c.confkey) with ordinality as k(attnum, ord) join pg_attribute a on a.attrelid = c.confrelid and a.attnum = k.attnum) as refcols
    from pg_constraint c
    join pg_class t on t.oid = c.conrelid
    join pg_namespace n on n.oid = t.relnamespace and n.nspname = 'public'
    left join pg_class rt on rt.oid = c.confrelid
    where c.contype in ('p', 'f', 'u', 'c')`.execute(owner)
  const indexes = await sql<{ idxname: string; tbl: string; isunique: boolean; backs_constraint: boolean; cols: string[]; predicate: string | null }>`
    select ic.relname as idxname, t.relname as tbl, i.indisunique as isunique,
      exists (select 1 from pg_constraint c where c.conindid = i.indexrelid) as backs_constraint,
      (select array_agg(a.attname::text order by k.ord) from unnest(string_to_array(i.indkey::text, ' ')::int2[]) with ordinality as k(attnum, ord) join pg_attribute a on a.attrelid = i.indrelid and a.attnum = k.attnum where k.ord <= i.indnkeyatts) as cols,
      pg_get_expr(i.indpred, i.indrelid) as predicate
    from pg_index i
    join pg_class ic on ic.oid = i.indexrelid
    join pg_class t on t.oid = i.indrelid
    join pg_namespace n on n.oid = t.relnamespace and n.nspname = 'public'
    where not i.indisprimary`.execute(owner)
  const byTable: Record<string, TableShape> = {}
  for (const t of tables) {
    const s = emptyTable()
    for (const c of constraints.rows.filter((r) => r.tbl === t)) {
      if (c.contype === 'p') s.primaryKey = c.cols
      else if (c.contype === 'f') s.foreignKeys.push(fkItem(c.cols, c.reftbl!, c.refcols!, PG_ON_DELETE[c.confdeltype] ?? c.confdeltype))
      else if (c.contype === 'u') s.uniqueKeys.push(uniqueItem(c.cols, null))
      else if (c.contype === 'c') s.namedChecks.push(c.conname)
    }
    for (const i of indexes.rows.filter((r) => r.tbl === t && !r.backs_constraint)) {
      if (i.isunique) s.uniqueKeys.push(uniqueItem(i.cols, i.predicate))
      else s.indexes.push(indexItem(i.idxname, i.cols, i.predicate))
    }
    byTable[t] = finish(s)
  }
  return { tables: names, byTable }
}

/** D1 (SQLite): the same, through the pragmas and `sqlite_schema`. */
export async function d1Shape(d1: D1Like, tables: readonly string[]): Promise<SchemaShape> {
  const rows = async (query: string, ...binds: unknown[]) => ((await d1.prepare(query).bind(...binds).all()).results ?? []) as Array<Record<string, any>>
  const all = await rows("select name from sqlite_schema where type = 'table' and name not glob 'sqlite_*' and name not glob '_cf_*' and name <> 'd1_migrations' order by name")
  const names = all.map((r) => r.name as string)
  const byTable: Record<string, TableShape> = {}
  for (const t of tables) {
    if (!names.includes(t)) continue
    const s = emptyTable()
    s.primaryKey = (await rows('select name from pragma_table_info(?) where pk > 0 order by pk', t)).map((r) => r.name)
    const fks = await rows('select id, seq, "table" as ref, "from" as col, "to" as refcol, on_delete from pragma_foreign_key_list(?) order by id, seq', t)
    for (const id of new Set(fks.map((r) => r.id))) {
      const parts = fks.filter((r) => r.id === id)
      s.foreignKeys.push(fkItem(parts.map((p) => p.col), parts[0]!.ref, parts.map((p) => p.refcol), parts[0]!.on_delete))
    }
    const sqlOf = new Map((await rows("select name, sql from sqlite_schema where tbl_name = ?", t)).map((r) => [r.name as string, (r.sql ?? '') as string]))
    for (const ix of await rows('select name, "unique" as is_unique, origin from pragma_index_list(?)', t)) {
      if (ix.origin === 'pk') continue
      const cols = (await rows('select name from pragma_index_info(?) order by seqno', ix.name)).map((r) => r.name as string)
      if (ix.origin === 'u') {
        s.uniqueKeys.push(uniqueItem(cols, null))
        continue
      }
      const predicate = /\bWHERE\b([\s\S]*)$/i.exec(sqlOf.get(ix.name) ?? '')?.[1] ?? null
      if (ix.is_unique) s.uniqueKeys.push(uniqueItem(cols, predicate))
      else s.indexes.push(indexItem(ix.name, cols, predicate))
    }
    s.namedChecks = d1CheckNames(sqlOf.get(t) ?? '')
    byTable[t] = finish(s)
  }
  return { tables: names, byTable }
}

/** What is deliberately not compared, and why (printed into RESULT.md and the README's profile). */
export const NOT_COMPARED: readonly { what: string; why: string }[] = [
  { what: 'column types (citext vs lower-case ASCII text, uuid vs checked text, timestamptz vs strftime text, boolean vs 0/1, jsonb vs json_valid text, text[] vs JSON array, bigint/integer vs INTEGER)', why: 'bound by the parity tests and COLUMN_KINDS' },
  { what: 'row-level security', why: 'Postgres only; asserted by packages/db schema-invariants' },
  { what: "D1's unnamed representation CHECKs (UUID text shape, strftime timestamps, 0/1 booleans, json_valid)", why: 'they are the D1 spelling of Postgres column types' },
  { what: 'append-only enforcement (Postgres grants vs D1 BEFORE UPDATE triggers)', why: 'the audit reads neither grants nor triggers (CORE25 P15); asserted by migration-008, schema-invariants and the D1 schema test' },
]

/** Every expected difference between the engines. Exact in both directions: an unlisted one fails, and so does a stale entry. */
export const ENGINE_DIFFERENCES: readonly EngineDifference[] = [
  { aspect: 'table', engine: 'd1', table: 'deployment', item: 'deployment', reason: 'the D1 deployment marker: one organisation per database (CORE35 D18)' },
  { aspect: 'table', engine: 'd1', table: 'unit_assertion', item: 'unit_assertion', reason: 'D1 commit-time assertion machinery (CORE36 D4); Postgres asserts inside its transaction' },
  { aspect: 'foreignKey', engine: 'd1', table: 'organizations', item: '(id) -> deployment(organization_id) on delete no action', reason: 'the marker fixes the one organisation (CORE35 D18)' },
  { aspect: 'namedCheck', engine: 'postgres', table: 'organizations', item: 'organizations_auth_pair', reason: 'unnamed inline CHECK on D1 (CORE47 P2)', d1Fragment: 'CHECK ((auth_provider IS NULL) = (auth_org_id IS NULL))' },
  { aspect: 'namedCheck', engine: 'postgres', table: 'principals', item: 'principals_kind_check', reason: 'Postgres auto-name; unnamed inline CHECK on D1 (CORE47 P2)', d1Fragment: "CHECK (kind IN ('user', 'agent', 'system'))" },
  { aspect: 'namedCheck', engine: 'postgres', table: 'users', item: 'users_auth_pair', reason: 'unnamed inline CHECK on D1 (CORE47 P2)', d1Fragment: 'CHECK ((auth_provider IS NULL) = (auth_subject IS NULL))' },
  { aspect: 'namedCheck', engine: 'postgres', table: 'users', item: 'users_email_ascii_lower', reason: 'unnamed inline CHECK on D1 (CORE47 P2)', d1Fragment: "CHECK (email = lower(email) AND email NOT GLOB '*[^ -~]*')" },
  { aspect: 'namedCheck', engine: 'postgres', table: 'memberships', item: 'memberships_role_check', reason: 'Postgres auto-name; unnamed inline CHECK on D1 (CORE47 P2)', d1Fragment: "CHECK (role IN ('owner', 'member'))" },
  { aspect: 'namedCheck', engine: 'postgres', table: 'tasks', item: 'tasks_status_check', reason: 'Postgres auto-name; unnamed inline CHECK on D1 (CORE47 P2)', d1Fragment: "CHECK (status IN ('open', 'done'))" },
]
