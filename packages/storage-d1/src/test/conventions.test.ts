import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { D1Like } from '../binding.js'
import {
  canonicalId,
  canonicalLength,
  canonicalTimestamp,
  checkConventions,
  type ConventionExemption,
  openLocalD1,
  readCatalogue,
  type LocalD1,
} from './index.js'

// The checker is proven rule by rule on small real tables in a local D1 (so the catalogue rows are SQLite's, not hand-built):
// one violating table per case, expecting exactly the rules and objects named ([[CORE679]] D1).

let local: LocalD1
let d1: D1Like
beforeAll(async () => {
  local = await openLocalD1(['CONV'], { migrate: false })
  d1 = local.bindings.CONV!
})
afterAll(() => local.dispose())

const id = (t: string, c: string) => `CONSTRAINT ${t}_${c}_uuid CHECK (${canonicalId(c)})`
const ts = (t: string, c: string, nullable = false) =>
  `CONSTRAINT ${t}_${c}_timestamp CHECK (${canonicalTimestamp(c, nullable)})`
/** A clean table `t` with an id, an organisation id (no key: the case has no `organizations`) and a timestamp; `extra` adds columns or constraints. */
const base = (t: string, extra = '') =>
  `CREATE TABLE ${t} (
  id TEXT PRIMARY KEY NOT NULL ${id(t, 'id')},
  organization_id TEXT NOT NULL ${id(t, 'organization_id')},
  created_at TEXT NOT NULL ${ts(t, 'created_at')}${extra ? `,\n  ${extra}` : ''}
) STRICT`

const providerId: ConventionExemption = { database: 'crm', table: 't', column: 'ext_id', reason: 'a provider id' }

type Case = { name: string; sql: string[]; drop: string[]; expect: string[]; exemptions?: ConventionExemption[] }

const cases: Case[] = [
  { name: 'a clean table', sql: [base('t')], drop: ['t'], expect: [] },
  // C1 id_check
  {
    name: 'C1 no check',
    sql: [
      `CREATE TABLE t (id TEXT PRIMARY KEY NOT NULL, organization_id TEXT NOT NULL ${id('t', 'organization_id')}) STRICT`,
    ],
    drop: ['t'],
    expect: ['id_check t.id'],
  },
  {
    name: 'C1 check plus key',
    sql: [base('p'), base('t', `parent_id TEXT NOT NULL REFERENCES p (id) ${id('t', 'parent_id')}`)],
    drop: ['t', 'p'],
    expect: ['id_check t.parent_id'],
  },
  {
    name: 'C1 key onto an unchecked column',
    sql: [`CREATE TABLE p (id TEXT PRIMARY KEY NOT NULL) STRICT`, base('t', 'p_id TEXT NOT NULL REFERENCES p (id)')],
    drop: ['t', 'p'],
    expect: ['id_check p.id', 'id_check t.p_id'],
  },
  {
    name: 'C1 short-form check',
    sql: [
      `CREATE TABLE t (id TEXT PRIMARY KEY NOT NULL CONSTRAINT t_id_uuid CHECK (length(id) = 36 AND id NOT GLOB '*[^0-9a-f-]*'), organization_id TEXT NOT NULL ${id('t', 'organization_id')}) STRICT`,
    ],
    drop: ['t'],
    expect: ['id_check t.id', 'check_named t_id_uuid'],
  },
  {
    name: 'C1 wrong text under a _uuid name',
    sql: [
      `CREATE TABLE t (id TEXT PRIMARY KEY NOT NULL CONSTRAINT t_id_uuid CHECK (length(id) = 36 AND id <> ''), organization_id TEXT NOT NULL ${id('t', 'organization_id')}) STRICT`,
    ],
    drop: ['t'],
    expect: ['id_check t.id', 'check_named t_id_uuid'],
  },
  {
    name: 'C1 nullable column with the non-nullable form',
    sql: [base('t', `ref_id TEXT ${id('t', 'ref_id')}`)],
    drop: ['t'],
    expect: ['id_check t.ref_id', 'check_named t_ref_id_uuid'],
  },
  {
    name: 'C1 nullable canonical form is clean',
    sql: [base('t', `ref_id TEXT CONSTRAINT t_ref_id_uuid CHECK (${canonicalId('ref_id', true)})`)],
    drop: ['t'],
    expect: [],
  },
  {
    name: 'C1 a key onto a key onto a checked column is clean',
    sql: [
      base('p'),
      base('q', 'p_id TEXT NOT NULL REFERENCES p (id)'),
      base('t', 'q_id TEXT NOT NULL REFERENCES q (id)'),
    ],
    drop: ['t', 'q', 'p'],
    expect: [],
  },
  // C2 timestamp_check
  { name: 'C2 missing', sql: [base('t', 'made_at TEXT NOT NULL')], drop: ['t'], expect: ['timestamp_check t.made_at'] },
  {
    name: 'C2 wrong name',
    sql: [base('t', `made_at TEXT NOT NULL CONSTRAINT t_made_at_ts CHECK (${canonicalTimestamp('made_at')})`)],
    drop: ['t'],
    expect: ['timestamp_check t.made_at'],
  },
  {
    name: 'C2 non-TEXT',
    sql: [base('t', `made_at INTEGER NOT NULL ${ts('t', 'made_at')}`)],
    drop: ['t'],
    expect: ['timestamp_check t.made_at'],
  },
  {
    name: 'C2 nullable column with the non-nullable form',
    sql: [base('t', `made_at TEXT ${ts('t', 'made_at')}`)],
    drop: ['t'],
    expect: ['timestamp_check t.made_at', 'check_named t_made_at_timestamp'],
  },
  {
    name: 'C2 a _until column is a timestamp too',
    sql: [base('t', 'lease_until TEXT')],
    drop: ['t'],
    expect: ['timestamp_check t.lease_until'],
  },
  // C3 check_named
  {
    name: 'C3 unnamed',
    sql: [base('t', "status TEXT CHECK (status IN ('a', 'b'))")],
    drop: ['t'],
    expect: ['check_named t.status'],
  },
  {
    name: 'C3 name not starting with the table',
    sql: [base('t', "status TEXT CONSTRAINT x_status CHECK (status IN ('a', 'b'))")],
    drop: ['t'],
    expect: ['check_named x_status'],
  },
  {
    name: 'C3 duplicate name',
    sql: [
      base('t', 'a INTEGER CONSTRAINT t_x_k CHECK (a > 0)'),
      base('t_x', 'b INTEGER CONSTRAINT t_x_k CHECK (b > 0)'),
    ],
    drop: ['t_x', 't'],
    expect: ['check_named t_x_k'],
  },
  {
    name: 'C3 _timestamp borrowed for another column',
    sql: [
      base(
        't',
        `updated_at TEXT NOT NULL ${ts('t', 'updated_at')},\n  made_at TEXT NOT NULL CONSTRAINT t_updated_at_timestamp2 CHECK (${canonicalTimestamp('made_at')}),\n  CONSTRAINT t_other_timestamp CHECK (made_at > '')`,
      ),
    ],
    drop: ['t'],
    expect: ['check_named t_other_timestamp', 'timestamp_check t.made_at'],
  },
  {
    name: 'C3 multi-column CHECK on a column',
    sql: [base('t', 'lo INTEGER, hi INTEGER CONSTRAINT t_hi CHECK (hi >= lo)')],
    drop: ['t'],
    expect: ['check_named t_hi'],
  },
  {
    name: 'C3 a multi-column table constraint is clean',
    sql: [base('t', 'lo INTEGER, hi INTEGER, CONSTRAINT t_range CHECK (hi >= lo)')],
    drop: ['t'],
    expect: [],
  },
  {
    name: 'C3 _length with a canonical shape is clean (both forms)',
    sql: [
      base(
        't',
        `name TEXT NOT NULL CONSTRAINT t_name_length CHECK (${canonicalLength('name', 500, 1)}), note TEXT CONSTRAINT t_note_length CHECK (${canonicalLength('note', 10000, undefined, true)})`,
      ),
    ],
    drop: ['t'],
    expect: [],
  },
  {
    name: 'C3 _length with another shape',
    sql: [base('t', 'name TEXT NOT NULL CONSTRAINT t_name_length CHECK (length(name) > 0)')],
    drop: ['t'],
    expect: ['check_named t_name_length'],
  },
  // C5 org_id_unique
  {
    name: 'C5 table constraint',
    sql: [base('t', 'UNIQUE (organization_id, id)')],
    drop: ['t'],
    expect: ['org_id_unique t'],
  },
  {
    name: 'C5 non-unique index',
    sql: [base('t'), 'CREATE INDEX idx_t_organization_id_id ON t (organization_id, id)'],
    drop: ['t'],
    expect: ['org_id_unique idx_t_organization_id_id'],
  },
  {
    name: 'C5 other name',
    sql: [base('t'), 'CREATE UNIQUE INDEX idx_t_org ON t (organization_id, id)'],
    drop: ['t'],
    expect: ['org_id_unique idx_t_org'],
  },
  {
    name: 'C5 composite key onto a pair with no unique index',
    sql: [
      base('p'),
      base(
        't',
        'p_id TEXT NOT NULL, CONSTRAINT t_p_fk FOREIGN KEY (organization_id, p_id) REFERENCES p (organization_id, id)',
      ),
    ],
    drop: ['t', 'p'],
    expect: ['org_id_unique t.organization_id+p_id'],
  },
  {
    name: 'C5 the canonical unique index backs a composite key (clean)',
    sql: [
      base('p'),
      'CREATE UNIQUE INDEX idx_p_organization_id_id ON p (organization_id, id)',
      base(
        't',
        'p_id TEXT NOT NULL, CONSTRAINT t_p_fk FOREIGN KEY (organization_id, p_id) REFERENCES p (organization_id, id)',
      ),
    ],
    drop: ['t', 'p'],
    expect: [],
  },
  // C6 index_named
  {
    name: 'C6',
    sql: [base('t'), 'CREATE INDEX ix_t_org ON t (organization_id)'],
    drop: ['t'],
    expect: ['index_named ix_t_org'],
  },
  // C7 strict
  {
    name: 'C7',
    sql: [`CREATE TABLE t (id TEXT PRIMARY KEY NOT NULL ${id('t', 'id')})`],
    drop: ['t'],
    expect: ['strict t'],
  },
  // C8 keyword_case
  {
    name: 'C8 a lower-case keyword',
    sql: [base('t', 'a TEXT'), 'CREATE INDEX idx_t_a ON t (a) where a is not null'],
    drop: ['t'],
    expect: ['keyword_case idx_t_a'],
  },
  {
    name: 'C8 a lower-case word inside a string literal and a quoted identifier is not reported',
    sql: [
      base('t', `"before" TEXT, status TEXT CONSTRAINT t_status CHECK (status IN ('not null and or', 'create table'))`),
    ],
    drop: ['t'],
    expect: [],
  },
  // D3 exclusions
  {
    name: 'D3 an auth_ table is outside the rules',
    sql: ['CREATE TABLE auth_user (id text primary key not null, "createdAt" date not null)'],
    drop: ['auth_user'],
    expect: [],
  },
  {
    name: 'D3 an FTS5 table with its shadow tables is outside the rules',
    sql: [
      base('t', 'title TEXT'),
      "CREATE VIRTUAL TABLE t_search USING fts5(id UNINDEXED, title, tokenize = 'trigram')",
    ],
    drop: ['t_search', 't'],
    expect: [],
  },
  // D11 exemptions
  {
    name: 'an exempted column is not reported',
    sql: [base('t', 'ext_id TEXT NOT NULL, seen_at TEXT NOT NULL')],
    drop: ['t'],
    exemptions: [providerId, { database: 'crm', table: 't', column: 'seen_at', reason: 'a provider time' }],
    expect: [],
  },
  {
    name: 'an unexempted provider id is reported',
    sql: [base('t', 'ext_id TEXT NOT NULL')],
    drop: ['t'],
    exemptions: [],
    expect: ['id_check t.ext_id'],
  },
  {
    name: 'exemption_stale: a column that does not exist',
    sql: [base('t')],
    drop: ['t'],
    exemptions: [{ database: 'crm', table: 't', column: 'nope', reason: 'gone' }],
    expect: ['exemption_stale t.nope'],
  },
  {
    name: 'exemption_stale: a table that does not exist',
    sql: [base('t')],
    drop: ['t'],
    exemptions: [{ database: 'crm', table: 'gone', column: 'x_id', reason: 'gone' }],
    expect: ['exemption_stale gone.x_id'],
  },
  {
    name: "another database's entry is not stale here",
    sql: [base('t')],
    drop: ['t'],
    exemptions: [{ database: 'control', table: 'gone', column: 'x_id', reason: 'other database' }],
    expect: [],
  },
]

describe('the conventions checker, one violating table per rule', () => {
  it.each(cases)('$name', async (c) => {
    for (const s of c.sql) await d1.prepare(s).run()
    try {
      const problems = checkConventions(await readCatalogue(d1), c.exemptions ?? [], 'crm')
      expect(problems.map((p) => `${p.rule} ${p.object}`).sort()).toEqual([...c.expect].sort())
    } finally {
      for (const t of c.drop) {
        // `t_search` is virtual: its shadow tables go with it.
        await d1.prepare(`DROP TABLE IF EXISTS ${t}`).run()
      }
    }
  })
})
