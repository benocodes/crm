import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import pg from 'pg'

// Migration 008 ([[CORE25]] D41, D44, D45, D54): the messaging model. Ten tables, the capture tables append-only by
// grant, the two link tables soft-deleted, every vocabulary and shape rule a named CHECK, intra-organisation
// composite keys. These tests assert the migrated schema of the test database and never touch another one.

let pool: pg.Pool
beforeAll(() => {
  pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 2 })
})
afterAll(() => pool.end())

const q = async <T = Record<string, any>>(text: string, values: unknown[] = []): Promise<T[]> => (await pool.query(text, values)).rows as T[]

const CAPTURE = ['threads', 'messages', 'interactions', 'files', 'interaction_participants', 'message_attachments', 'message_sources', 'thread_sources']
const LINKS = ['contact_files', 'company_files']
const ALL = [...CAPTURE, ...LINKS]

// [column, udt_name, nullable]
type Col = [string, string, boolean]
const base = (): Col[] => [['id', 'uuid', false], ['organization_id', 'uuid', false], ['created_by', 'uuid', false], ['created_at', 'timestamptz', false]]
const link = (parent: string): Col[] => [
  ...base(), [`${parent}_id`, 'uuid', false], ['file_id', 'uuid', false], ['updated_at', 'timestamptz', false], ['deleted_at', 'timestamptz', true],
]
const COLUMNS: Record<string, Col[]> = {
  threads: [...base(), ['channel', 'text', false], ['subject', 'text', true]],
  messages: [
    ...base(), ['thread_id', 'uuid', false], ['channel', 'text', false], ['kind', 'text', false], ['external_id', 'text', false], ['in_reply_to', 'text', true],
    ['author', 'jsonb', false], ['occurred_at', 'timestamptz', false], ['preview', 'text', false], ['content_key', 'text', true], ['version', 'int4', false],
    ['retracted_at', 'timestamptz', true],
  ],
  interactions: [
    ...base(), ['kind', 'text', false], ['channel', 'text', false], ['direction', 'text', false], ['occurred_at', 'timestamptz', false],
    ['thread_id', 'uuid', true], ['message_id', 'uuid', true],
  ],
  files: [...base(), ['name', 'text', false], ['mime_type', 'text', false], ['size_bytes', 'int8', false], ['sha256', 'text', false], ['storage_key', 'text', false]],
  contact_files: link('contact'),
  company_files: link('company'),
  interaction_participants: [...base(), ['interaction_id', 'uuid', false], ['identity_id', 'uuid', false], ['role', 'text', false]],
  message_attachments: [
    ...base(), ['message_id', 'uuid', false], ['position', 'int4', false], ['file_id', 'uuid', true], ['type', 'text', false], ['name', 'text', true],
    ['mime_type', 'text', true], ['size_bytes', 'int8', true], ['inline', 'bool', false], ['content_id', 'text', true], ['fetch_status', 'text', false],
    ['fetch_metadata', 'jsonb', true], ['fetch_error', 'text', true],
  ],
  message_sources: [...base(), ['message_id', 'uuid', false], ['connection_id', 'uuid', false], ['provider_message_id', 'text', false], ['provider_thread_id', 'text', false]],
  thread_sources: [...base(), ['thread_id', 'uuid', false], ['connection_id', 'uuid', false], ['provider_thread_id', 'text', false]],
}

const CHECKS: Record<string, string[]> = {
  threads: ['threads_channel'],
  messages: ['messages_channel', 'messages_kind', 'messages_content_key', 'messages_preview_length', 'messages_version_positive'],
  interactions: ['interactions_kind', 'interactions_channel', 'interactions_direction', 'interactions_kind_pointers'],
  files: ['files_size_nonnegative', 'files_sha256_hex'],
  contact_files: [],
  company_files: [],
  interaction_participants: ['interaction_participants_role'],
  message_attachments: [
    'message_attachments_type', 'message_attachments_fetch_status', 'message_attachments_stored_file', 'message_attachments_position_nonnegative',
    'message_attachments_size_nonnegative',
  ],
  message_sources: [],
  thread_sources: [],
}

// [constraint name, columns, referenced table, referenced columns]
type Fk = [string, string[], string, string[]]
const tenantFk = (name: string, cols: string[], target: string, targetCols = ['id']): Fk => [name, ['organization_id', ...cols], target, ['organization_id', ...targetCols]]
const FKS: Record<string, Fk[]> = {
  threads: [],
  messages: [tenantFk('messages_thread_fk', ['thread_id'], 'threads')],
  interactions: [
    tenantFk('interactions_thread_fk', ['thread_id'], 'threads'),
    tenantFk('interactions_message_fk', ['message_id', 'thread_id'], 'messages', ['id', 'thread_id']),
  ],
  files: [],
  contact_files: [tenantFk('contact_files_contact_fk', ['contact_id'], 'contacts'), tenantFk('contact_files_file_fk', ['file_id'], 'files')],
  company_files: [tenantFk('company_files_company_fk', ['company_id'], 'companies'), tenantFk('company_files_file_fk', ['file_id'], 'files')],
  interaction_participants: [
    tenantFk('interaction_participants_interaction_fk', ['interaction_id'], 'interactions'),
    tenantFk('interaction_participants_identity_fk', ['identity_id'], 'identities'),
  ],
  message_attachments: [tenantFk('message_attachments_message_fk', ['message_id'], 'messages'), tenantFk('message_attachments_file_fk', ['file_id'], 'files')],
  message_sources: [tenantFk('message_sources_message_fk', ['message_id'], 'messages')],
  thread_sources: [tenantFk('thread_sources_thread_fk', ['thread_id'], 'threads')],
}

// Table-level uniques (names ignored: the audit compares columns only).
const UNIQUES: Record<string, string[][]> = {
  threads: [['organization_id', 'id']],
  messages: [['organization_id', 'id'], ['organization_id', 'id', 'thread_id']],
  interactions: [['organization_id', 'id']],
  files: [['organization_id', 'id']],
  contact_files: [],
  company_files: [],
  interaction_participants: [],
  message_attachments: [],
  message_sources: [],
  thread_sources: [],
}

// [name, unique, columns, partial predicate]
type Idx = [string, boolean, string[], string?]
const INDEXES: Record<string, Idx[]> = {
  threads: [],
  messages: [
    ['idx_messages_external_id_unique', true, ['organization_id', 'channel', 'external_id']],
    ['idx_messages_thread_occurred', false, ['organization_id', 'thread_id', 'occurred_at', 'id']],
    ['idx_messages_occurred', false, ['organization_id', 'occurred_at', 'id']],
  ],
  interactions: [
    ['idx_interactions_message_unique', true, ['organization_id', 'message_id']],
    ['idx_interactions_occurred', false, ['organization_id', 'occurred_at', 'id']],
    ['idx_interactions_thread_occurred', false, ['organization_id', 'thread_id', 'occurred_at']],
  ],
  files: [['idx_files_sha256', false, ['organization_id', 'sha256']]],
  contact_files: [
    ['idx_contact_files_live_unique', true, ['organization_id', 'contact_id', 'file_id'], 'deleted_at IS NULL'],
    ['idx_contact_files_file', false, ['organization_id', 'file_id']],
  ],
  company_files: [
    ['idx_company_files_live_unique', true, ['organization_id', 'company_id', 'file_id'], 'deleted_at IS NULL'],
    ['idx_company_files_file', false, ['organization_id', 'file_id']],
  ],
  interaction_participants: [
    ['idx_interaction_participants_unique', true, ['organization_id', 'interaction_id', 'role', 'identity_id']],
    ['idx_interaction_participants_identity', false, ['organization_id', 'identity_id', 'interaction_id']],
  ],
  message_attachments: [
    ['idx_message_attachments_position_unique', true, ['organization_id', 'message_id', 'position']],
    ['idx_message_attachments_file', false, ['organization_id', 'file_id']],
  ],
  message_sources: [
    ['idx_message_sources_provider_unique', true, ['organization_id', 'connection_id', 'provider_message_id']],
    ['idx_message_sources_message', false, ['organization_id', 'message_id']],
  ],
  thread_sources: [
    ['idx_thread_sources_provider_unique', true, ['organization_id', 'connection_id', 'provider_thread_id']],
    ['idx_thread_sources_thread', false, ['organization_id', 'thread_id']],
  ],
}

describe('migration 008 messaging model: shape', () => {
  it.each(ALL)('%s: columns, types and nullability', async (table) => {
    const rows = await q<{ column_name: string; udt_name: string; is_nullable: string }>(
      `SELECT column_name, udt_name, is_nullable FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1`,
      [table],
    )
    const actual = rows.map((r) => [r.column_name, r.udt_name, r.is_nullable === 'YES'] as Col).sort((a, b) => a[0].localeCompare(b[0]))
    expect(actual).toEqual([...COLUMNS[table]!].sort((a, b) => a[0].localeCompare(b[0])))
  })

  it('no timestamp has a default (the unit clock writes them, CORE36 D2); ids default to uuid v7', async () => {
    const rows = await q<{ table_name: string; column_name: string; column_default: string | null }>(
      `SELECT table_name, column_name, column_default FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = ANY($1) AND column_name IN ('created_at', 'updated_at', 'id')`,
      [ALL],
    )
    expect(rows.filter((r) => r.column_name !== 'id').length).toBe(CAPTURE.length + LINKS.length * 2)
    for (const r of rows) {
      if (r.column_name === 'id') expect(r.column_default, `${r.table_name}.id`).toContain('uuid_generate_v7')
      else expect(r.column_default, `${r.table_name}.${r.column_name}`).toBeNull()
    }
  })

  it.each(ALL)('%s: exactly the named CHECKs', async (table) => {
    const rows = await q<{ conname: string }>(`SELECT conname FROM pg_constraint WHERE conrelid = $1::regclass AND contype = 'c'`, [table])
    expect(rows.map((r) => r.conname).sort()).toEqual([...CHECKS[table]!].sort())
  })

  it.each(ALL)('%s: foreign keys (composite, no action) plus organization and principal', async (table) => {
    const rows = await q<{ conname: string; cols: string[]; ref: string; refcols: string[]; del: string }>(
      `SELECT c.conname,
              ARRAY(SELECT a.attname::text FROM unnest(c.conkey) WITH ORDINALITY k(n, o) JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.n ORDER BY k.o) AS cols,
              c.confrelid::regclass::text AS ref,
              ARRAY(SELECT a.attname::text FROM unnest(c.confkey) WITH ORDINALITY k(n, o) JOIN pg_attribute a ON a.attrelid = c.confrelid AND a.attnum = k.n ORDER BY k.o) AS refcols,
              c.confdeltype AS del
       FROM pg_constraint c WHERE c.conrelid = $1::regclass AND c.contype = 'f'`,
      [table],
    )
    const composite = rows.filter((r) => r.cols.length > 1).map((r) => [r.conname, r.cols, r.ref, r.refcols] as Fk)
    expect(composite.sort((a, b) => a[0].localeCompare(b[0]))).toEqual([...FKS[table]!].sort((a, b) => a[0].localeCompare(b[0])))
    for (const r of rows.filter((r) => r.cols.length > 1)) expect(r.del, r.conname).toBe('a')
    const single = rows.filter((r) => r.cols.length === 1)
    expect(single.map((r) => [r.cols[0], r.ref, r.del]).sort()).toEqual([
      ['created_by', 'principals', 'a'],
      ['organization_id', 'organizations', 'c'],
    ])
  })

  it.each(ALL)('%s: table uniques and indexes', async (table) => {
    const uniques = await q<{ cols: string[] }>(
      `SELECT ARRAY(SELECT a.attname::text FROM unnest(c.conkey) WITH ORDINALITY k(n, o) JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.n ORDER BY k.o) AS cols
       FROM pg_constraint c WHERE c.conrelid = $1::regclass AND c.contype = 'u'`,
      [table],
    )
    expect(uniques.map((u) => u.cols).sort()).toEqual([...UNIQUES[table]!].sort())
    const idx = await q<{ indexname: string; indexdef: string }>(
      `SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = 'public' AND tablename = $1
         AND indexname NOT IN (SELECT conname FROM pg_constraint WHERE conrelid = $1::regclass AND contype IN ('p', 'u'))`,
      [table],
    )
    const actual = idx.map((i) => {
      const cols = /\(([^)]*)\)/.exec(i.indexdef.replace(/^.*USING btree /, ''))![1]!.split(',').map((s) => s.trim().replace(/"/g, ''))
      const where = /WHERE \((.*)\)$/.exec(i.indexdef)?.[1]
      return [i.indexname, i.indexdef.startsWith('CREATE UNIQUE'), cols, ...(where ? [where] : [])] as Idx
    })
    expect(actual.sort((a, b) => a[0].localeCompare(b[0]))).toEqual([...INDEXES[table]!].sort((a, b) => a[0].localeCompare(b[0])))
  })

  it.each(ALL)('%s: row level security enabled, forced, with the tenant policy', async (table) => {
    const [c] = await q<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>(`SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE oid = $1::regclass`, [table])
    expect([c!.relrowsecurity, c!.relforcerowsecurity]).toEqual([true, true])
    const pol = await q<{ policyname: string; cmd: string; roles: string[]; qual: string; with_check: string }>(
      `SELECT policyname, cmd, roles::text[] AS roles, qual, with_check FROM pg_policies WHERE schemaname = 'public' AND tablename = $1`,
      [table],
    )
    expect(pol.map((p) => p.policyname)).toEqual([`${table}_tenant`])
    expect(pol[0]!.cmd).toBe('ALL')
    expect(pol[0]!.roles).toEqual(['vault_authenticated'])
    expect(pol[0]!.qual).toContain('current_organization_id')
    expect(pol[0]!.with_check).toContain('current_organization_id')
  })
})

describe('migration 008 messaging model: grants (D41)', () => {
  it('vault_authenticated: capture tables are exactly INSERT, SELECT', async () => {
    for (const t of CAPTURE) {
      const rows = await q<{ privilege_type: string }>(
        `SELECT privilege_type FROM information_schema.role_table_grants WHERE grantee = 'vault_authenticated' AND table_schema = 'public' AND table_name = $1`,
        [t],
      )
      expect(rows.map((r) => r.privilege_type).sort(), t).toEqual(['INSERT', 'SELECT'])
      for (const col of COLUMNS[t]!.map((c) => c[0])) {
        const [p] = await q<{ p: boolean }>(`SELECT has_column_privilege('vault_authenticated', $1, $2, 'UPDATE') AS p`, [t, col])
        expect(p!.p, `${t}.${col} UPDATE`).toBe(false)
      }
    }
  })

  // Deviation from PLAN/D41 (recorded in RESULT.md): merge re-points contact_files.contact_id (D35), which needs UPDATE on that
  // one column; company_files has no re-point (companies are never merged), so it keeps the narrow grant.
  it('vault_authenticated: links are INSERT, SELECT plus column UPDATE on deleted_at and updated_at (and contact_files.contact_id for merge)', async () => {
    for (const t of LINKS) {
      const rows = await q<{ privilege_type: string }>(
        `SELECT privilege_type FROM information_schema.role_table_grants WHERE grantee = 'vault_authenticated' AND table_schema = 'public' AND table_name = $1`,
        [t],
      )
      // A column-level UPDATE grant shows as table-level UPDATE in role_table_grants only when it covers every column; it must not.
      expect(rows.map((r) => r.privilege_type).sort(), t).toEqual(['INSERT', 'SELECT'])
      for (const col of COLUMNS[t]!.map((c) => c[0])) {
        const [p] = await q<{ p: boolean }>(`SELECT has_column_privilege('vault_authenticated', $1, $2, 'UPDATE') AS p`, [t, col])
        expect(p!.p, `${t}.${col} UPDATE`).toBe(col === 'deleted_at' || col === 'updated_at' || (t === 'contact_files' && col === 'contact_id'))
      }
    }
  })

  it('vault_service: exactly SELECT on all ten; no DELETE or TRUNCATE for anyone', async () => {
    for (const t of ALL) {
      const rows = await q<{ privilege_type: string }>(
        `SELECT privilege_type FROM information_schema.role_table_grants WHERE grantee = 'vault_service' AND table_schema = 'public' AND table_name = $1`,
        [t],
      )
      expect(rows.map((r) => r.privilege_type), t).toEqual(['SELECT'])
    }
    const bad = await q(
      `SELECT grantee, table_name, privilege_type FROM information_schema.role_table_grants
       WHERE table_schema = 'public' AND table_name = ANY($1) AND privilege_type IN ('DELETE', 'TRUNCATE')
         AND grantee IN ('vault_authenticated', 'vault_service', 'vault_app')`,
      [ALL],
    )
    expect(bad).toEqual([])
  })
})

// ---- behaviour, inside a rolled-back transaction as the tenant role ------------------------------------------------

const H64 = 'a'.repeat(64)
type Tx = pg.PoolClient
async function inTenantTx(fn: (c: Tx, ctx: { orgA: string; orgB: string; actor: string }) => Promise<void>): Promise<void> {
  const c = await pool.connect()
  try {
    await c.query('BEGIN')
    await c.query('SET LOCAL ROLE vault_service')
    const orgA = (await c.query(`INSERT INTO organizations (name) VALUES ('a') RETURNING id`)).rows[0].id as string
    const orgB = (await c.query(`INSERT INTO organizations (name) VALUES ('b') RETURNING id`)).rows[0].id as string
    const actor = (await c.query(`INSERT INTO principals (kind) VALUES ('user') RETURNING id`)).rows[0].id as string
    await c.query(`SELECT set_config('app.organization_id', $1, true), set_config('app.principal_id', $2, true)`, [orgA, actor])
    await c.query('SET LOCAL ROLE vault_authenticated')
    await fn(c, { orgA, orgB, actor })
  } finally {
    await c.query('ROLLBACK')
    c.release()
  }
}
const asOrg = (c: Tx, org: string) => c.query(`SELECT set_config('app.organization_id', $1, true)`, [org])
/** Runs `text` in a savepoint and returns the SQLSTATE it failed with, or null. */
async function failure(c: Tx, text: string, values: unknown[] = []): Promise<string | null> {
  await c.query('SAVEPOINT s')
  try {
    await c.query(text, values)
    await c.query('RELEASE SAVEPOINT s')
    return null
  } catch (err) {
    await c.query('ROLLBACK TO SAVEPOINT s')
    return (err as { code?: string }).code ?? 'unknown'
  }
}
const at = '2026-10-28T09:00:00Z'
const insertThread = async (c: Tx, org: string, actor: string, channel = 'email') =>
  (await c.query(`INSERT INTO threads (organization_id, created_by, created_at, channel) VALUES ($1, $2, $3, $4) RETURNING id`, [org, actor, at, channel])).rows[0].id as string
const messageSql = `INSERT INTO messages (organization_id, created_by, created_at, thread_id, channel, kind, external_id, author, occurred_at, preview, content_key, version)
                    VALUES ($1, $2, $3, $4, 'email', $5, $6, '{"user_id":"u"}', $3, $7, $8, 1) RETURNING id`
const insertMessage = async (c: Tx, org: string, actor: string, thread: string, over: { kind?: string; external?: string; preview?: string; contentKey?: string | null } = {}) =>
  (await c.query(messageSql, [org, actor, at, thread, over.kind ?? 'message', over.external ?? 'x@y', over.preview ?? 'hi', over.contentKey === undefined ? 'orgs/x/' : over.contentKey])).rows[0].id as string
const insertFile = async (c: Tx, org: string, actor: string, sha = H64, size = 10) =>
  (await c.query(`INSERT INTO files (organization_id, created_by, created_at, name, mime_type, size_bytes, sha256, storage_key) VALUES ($1, $2, $3, 'f', 'text/plain', $4, $5, 'k') RETURNING id`, [org, actor, at, size, sha])).rows[0].id as string
const insertContact = async (c: Tx, org: string, actor: string) =>
  (await c.query(`INSERT INTO contacts (organization_id, created_by, created_at, updated_at) VALUES ($1, $2, $3, $3) RETURNING id`, [org, actor, at])).rows[0].id as string

describe('migration 008 messaging model: behaviour', () => {
  it('append-only: a tenant UPDATE on a capture table is refused (42501)', async () => {
    await inTenantTx(async (c, { orgA, actor }) => {
      const t = await insertThread(c, orgA, actor)
      const m = await insertMessage(c, orgA, actor, t)
      expect(await failure(c, `UPDATE messages SET preview = 'x' WHERE id = $1`, [m])).toBe('42501')
      expect(await failure(c, `UPDATE threads SET subject = 'x' WHERE id = $1`, [t])).toBe('42501')
      expect(await failure(c, `DELETE FROM messages WHERE id = $1`, [m])).toBe('42501')
    })
  })

  it('D31: an interaction naming a message and another thread is refused (23503)', async () => {
    await inTenantTx(async (c, { orgA, actor }) => {
      const t1 = await insertThread(c, orgA, actor)
      const t2 = await insertThread(c, orgA, actor)
      const m = await insertMessage(c, orgA, actor, t1)
      const sql = `INSERT INTO interactions (organization_id, created_by, created_at, kind, channel, direction, occurred_at, thread_id, message_id) VALUES ($1, $2, $3, 'message', 'email', 'inbound', $3, $4, $5)`
      expect(await failure(c, sql, [orgA, actor, at, t2, m])).toBe('23503')
      expect(await failure(c, sql, [orgA, actor, at, t1, m])).toBeNull()
    })
  })

  it('kind pointers: a message interaction without message_id is refused (23514)', async () => {
    await inTenantTx(async (c, { orgA, actor }) => {
      const t = await insertThread(c, orgA, actor)
      const sql = (kind: string) => `INSERT INTO interactions (organization_id, created_by, created_at, kind, channel, direction, occurred_at, thread_id, message_id) VALUES ($1, $2, $3, '${kind}', 'email', 'inbound', $3, $4, NULL)`
      expect(await failure(c, sql('message'), [orgA, actor, at, t])).toBe('23514')
      expect(await failure(c, sql('reaction'), [orgA, actor, at, t])).toBe('23514')
    })
  })

  it('stored-file rule: stored needs a file, anything else must not have one (23514)', async () => {
    await inTenantTx(async (c, { orgA, actor }) => {
      const t = await insertThread(c, orgA, actor)
      const m = await insertMessage(c, orgA, actor, t)
      const f = await insertFile(c, orgA, actor)
      const sql = `INSERT INTO message_attachments (organization_id, created_by, created_at, message_id, position, file_id, type, inline, fetch_status) VALUES ($1, $2, $3, $4, $5, $6, 'file', false, $7)`
      expect(await failure(c, sql, [orgA, actor, at, m, 0, null, 'stored'])).toBe('23514')
      expect(await failure(c, sql, [orgA, actor, at, m, 1, f, 'failed'])).toBe('23514')
      expect(await failure(c, sql, [orgA, actor, at, m, 2, f, 'stored'])).toBeNull()
      expect(await failure(c, sql, [orgA, actor, at, m, 3, null, 'failed'])).toBeNull()
      expect(await failure(c, sql, [orgA, actor, at, m, 2, f, 'stored'])).toBe('23505') // position is unique per message
    })
  })

  it('sha256, preview length and sizes are checked (23514)', async () => {
    await inTenantTx(async (c, { orgA, actor }) => {
      const t = await insertThread(c, orgA, actor)
      expect(await failure(c, `INSERT INTO files (organization_id, created_by, created_at, name, mime_type, size_bytes, sha256, storage_key) VALUES ($1, $2, $3, 'f', 't', 1, $4, 'k')`, [orgA, actor, at, 'A'.repeat(64)])).toBe('23514')
      expect(await failure(c, `INSERT INTO files (organization_id, created_by, created_at, name, mime_type, size_bytes, sha256, storage_key) VALUES ($1, $2, $3, 'f', 't', 1, $4, 'k')`, [orgA, actor, at, 'a'.repeat(63)])).toBe('23514')
      expect(await failure(c, `INSERT INTO files (organization_id, created_by, created_at, name, mime_type, size_bytes, sha256, storage_key) VALUES ($1, $2, $3, 'f', 't', -1, $4, 'k')`, [orgA, actor, at, H64])).toBe('23514')
      expect(await failure(c, messageSql, [orgA, actor, at, t, 'message', 'long@y', 'p'.repeat(201), 'k'])).toBe('23514')
      expect(await failure(c, messageSql, [orgA, actor, at, t, 'message', 'ok@y', 'p'.repeat(200), 'k'])).toBeNull()
      expect(await failure(c, messageSql, [orgA, actor, at, t, 'message', 'nokey@y', 'p', null])).toBe('23514') // messages_content_key
      expect(await failure(c, messageSql, [orgA, actor, at, t, 'reaction', 'react@y', 'p', null])).toBeNull()
    })
  })

  it('live link uniqueness: a second live link is refused (23505); after a soft delete a new one inserts', async () => {
    await inTenantTx(async (c, { orgA, actor }) => {
      const k = await insertContact(c, orgA, actor)
      const f = await insertFile(c, orgA, actor)
      const sql = `INSERT INTO contact_files (organization_id, created_by, created_at, updated_at, contact_id, file_id) VALUES ($1, $2, $3, $3, $4, $5) RETURNING id`
      const first = (await c.query(sql, [orgA, actor, at, k, f])).rows[0].id as string
      expect(await failure(c, sql, [orgA, actor, at, k, f])).toBe('23505')
      await c.query(`UPDATE contact_files SET deleted_at = $2, updated_at = $2 WHERE id = $1`, [first, at])
      expect(await failure(c, sql, [orgA, actor, at, k, f])).toBeNull()
      expect(await failure(c, `UPDATE contact_files SET file_id = $2 WHERE id = $1`, [first, f])).toBe('42501')
      expect(await failure(c, `UPDATE contact_files SET contact_id = $2, updated_at = $3 WHERE id = $1`, [first, k, at])).toBeNull() // merge's re-point
    })
  })

  it('cross-tenant FK: a link in org A naming a file of org B is refused (23503)', async () => {
    await inTenantTx(async (c, { orgA, orgB, actor }) => {
      const k = await insertContact(c, orgA, actor)
      await asOrg(c, orgB)
      const foreign = await insertFile(c, orgB, actor)
      await asOrg(c, orgA)
      expect(await failure(c, `INSERT INTO contact_files (organization_id, created_by, created_at, updated_at, contact_id, file_id) VALUES ($1, $2, $3, $3, $4, $5)`, [orgA, actor, at, k, foreign])).toBe('23503')
    })
  })

  it('external id is unique per organisation and channel (23505)', async () => {
    await inTenantTx(async (c, { orgA, orgB, actor }) => {
      const t = await insertThread(c, orgA, actor)
      await insertMessage(c, orgA, actor, t, { external: 'x@y' })
      expect(await failure(c, messageSql, [orgA, actor, at, t, 'message', 'x@y', 'p', 'k'])).toBe('23505')
      await asOrg(c, orgB)
      const tb = await insertThread(c, orgB, actor)
      expect(await failure(c, messageSql, [orgB, actor, at, tb, 'message', 'x@y', 'p', 'k'])).toBeNull()
    })
  })

  it('vocabularies are checked (23514)', async () => {
    await inTenantTx(async (c, { orgA, actor }) => {
      expect(await failure(c, `INSERT INTO threads (organization_id, created_by, created_at, channel) VALUES ($1, $2, $3, 'sms')`, [orgA, actor, at])).toBe('23514')
      const t = await insertThread(c, orgA, actor)
      expect(await failure(c, messageSql, [orgA, actor, at, t, 'draft', 'k@y', 'p', 'k'])).toBe('23514')
    })
  })
})
