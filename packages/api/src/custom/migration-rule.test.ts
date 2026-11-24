import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { MIGRATIONS_DIR } from '@vibase/storage-d1/test'

// [[CORE555]] P8, [[CORE315]] D10, D9: the four extensible tables are only ever changed additively by a core migration, and a core migration never names a `__c` identifier. Static: it reads the migration files.
const EXTENSIBLE = ['contacts', 'companies', 'deals', 'tasks']
/** Files a rule flags today, by migration number, with the reason. Empty means every real migration passes. */
const KNOWN: Record<string, string> = {}

const strip = (sql: string) => sql.replace(/\/\*[\s\S]*?\*\//g, '').replace(/--[^\n]*/g, '')
const statements = (sql: string) =>
  strip(sql)
    .split(';')
    .map((s) => s.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
const words = (t: string) => `(?:"${t}"|\\b${t}\\b)`

/** The rules a migration's text breaks, by name. */
export function breaks(sql: string, created: Set<string> = new Set(), cascading: Set<string> = new Set()): string[] {
  const out: string[] = []
  for (const s of statements(sql)) {
    if (/__c\b/.test(s)) out.push(`names a __c identifier: ${s.slice(0, 60)}`)
    for (const t of EXTENSIBLE) {
      const at = new RegExp(words(t), 'i')
      if (new RegExp(`^DROP TABLE (?:IF EXISTS )?(?:\\w+\\.)?${words(t)}`, 'i').test(s)) out.push(`drops ${t}`)
      if (new RegExp(`^ALTER TABLE ${words(t)} RENAME TO`, 'i').test(s)) out.push(`renames ${t}`)
      if (new RegExp(`^ALTER TABLE ${words(t)} RENAME COLUMN`, 'i').test(s)) out.push(`renames a column of ${t}`)
      if (new RegExp(`^ALTER TABLE ${words(t)} DROP COLUMN`, 'i').test(s)) out.push(`drops a column of ${t}`)
      if (new RegExp(`^ALTER TABLE \\S+ RENAME TO ${words(t)}`, 'i').test(s)) out.push(`rebuilds ${t} by rename`)
      if (new RegExp(`^CREATE TABLE (?:IF NOT EXISTS )?${words(t)}`, 'i').test(s)) {
        if (created.has(t)) out.push(`recreates ${t}`)
        created.add(t)
      }
      if (
        new RegExp(`^ALTER TABLE ${words(t)}`, 'i').test(s) &&
        !/^ALTER TABLE \S+ ADD COLUMN /i.test(s) &&
        !/RENAME|DROP COLUMN/i.test(s)
      )
        out.push(`alters ${t} by something other than ADD COLUMN`)
      void at
    }
    // D10's verified note: a table the four reference with ON DELETE CASCADE may not be dropped or renamed (SQLite would cascade or break the key).
    const create = /^CREATE TABLE (?:IF NOT EXISTS )?"?(\w+)"?/i.exec(s)
    if (create && EXTENSIBLE.includes(create[1]!))
      for (const m of s.matchAll(/REFERENCES "?(\w+)"?[^,]*?ON DELETE CASCADE/gi)) cascading.add(m[1]!)
  }
  for (const s of statements(sql))
    for (const t of cascading)
      if (
        new RegExp(`^DROP TABLE (?:IF EXISTS )?${words(t)}`, 'i').test(s) ||
        new RegExp(`^ALTER TABLE ${words(t)} RENAME TO`, 'i').test(s)
      )
        out.push(`drops or renames ${t}, which a built-in references ON DELETE CASCADE`)
  return out
}

const files = readdirSync(MIGRATIONS_DIR)
  .filter((f) => f.endsWith('.sql'))
  .sort()
describe('D10: core migrations leave the extensible tables additive (P8)', () => {
  it('reads the migrations', () => expect(files.length).toBeGreaterThan(20))
  it('every real migration passes, apart from the listed ones', () => {
    const created = new Set<string>()
    const cascading = new Set<string>()
    const found: Record<string, string[]> = {}
    for (const f of files) {
      const b = breaks(readFileSync(join(MIGRATIONS_DIR, f), 'utf8'), created, cascading)
      if (b.length > 0) found[f.slice(0, 4)] = b
    }
    expect(Object.keys(found)).toEqual(Object.keys(KNOWN))
  })
  const scratch: [string, string, string][] = [
    [
      'rebuilds contacts',
      'CREATE TABLE contacts_new (id TEXT); INSERT INTO contacts_new SELECT id FROM contacts; DROP TABLE contacts; ALTER TABLE contacts_new RENAME TO contacts;',
      'drops contacts',
    ],
    ['recreates contacts', 'CREATE TABLE contacts (id TEXT);', 'recreates contacts'],
    ['drops a column of deals', 'ALTER TABLE deals DROP COLUMN currency;', 'drops a column of deals'],
    ['renames a column of tasks', 'ALTER TABLE tasks RENAME COLUMN notes TO body;', 'renames a column of tasks'],
    [
      'drops a table a cascading key of tasks points at',
      'CREATE TABLE tasks (id TEXT, organization_id TEXT REFERENCES organizations (id) ON DELETE CASCADE); DROP TABLE organizations;',
      'drops or renames organizations',
    ],
    ['adds a __c column', 'ALTER TABLE companies ADD COLUMN note__c TEXT;', 'names a __c identifier'],
    ['names a __c table', 'CREATE TABLE projects__c (id TEXT);', 'names a __c identifier'],
    [
      'alters by a constraint',
      'ALTER TABLE deals ADD CONSTRAINT x CHECK (1);',
      'alters deals by something other than ADD COLUMN',
    ],
  ]
  for (const [name, sql, rule] of scratch)
    it(`a scratch migration that ${name} fails with the rule named`, () => {
      expect(breaks(sql, new Set(name === 'recreates contacts' ? ['contacts'] : [])).join('\n')).toContain(rule)
    })
  it('what is allowed passes: ADD COLUMN, CREATE INDEX, DML, and the first CREATE TABLE', () => {
    const sql = `CREATE TABLE contacts (id TEXT); ALTER TABLE contacts ADD COLUMN x TEXT; CREATE UNIQUE INDEX i ON contacts (x); UPDATE contacts SET x = 'a'; INSERT INTO contacts (id) VALUES ('1'); CREATE TABLE other (id TEXT); DROP TABLE other;`
    expect(breaks(sql)).toEqual([])
  })
})
