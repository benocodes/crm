// Test-only. [[CORE565]] (U3b): the guarded fixture of the adversarial contract. One `extend` applied through the production `applySchemaFile` to the four built-ins, each carrying a checked field, a required field with a constant
// default, a unique field and a reference (contacts -> companies; the others -> contacts), plus the check that every guard still holds after a system writer ran.
import type { D1Like } from '@vibase/storage-d1'
import type { FieldDeclaration } from '../custom/declaration.js'
import type { ExtendDeclarations } from '../custom/extend.js'
import { RESOURCES, applyExtend, openExtendedKit, type Resource } from './extension-kit.js'
import type { ActionKit } from './action-kit.js'

/** The default every row a system writer creates must take in the required column. */
export const DEFAULT_LEVEL = 'std'
const shared = {
  flag__c: { kind: 'boolean' }, // CHECK (flag__c IS NULL OR flag__c IN (0, 1))
  lvl__c: { kind: 'text', required: true, default: DEFAULT_LEVEL }, // NOT NULL DEFAULT 'std' and the text length CHECK
  code__c: { kind: 'text', unique: true }, // the partial unique index over live non-null rows
} satisfies Record<string, FieldDeclaration>
/** The reference column of each object and its target table. */
export const REF: Record<Resource, { column: string; target: 'companies' | 'contacts' }> = {
  contacts: { column: 'co__c', target: 'companies' },
  companies: { column: 'ct__c', target: 'contacts' },
  deals: { column: 'ct__c', target: 'contacts' },
  tasks: { column: 'ct__c', target: 'contacts' },
}
const withRef = (r: Resource): Record<string, FieldDeclaration> => ({
  ...shared,
  [REF[r].column]: { kind: 'reference', target: REF[r].target },
})
export const GUARDED: ExtendDeclarations = {
  contacts: withRef('contacts'),
  companies: withRef('companies'),
  deals: withRef('deals'),
  tasks: withRef('tasks'),
}

export const openGuardedKit = (now?: Date): Promise<ActionKit> => openExtendedKit(GUARDED, now)
export const applyGuarded = (d1: D1Like): Promise<void> => applyExtend(d1, GUARDED)

/** `clearD1` cannot order the references an extension adds, so they are nulled before a reset. */
export async function clearReferences(d1: D1Like): Promise<void> {
  for (const r of RESOURCES) await d1.prepare(`update "${r}" set "${REF[r].column}" = null`).run()
}

type Row = Record<string, unknown>
const all = async (d1: D1Like, sql: string, ...binds: unknown[]): Promise<Row[]> =>
  ((
    await d1
      .prepare(sql)
      .bind(...binds)
      .all()
  ).results ?? []) as Row[]

/** Every guard of the fixture holds over the whole database: no dangling foreign key, no two live rows with one code, no NULL in the required column. Returns the violations (empty when satisfied). */
export async function guardViolations(d1: D1Like): Promise<string[]> {
  const out: string[] = []
  const fk = await all(d1, `pragma foreign_key_check`)
  for (const v of fk) out.push(`foreign key: ${JSON.stringify(v)}`)
  for (const r of RESOURCES) {
    for (const d of await all(
      d1,
      `select code__c, count(*) as n from "${r}" where deleted_at is null and code__c is not null group by organization_id, code__c having n > 1`,
    ))
      out.push(`${r}: two live rows hold code ${String(d.code__c)}`)
    const nulls = await all(d1, `select id from "${r}" where lvl__c is null`)
    for (const n of nulls) out.push(`${r}: NULL lvl__c on ${String(n.id)}`)
    for (const b of await all(d1, `select id from "${r}" where flag__c is not null and flag__c not in (0, 1)`))
      out.push(`${r}: flag__c out of range on ${String(b.id)}`)
  }
  return out
}

/** A row a system writer created: the default in the required column, NULL in the unique, reference and checked columns. */
export function expectUntouched(row: Row | undefined, table: Resource): void {
  if (row === undefined) throw new Error(`no ${table} row`)
  const bad = []
  if (row.lvl__c !== DEFAULT_LEVEL) bad.push(`lvl__c=${String(row.lvl__c)}`)
  for (const c of ['code__c', 'flag__c', REF[table].column]) if (row[c] !== null) bad.push(`${c}=${String(row[c])}`)
  if (bad.length > 0) throw new Error(`${table} ${String(row.id)} was not left at the defaults: ${bad.join(', ')}`)
}

export const rowsOf = (d1: D1Like, table: Resource, where = '1 = 1', ...binds: unknown[]): Promise<Row[]> =>
  all(d1, `select * from "${table}" where ${where} order by rowid`, ...binds)

/**
 * [[CORE565]] 565.3: the adversarial contract's covered list. Each non-test module under `packages/api/src` that writes contacts, companies, deals or tasks (found by `custom/adversarial-inventory.test.ts`, by what the module does) maps to the suite(s), relative to `src`, that run it on the
 * guarded fixture. A new writer joins by adding a case there and its row here.
 */
export const COVERED_WRITERS: Record<string, readonly string[]> = {
  'deals/move-stage.ts': ['custom/adversarial-writers.integration.d1.test.ts'],
  'forms/submission.ts': ['custom/adversarial-capture.integration.d1.test.ts'],
  'identity/cascades.ts': ['custom/adversarial-writers.integration.d1.test.ts'],
  'identity/merge.ts': ['custom/adversarial-writers.integration.d1.test.ts'],
  'identity/resolve.ts': [
    'custom/adversarial-writers.integration.d1.test.ts',
    'custom/adversarial-capture.integration.d1.test.ts',
  ],
  // The generic create, update and delete of every resource, on these shapes: [[CORE555]]'s `contract-extended` suite (not repeated here).
  'storage/crud.ts': ['contract-extended.integration.d1.test.ts'],
}
/** Modules whose write names its table through a variable the scan cannot read, and the reason none of them can write a `__c` row of the four tables. */
export const EXCLUDED_DYNAMIC_WRITERS: Record<string, string> = {
  'connections/operations.ts':
    'replaces connection_capture_labels and connection_blocked_senders (a typed two-table union)',
}
