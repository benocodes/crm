// The schema conventions checker ([[CORE679]] D1): a pure function from catalogue rows (`sqlite_master`, `pragma table_xinfo`,
// `foreign_key_list`, `index_list`, `index_xinfo`) and an exemption list to the problems it finds, each named by the rule it breaks
// (C1 `id_check`, C2 `timestamp_check`, C3 `check_named`, C5 `org_id_unique`, C6 `index_named`, C7 `strict`, C8 `keyword_case`).
// C4 (a declared limit is a database limit) needs the declarations in `@vibase/api`: it is a test there ([[CORE683]] D6,
// `declarations/length-checks.integration.d1.test.ts`); here C3 holds a `_length` CHECK to the canonical shape whatever its bounds
// ([[CORE679]] plan, row 679.20).
import type { D1Like } from '../binding.js'

export type ConventionRule =
  | 'id_check'
  | 'timestamp_check'
  | 'check_named'
  | 'org_id_unique'
  | 'index_named'
  | 'strict'
  | 'keyword_case'
  | 'exemption_stale'

export interface ConventionProblem {
  readonly rule: ConventionRule
  /** `table`, `table.column`, or an index or trigger name. */
  readonly object: string
  readonly message: string
}

export type ConventionDatabase = 'crm' | 'control'

/** A column whose name looks like an id or a timestamp but is not one. Adding an entry is a visible diff in review. */
export interface ConventionExemption {
  readonly database: ConventionDatabase
  readonly table: string
  readonly column: string
  readonly reason: string
}

export interface CatalogueColumn {
  readonly name: string
  readonly type: string
  readonly notnull: boolean
  /** `pragma table_xinfo` hidden: 0 for an ordinary column. */
  readonly hidden?: number
}
export interface CatalogueForeignKey {
  readonly id: number
  readonly seq: number
  readonly table: string
  readonly from: string
  /** null when the key names the target's primary key implicitly. */
  readonly to: string | null
}
export interface CatalogueIndexInfo {
  readonly name: string
  readonly unique: boolean
  /** `c` (CREATE INDEX), `u` (UNIQUE constraint), `pk`. */
  readonly origin: string
  readonly partial: boolean
  /** Key columns in order (auxiliary columns left out). */
  readonly columns: readonly string[]
}
export interface CatalogueTable {
  readonly name: string
  readonly sql: string
  readonly columns: readonly CatalogueColumn[]
  readonly foreignKeys: readonly CatalogueForeignKey[]
  readonly indexes: readonly CatalogueIndexInfo[]
}
export interface CatalogueObject {
  readonly name: string
  readonly tbl_name: string
  readonly sql: string | null
}
export interface Catalogue {
  readonly tables: readonly CatalogueTable[]
  /** Every `type = 'index'` row, autoindexes (sql null) included. */
  readonly indexes: readonly CatalogueObject[]
  readonly triggers: readonly CatalogueObject[]
}

// ---------------------------------------------------------------------------------------------------------------------
// Canonical expressions

/** The canonical id CHECK expression for column `c` ([[CORE679]] D2); `nullable` gives the `c IS NULL OR (...)` form. */
export function canonicalId(c: string, nullable = false): string {
  const e = `length(${c}) = 36 AND ${c} NOT GLOB '*[^0-9a-f-]*' AND substr(${c}, 9, 1) = '-' AND substr(${c}, 14, 1) = '-' AND substr(${c}, 19, 1) = '-' AND substr(${c}, 24, 1) = '-'`
  return nullable ? `${c} IS NULL OR (${e})` : e
}
/** The canonical timestamp CHECK expression for column `c` (C2). */
export function canonicalTimestamp(c: string, nullable = false): string {
  const e = `coalesce(strftime('%Y-%m-%dT%H:%M:%fZ', ${c}) = ${c}, 0)`
  return nullable ? `${c} IS NULL OR (${e})` : e
}
/** A canonical `_length` CHECK expression for column `c` over `[min, max]` (or `<= max` when `min` is undefined). */
export function canonicalLength(c: string, max: number, min?: number, nullable = false): string {
  const e = min === undefined ? `length(${c}) <= ${max}` : `length(${c}) BETWEEN ${min} AND ${max}`
  return nullable ? `${c} IS NULL OR (${e})` : e
}

// ---------------------------------------------------------------------------------------------------------------------
// A small SQL scanner: enough to skip string literals, quoted identifiers and comments

type Tok = {
  readonly kind: 'word' | 'str' | 'qid' | 'punct' | 'num'
  readonly text: string
  readonly start: number
  readonly end: number
}

function scan(sql: string): Tok[] {
  const out: Tok[] = []
  let i = 0
  while (i < sql.length) {
    const ch = sql[i]!
    if (/\s/.test(ch)) {
      i++
    } else if (ch === '-' && sql[i + 1] === '-') {
      while (i < sql.length && sql[i] !== '\n') i++
    } else if (ch === '/' && sql[i + 1] === '*') {
      const e = sql.indexOf('*/', i + 2)
      i = e < 0 ? sql.length : e + 2
    } else if (ch === "'" || ch === '"' || ch === '`') {
      const q = ch
      let j = i + 1
      while (j < sql.length) {
        if (sql[j] === q) {
          if (sql[j + 1] === q) j += 2
          else break
        } else j++
      }
      out.push({ kind: q === "'" ? 'str' : 'qid', text: sql.slice(i, j + 1), start: i, end: j + 1 })
      i = j + 1
    } else if (ch === '[') {
      const e = sql.indexOf(']', i)
      const j = e < 0 ? sql.length : e + 1
      out.push({ kind: 'qid', text: sql.slice(i, j), start: i, end: j })
      i = j
    } else if (/[A-Za-z_]/.test(ch)) {
      let j = i + 1
      while (j < sql.length && /[A-Za-z0-9_$]/.test(sql[j]!)) j++
      out.push({ kind: 'word', text: sql.slice(i, j), start: i, end: j })
      i = j
    } else if (/[0-9]/.test(ch)) {
      let j = i + 1
      while (j < sql.length && /[0-9.]/.test(sql[j]!)) j++
      out.push({ kind: 'num', text: sql.slice(i, j), start: i, end: j })
      i = j
    } else {
      out.push({ kind: 'punct', text: ch, start: i, end: i + 1 })
      i++
    }
  }
  return out
}

/** Whitespace collapsed and identifier quotes removed; nothing else is normalised (C3's comparison). */
export function normaliseExpr(text: string): string {
  return text.replace(/"/g, '').replace(/\s+/g, ' ').trim()
}

function unquote(t: Tok): string {
  return t.kind === 'qid' ? t.text.slice(1, -1) : t.text
}

interface ParsedCheck {
  /** The constraint name, or null when unnamed. */
  readonly name: string | null
  /** The expression between the parentheses, normalised. */
  readonly expr: string
  /** The column definition the CHECK sits in, or null for a table constraint. */
  readonly column: string | null
  /** Bare words in the expression that are other columns of the table (for a column-level CHECK). */
  readonly otherColumns: readonly string[]
}

/** The CHECK clauses of one CREATE TABLE, each with its owner (a column definition or the table). */
export function parseChecks(sql: string, columnNames: readonly string[]): ParsedCheck[] {
  const toks = scan(sql)
  const open = toks.findIndex((t) => t.kind === 'punct' && t.text === '(')
  if (open < 0) return []
  // Split the table body into top-level items.
  const items: Tok[][] = []
  let depth = 0
  let cur: Tok[] = []
  for (let k = open + 1; k < toks.length; k++) {
    const t = toks[k]!
    if (t.kind === 'punct' && t.text === '(') depth++
    if (t.kind === 'punct' && t.text === ')') {
      if (depth === 0) break
      depth--
    }
    if (depth === 0 && t.kind === 'punct' && t.text === ',') {
      items.push(cur)
      cur = []
    } else cur.push(t)
  }
  if (cur.length > 0) items.push(cur)

  const out: ParsedCheck[] = []
  for (const item of items) {
    const first = item[0]
    if (!first) continue
    const upper = first.kind === 'word' ? first.text.toUpperCase() : ''
    const isConstraint = ['CONSTRAINT', 'PRIMARY', 'UNIQUE', 'CHECK', 'FOREIGN'].includes(upper)
    const column = isConstraint ? null : unquote(first)
    let d = 0
    for (let k = 0; k < item.length; k++) {
      const t = item[k]!
      if (t.kind === 'punct' && t.text === '(') d++
      else if (t.kind === 'punct' && t.text === ')') d--
      else if (d === 0 && t.kind === 'word' && t.text.toUpperCase() === 'CHECK' && item[k + 1]?.text === '(') {
        let name: string | null = null
        if (k >= 2 && item[k - 2]!.kind === 'word' && item[k - 2]!.text.toUpperCase() === 'CONSTRAINT')
          name = unquote(item[k - 1]!)
        let dd = 0
        let end = k + 1
        for (; end < item.length; end++) {
          if (item[end]!.text === '(' && item[end]!.kind === 'punct') dd++
          if (item[end]!.text === ')' && item[end]!.kind === 'punct') {
            dd--
            if (dd === 0) break
          }
        }
        const inner = item.slice(k + 2, end)
        const expr = normaliseExpr(sql.slice(item[k + 1]!.end, item[end]?.start ?? sql.length))
        const refs = new Set<string>()
        if (column !== null) {
          for (let m = 0; m < inner.length; m++) {
            const w = inner[m]!
            if (w.kind !== 'word' && w.kind !== 'qid') continue
            if (inner[m + 1]?.text === '(' && w.kind === 'word') continue // a function call
            const id = unquote(w)
            if (id !== column && columnNames.includes(id)) refs.add(id)
          }
        }
        out.push({ name, expr, column, otherColumns: [...refs] })
        k = end
      }
    }
  }
  return out
}

// ---------------------------------------------------------------------------------------------------------------------
// The checker

const KEYWORDS = new Set(
  `ABORT ADD AFTER ALTER AND AS ASC AUTOINCREMENT BEFORE BEGIN BETWEEN BLOB CASCADE CASE CHECK COLLATE CONSTRAINT CREATE DEFAULT DELETE DESC
   DROP ELSE END EXISTS FOREIGN FROM GLOB IF IN INDEX INSERT INTEGER INTO IS KEY LIKE NOT NULL OF ON OR PRIMARY RAISE REAL REFERENCES SELECT
   SET STRICT TABLE TEXT THEN TRIGGER UNIQUE UPDATE VALUES WHEN WHERE`
    .split(/\s+/)
    .filter(Boolean),
)

const EXCLUDED_PREFIXES = ['auth_', '_cf_', 'sqlite_']

function isVirtual(sql: string): boolean {
  return /^\s*CREATE\s+VIRTUAL\s+TABLE/i.test(sql)
}

export function checkConventions(
  catalogue: Catalogue,
  exemptions: readonly ConventionExemption[],
  database: ConventionDatabase,
): ConventionProblem[] {
  const problems: ConventionProblem[] = []
  const add = (rule: ConventionRule, object: string, message: string) => problems.push({ rule, object, message })

  // D3: what is outside the rules.
  const virtualNames = catalogue.tables.filter((t) => isVirtual(t.sql)).map((t) => t.name)
  const excluded = (name: string): boolean =>
    name === 'd1_migrations' ||
    EXCLUDED_PREFIXES.some((p) => name.startsWith(p)) ||
    virtualNames.some((v) => name === v || name.startsWith(`${v}_`))
  const tables = catalogue.tables.filter((t) => !excluded(t.name))
  const byName = new Map(tables.map((t) => [t.name, t]))

  const mine = exemptions.filter((e) => e.database === database)
  for (const e of mine) {
    const t = catalogue.tables.find((x) => x.name === e.table)
    if (!t?.columns.some((c) => c.name === e.column))
      add(
        'exemption_stale',
        `${e.table}.${e.column}`,
        `the exemption names a ${t ? 'column' : 'table'} that does not exist in the ${database} database`,
      )
  }
  const exempt = (table: string, column: string) => mine.some((e) => e.table === table && e.column === column)

  const checksOf = new Map(
    tables.map((t) => [
      t.name,
      parseChecks(
        t.sql,
        t.columns.map((c) => c.name),
      ),
    ]),
  )

  // C1 -------------------------------------------------------------------------------------------------------------------
  const isIdName = (c: string) => c === 'id' || c.endsWith('_id') || c.endsWith('_by')
  const satisfied = new Map<string, boolean>()
  // A composite key (organization_id, x) -> (organization_id, y) covers x; its organization_id part is not a key of its own (C1).
  const keysOf = (t: CatalogueTable, col: string) =>
    t.foreignKeys.filter(
      (f) =>
        f.from === col && !(col === 'organization_id' && t.foreignKeys.some((g) => g.id === f.id && g.seq !== f.seq)),
    )
  const hasCanonicalId = (t: CatalogueTable, col: string): boolean => {
    const nullable = !t.columns.find((c) => c.name === col)!.notnull
    return (checksOf.get(t.name) ?? []).some(
      (ck) => ck.name === `${t.name}_${col}_uuid` && ck.expr === normaliseExpr(canonicalId(col, nullable)),
    )
  }
  const idSatisfied = (table: string, col: string, seen: Set<string>): boolean => {
    const key = `${table}.${col}`
    if (satisfied.has(key)) return satisfied.get(key)!
    const t = byName.get(table)
    if (!t?.columns.some((c) => c.name === col) || exempt(table, col) || seen.has(key)) return false
    seen.add(key)
    const keys = keysOf(t, col)
    let ok: boolean
    if (keys.length > 0) {
      ok = keys.every((k) => {
        const target = byName.get(k.table)
        if (!target) return false
        const to = k.to ?? target.columns.find((c) => c.name === 'id')?.name ?? ''
        return idSatisfied(k.table, to, seen)
      })
    } else ok = hasCanonicalId(t, col)
    satisfied.set(key, ok)
    return ok
  }
  const attemptsId = (ck: ParsedCheck, col: string) => ck.expr.includes(`length(${col}) = 36`)
  for (const t of tables) {
    for (const c of t.columns) {
      if (c.hidden || !isIdName(c.name) || exempt(t.name, c.name)) continue
      const obj = `${t.name}.${c.name}`
      const checks = (checksOf.get(t.name) ?? []).filter((ck) => attemptsId(ck, c.name))
      const keys = keysOf(t, c.name)
      if (keys.length > 0) {
        if (checks.length > 0)
          add('id_check', obj, 'a key and an id CHECK on the same column: the key replaces the CHECK (D4)')
        else if (!idSatisfied(t.name, c.name, new Set()))
          add('id_check', obj, 'a foreign key onto a column that is not itself a checked id column')
      } else {
        const nullable = !c.notnull
        if (checks.length === 0)
          add('id_check', obj, 'an id column with neither a foreign key nor the canonical id CHECK')
        else if (checks.length > 1) add('id_check', obj, 'more than one id CHECK')
        else {
          const ck = checks[0]!
          if (ck.expr !== normaliseExpr(canonicalId(c.name, nullable)))
            add('id_check', obj, `the id CHECK is not the canonical text${nullable ? ' (nullable form)' : ''}`)
          else if (ck.name !== `${t.name}_${c.name}_uuid`)
            add('id_check', obj, `the id CHECK is not named ${t.name}_${c.name}_uuid`)
        }
      }
    }
  }

  // C2 -------------------------------------------------------------------------------------------------------------------
  for (const t of tables) {
    for (const c of t.columns) {
      if (c.hidden || !(c.name.endsWith('_at') || c.name.endsWith('_until')) || exempt(t.name, c.name)) continue
      const obj = `${t.name}.${c.name}`
      if (c.type.toUpperCase() !== 'TEXT') add('timestamp_check', obj, `a timestamp column is TEXT, not ${c.type}`)
      const nullable = !c.notnull
      const own = (checksOf.get(t.name) ?? []).filter((ck) =>
        ck.expr.includes(`strftime('%Y-%m-%dT%H:%M:%fZ', ${c.name})`),
      )
      if (own.length === 0) add('timestamp_check', obj, 'a timestamp column without the canonical timestamp CHECK')
      else {
        const ck = own[0]!
        if (ck.expr !== normaliseExpr(canonicalTimestamp(c.name, nullable)))
          add(
            'timestamp_check',
            obj,
            `the timestamp CHECK is not the canonical text${nullable ? ' (nullable form)' : ''}`,
          )
        else if (ck.name !== `${t.name}_${c.name}_timestamp`)
          add('timestamp_check', obj, `the timestamp CHECK is not named ${t.name}_${c.name}_timestamp`)
      }
    }
  }

  // C3 -------------------------------------------------------------------------------------------------------------------
  const seenNames = new Map<string, string>()
  for (const t of tables) {
    for (const ck of checksOf.get(t.name) ?? []) {
      const where = ck.column ? `${t.name}.${ck.column}` : t.name
      if (ck.name === null) {
        add('check_named', where, `an unnamed CHECK: ${ck.expr.slice(0, 60)}`)
        continue
      }
      const obj = ck.name
      if (!ck.name.startsWith(`${t.name}_`)) add('check_named', obj, `a CHECK name starts with ${t.name}_`)
      const prev = seenNames.get(ck.name)
      if (prev !== undefined) add('check_named', obj, `the CHECK name is also used in ${prev}`)
      else seenNames.set(ck.name, t.name)
      if (ck.column !== null && ck.otherColumns.length > 0)
        add(
          'check_named',
          obj,
          `a CHECK over ${[ck.column, ...ck.otherColumns].join(', ')} is a table constraint, not a column constraint`,
        )
      const suffix = (['_uuid', '_timestamp', '_length'] as const).find((s) => ck.name!.endsWith(s))
      if (suffix && ck.name.startsWith(`${t.name}_`)) {
        const col = ck.name.slice(t.name.length + 1, ck.name.length - suffix.length)
        const column = t.columns.find((c) => c.name === col)
        if (!column) {
          add('check_named', obj, `${suffix} names a column that does not exist: ${col}`)
          continue
        }
        const nullable = !column.notnull
        let ok: boolean
        if (suffix === '_uuid') ok = ck.expr === normaliseExpr(canonicalId(col, nullable))
        else if (suffix === '_timestamp') ok = ck.expr === normaliseExpr(canonicalTimestamp(col, nullable))
        else {
          const core = `length\\(${col}\\) (?:BETWEEN \\d+ AND \\d+|<= \\d+)`
          ok = new RegExp(nullable ? `^${col} IS NULL OR \\(${core}\\)$` : `^${core}$`).test(ck.expr)
        }
        if (!ok) add('check_named', obj, `${suffix} is reserved for the canonical ${suffix.slice(1)} CHECK of ${col}`)
      }
    }
  }

  // C5 -------------------------------------------------------------------------------------------------------------------
  const pair = (cols: readonly string[]) => cols.length === 2 && cols[0] === 'organization_id' && cols[1] === 'id'
  for (const t of tables) {
    for (const ix of t.indexes) {
      if (!pair(ix.columns)) continue
      if (ix.origin === 'u')
        add('org_id_unique', t.name, 'UNIQUE (organization_id, id) as a table constraint: use CREATE UNIQUE INDEX')
      else if (ix.origin === 'c') {
        if (!ix.unique) add('org_id_unique', ix.name, 'the (organization_id, id) index is not unique')
        if (ix.name !== `idx_${t.name}_organization_id_id`)
          add('org_id_unique', ix.name, `the (organization_id, id) index is named idx_${t.name}_organization_id_id`)
      }
    }
  }
  for (const t of tables) {
    const groups = new Map<number, CatalogueForeignKey[]>()
    for (const f of t.foreignKeys) groups.set(f.id, [...(groups.get(f.id) ?? []), f])
    for (const [, g] of groups) {
      const to = g.map((f) => f.to)
      if (g.length < 2 || !to.includes('organization_id') || !to.includes('id')) continue
      if (
        !pair(
          g
            .slice()
            .sort((a, b) => a.seq - b.seq)
            .map((f) => f.to ?? '')
            .filter((n) => n === 'organization_id' || n === 'id'),
        )
      )
        continue
      const target = byName.get(g[0]!.table)
      const backed = target?.indexes.some((ix) => ix.origin === 'c' && ix.unique && !ix.partial && pair(ix.columns))
      if (!backed)
        add(
          'org_id_unique',
          `${t.name}.${g.map((f) => f.from).join('+')}`,
          `a key onto ${g[0]!.table} (organization_id, id) with no unique index idx_${g[0]!.table}_organization_id_id`,
        )
    }
  }

  // C6 -------------------------------------------------------------------------------------------------------------------
  for (const ix of catalogue.indexes) {
    if (ix.sql === null || excluded(ix.tbl_name)) continue
    if (!ix.name.startsWith(`idx_${ix.tbl_name}_`))
      add('index_named', ix.name, `an index on ${ix.tbl_name} is named idx_${ix.tbl_name}_<what>`)
  }

  // C7 -------------------------------------------------------------------------------------------------------------------
  for (const t of tables) {
    if (!/\)\s*STRICT\s*;?\s*$/.test(t.sql.replace(/--[^\n]*/g, ''))) add('strict', t.name, 'the table is not STRICT')
  }

  // C8 -------------------------------------------------------------------------------------------------------------------
  const keywordCase = (name: string, sql: string | null) => {
    if (!sql) return
    const bad = new Set<string>()
    for (const t of scan(sql))
      if (t.kind === 'word' && KEYWORDS.has(t.text.toUpperCase()) && t.text !== t.text.toUpperCase()) bad.add(t.text)
    if (bad.size > 0) add('keyword_case', name, `keywords not in upper case: ${[...bad].join(', ')}`)
  }
  for (const t of tables) keywordCase(t.name, t.sql)
  for (const ix of catalogue.indexes) if (!excluded(ix.tbl_name)) keywordCase(ix.name, ix.sql)
  for (const tr of catalogue.triggers) if (!excluded(tr.tbl_name)) keywordCase(tr.name, tr.sql)

  return problems
}

// ---------------------------------------------------------------------------------------------------------------------
// Reading the live catalogue

async function rows<T>(d1: D1Like, sql: string): Promise<T[]> {
  return ((await d1.prepare(sql).all()).results ?? []) as T[]
}

/** Reads the catalogue of a live D1 database. */
export async function readCatalogue(d1: D1Like): Promise<Catalogue> {
  const master = (
    await rows<{ type: string; name: string; tbl_name: string; sql: string | null }>(
      d1,
      'SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY rowid',
    )
  ).filter((r) => !r.tbl_name.startsWith('_cf_') && !(r.type === 'table' && r.name.startsWith('sqlite_')))
  const tables: CatalogueTable[] = []
  for (const m of master.filter((r) => r.type === 'table' && r.sql !== null)) {
    const q = `"${m.name.replace(/"/g, '""')}"`
    const cols = await rows<{ name: string; type: string; notnull: number; hidden: number }>(
      d1,
      `PRAGMA table_xinfo(${q})`,
    )
    const fks = await rows<{ id: number; seq: number; table: string; from: string; to: string | null }>(
      d1,
      `PRAGMA foreign_key_list(${q})`,
    )
    const idx = await rows<{ name: string; unique: number; origin: string; partial: number }>(
      d1,
      `PRAGMA index_list(${q})`,
    )
    const indexes: CatalogueIndexInfo[] = []
    for (const i of idx) {
      const info = await rows<{ name: string | null; key: number }>(d1, `PRAGMA index_xinfo("${i.name}")`)
      indexes.push({
        name: i.name,
        unique: i.unique === 1,
        origin: i.origin,
        partial: i.partial === 1,
        columns: info.filter((c) => c.key === 1 && c.name !== null).map((c) => c.name!),
      })
    }
    tables.push({
      name: m.name,
      sql: m.sql!,
      columns: cols.map((c) => ({ name: c.name, type: c.type, notnull: c.notnull === 1, hidden: c.hidden })),
      foreignKeys: fks,
      indexes,
    })
  }
  return {
    tables,
    indexes: master.filter((r) => r.type === 'index').map(({ name, tbl_name, sql }) => ({ name, tbl_name, sql })),
    triggers: master.filter((r) => r.type === 'trigger').map(({ name, tbl_name, sql }) => ({ name, tbl_name, sql })),
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// The exemption list (D11)

/**
 * Columns whose names say id (or a timestamp) but whose values are not minted by Vibase. Each is confirmed against the code
 * that writes it; a column always written as a UUID is checked, not exempted. The control entry is [[CORE683]] D9/D11: `control_audit.actor_id` is
 * always a Vibase principal id (a UUID, and the old short CHECK already refused anything else), so it carries the canonical CHECK, not an exemption.
 */
export const CONVENTION_EXEMPTIONS: readonly ConventionExemption[] = [
  {
    database: 'crm',
    table: 'deployment',
    column: 'auth_org_id',
    reason: "the auth provider's organisation label (a Better Auth id or a Clerk org id)",
  },
  { database: 'crm', table: 'organizations', column: 'auth_org_id', reason: "the auth provider's organisation label" },
  {
    database: 'crm',
    table: 'agents',
    column: 'auth_client_id',
    reason: 'an OAuth client id issued by the auth provider',
  },
  {
    database: 'crm',
    table: 'connections',
    column: 'account_id',
    reason: "the provider's account id (an external account), not minted here",
  },
  {
    database: 'crm',
    table: 'connection_sync_state',
    column: 'run_id',
    reason: 'a Workflow run id supplied by the sync trigger, not a UUID Vibase mints',
  },
  { database: 'crm', table: 'messages', column: 'external_id', reason: "the provider's message id" },
  { database: 'crm', table: 'message_sources', column: 'provider_message_id', reason: "the provider's message id" },
  { database: 'crm', table: 'message_sources', column: 'provider_thread_id', reason: "the provider's thread id" },
  { database: 'crm', table: 'thread_sources', column: 'provider_thread_id', reason: "the provider's thread id" },
  {
    database: 'crm',
    table: 'message_attachments',
    column: 'content_id',
    reason: 'the MIME Content-ID of an inline part',
  },
  {
    database: 'crm',
    table: 'connection_capture_labels',
    column: 'label_id',
    reason: "the provider's label id (Gmail)",
  },
  {
    database: 'crm',
    table: 'forms',
    column: 'public_id',
    reason: 'the public form id `frm_...`, a different shape with its own CHECK',
  },
  {
    database: 'control',
    table: 'control_audit',
    column: 'target_id',
    reason:
      'the audited target: a Vibase id, or a Better Auth user id (user.sessions_revoked, user.reset_link_issued), which is not a UUID',
  },
]
