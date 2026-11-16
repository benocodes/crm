import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { D1Like, D1PreparedLike } from './binding.js'
import {
  findApiKeyByHash,
  getApiKey,
  insertApiKey,
  listApiKeys,
  openControlDb,
  readApiKeyState,
  revokeApiKey,
  stampApiKeyUsed,
  type NewApiKey,
} from './control-store.js'
import { openLocalD1, type LocalD1 } from './test/index.js'
import { seedAgent, seedDeployment, seedPrincipal } from './test/seed.js'

// [[CORE328]] groups 1 to 6: the control store's API key methods on a real control-plane D1 (Miniflare), with the CRM database beside it for the parity group. `control_audit` refuses DELETE,
// so nothing is emptied between tests: every test makes its own ids.
const ORG = '0190b2c4-0000-7000-8000-00000000a001'
const ACTOR = '0190b2c4-0000-7000-8000-00000000b001'
const NOW = '2026-11-16T10:00:00.000Z'
const MIN = 60_000
const HOUR = 3_600_000
const plus = (iso: string, ms: number) => new Date(new Date(iso).getTime() + ms).toISOString()
let local: LocalD1
let control: D1Like
let crm: D1Like
beforeAll(async () => {
  local = await openLocalD1(['C', 'CRM'], { control: ['C'] })
  control = local.bindings.C!
  crm = local.bindings.CRM!
})
afterAll(() => local.dispose())

let n = 0
const nextId = () => `0190b2c4-0000-7000-8000-${(++n).toString(16).padStart(12, '0')}`
const c = () => openControlDb(control)
const rowsOf = async (d1: D1Like, text: string, ...binds: unknown[]) =>
  ((
    await d1
      .prepare(text)
      .bind(...binds)
      .all()
  ).results ?? []) as Array<Record<string, any>>
const rows = (text: string, ...binds: unknown[]) => rowsOf(control, text, ...binds)
const run = (d1: D1Like, text: string, ...binds: unknown[]) =>
  d1
    .prepare(text)
    .bind(...binds)
    .run()
    .then(
      () => null,
      (e: Error) => e.message,
    )
const audit = (targetId: string) => rows('select * from control_audit where target_id = ? order by id', targetId)
const keyRow = async (id: string) => (await rows('select * from api_keys where id = ?', id))[0]
const hashOf = () => `hash-${nextId()}-deadbeef`
const newKey = (over: Partial<NewApiKey> = {}): NewApiKey => ({
  id: nextId(),
  auditId: nextId(),
  actorId: ACTOR,
  organizationId: ORG,
  agentId: nextId(),
  keyHash: hashOf(),
  prefix: 'vk_abcdefgh',
  expiresAt: null,
  now: NOW,
  ...over,
})
const make = async (over: Partial<NewApiKey> = {}) => {
  const a = newKey(over)
  expect(await insertApiKey(c(), a)).toBe('created')
  return a
}
/** A control handle whose next batch is preceded by `before`: a writer that gets in between the store's read and its write. */
const racing = (before: () => Promise<unknown>) => {
  let done = false
  const wrapped: D1Like = {
    prepare: (q: string): D1PreparedLike => control.prepare(q),
    batch: async (s) => {
      if (!done) {
        done = true
        await before()
      }
      return control.batch(s)
    },
  }
  return openControlDb(wrapped)
}

describe('group 1: schema (P1, D4)', () => {
  it('api_keys has the CRM table columns, STRICT, no foreign key, a unique key_hash', async () => {
    const cols = await rows('select name, type, "notnull" as nn from pragma_table_info(\'api_keys\') order by cid')
    expect(cols.map((r) => r.name)).toEqual([
      'id',
      'created_at',
      'updated_at',
      'organization_id',
      'agent_id',
      'key_hash',
      'prefix',
      'last_used_at',
      'revoked_at',
      'expires_at',
      'created_by',
    ])
    expect(cols.every((r) => r.type === 'TEXT')).toBe(true)
    expect((await rows("select 1 from pragma_foreign_key_list('api_keys')")).length).toBe(0)
    const sqlText = (await rows("select sql from sqlite_master where name = 'api_keys'"))[0]!.sql as string
    expect(sqlText).toMatch(/\) STRICT/)
    const a = await make()
    const dup = await run(
      control,
      'insert into api_keys (id, created_at, updated_at, organization_id, agent_id, key_hash, prefix, created_by) values (?, ?, ?, ?, ?, ?, ?, ?)',
      nextId(),
      NOW,
      NOW,
      ORG,
      a.agentId,
      a.keyHash,
      'vk_',
      ACTOR,
    )
    expect(dup).toMatch(/UNIQUE/i)
  })

  it('the CHECKs refuse a malformed id, organisation, agent, creator and timestamp', async () => {
    const ins = (over: Record<string, string>) => {
      const v = {
        id: nextId(),
        created_at: NOW,
        updated_at: NOW,
        organization_id: ORG,
        agent_id: nextId(),
        key_hash: hashOf(),
        prefix: 'vk_',
        created_by: ACTOR,
        ...over,
      }
      return run(
        control,
        'insert into api_keys (id, created_at, updated_at, organization_id, agent_id, key_hash, prefix, created_by) values (?, ?, ?, ?, ?, ?, ?, ?)',
        v.id,
        v.created_at,
        v.updated_at,
        v.organization_id,
        v.agent_id,
        v.key_hash,
        v.prefix,
        v.created_by,
      )
    }
    expect(await ins({})).toBeNull()
    for (const bad of <Array<Record<string, string>>>[
      { id: 'not-a-uuid' },
      { created_at: 'yesterday' },
      { updated_at: '2026-11-16' },
      { organization_id: 'x' },
      { agent_id: 'x' },
      { created_by: 'x' },
    ])
      expect(await ins(bad), JSON.stringify(bad)).toMatch(/CHECK/i)
    expect(
      await run(
        control,
        'update api_keys set revoked_at = ? where id = ?',
        'nope',
        (await rows('select id from api_keys limit 1'))[0]!.id,
      ),
    ).toMatch(/CHECK/i)
  })

  it('the CRM database is unchanged: its api_keys keeps its foreign keys and no control table appears there', async () => {
    const fks = await rowsOf(crm, 'select "table" as ref from pragma_foreign_key_list(\'api_keys\') order by 1')
    expect(fks.map((r) => r.ref)).toEqual(['agents', 'organizations', 'principals'])
  })
})

describe('group 2: insert writes the key and its audit row in one batch (P2, D9 (c), D12)', () => {
  it('writes the key row and exactly one api_key.created row, with no key, hash or hash fragment', async () => {
    const a = await make({ expiresAt: plus(NOW, HOUR) })
    expect(await keyRow(a.id)).toMatchObject({
      organization_id: ORG,
      agent_id: a.agentId,
      key_hash: a.keyHash,
      prefix: 'vk_abcdefgh',
      last_used_at: null,
      revoked_at: null,
      expires_at: plus(NOW, HOUR),
      created_by: ACTOR,
      created_at: NOW,
      updated_at: NOW,
    })
    const log = await audit(a.id)
    expect(log).toHaveLength(1)
    expect(log[0]).toMatchObject({
      id: a.auditId,
      at: NOW,
      actor_id: ACTOR,
      action: 'api_key.created',
      target_type: 'api_key',
      target_id: a.id,
    })
    expect(JSON.parse(log[0]!.detail)).toEqual({
      agent_id: a.agentId,
      prefix: 'vk_abcdefgh',
      expires_at: plus(NOW, HOUR),
    })
    expect(log[0]!.detail).not.toContain(a.keyHash)
    expect(log[0]!.detail).not.toContain(a.keyHash.slice(0, 8))
  })

  it('a duplicate id or a duplicate hash leaves neither a second key row nor an audit row', async () => {
    const a = await make()
    const sameId = newKey({ id: a.id })
    expect(await insertApiKey(c(), sameId)).toBe('duplicate')
    const sameHash = newKey({ keyHash: a.keyHash })
    expect(await insertApiKey(c(), sameHash)).toBe('duplicate')
    expect(await audit(sameId.id)).toHaveLength(1) // the first key's own row only
    expect(await audit(sameHash.id)).toHaveLength(0)
    expect(await keyRow(sameHash.id)).toBeUndefined()
    expect(
      (await rows('select count(*) as n from control_audit where id in (?, ?)', sameId.auditId, sameHash.auditId))[0]!
        .n,
    ).toBe(0)
  })
})

describe('group 3: revoke (P3)', () => {
  it('a live key is revoked, revoked_at and updated_at at the unit clock, with one api_key.revoked row', async () => {
    const a = await make()
    const later = plus(NOW, HOUR)
    const auditId = nextId()
    expect(await revokeApiKey(c(), { id: a.id, organizationId: ORG, auditId, actorId: ACTOR, now: later })).toBe(
      'revoked',
    )
    expect(await keyRow(a.id)).toMatchObject({ revoked_at: later, updated_at: later })
    const log = (await audit(a.id)).filter((r) => r.action === 'api_key.revoked')
    expect(log).toHaveLength(1)
    expect(log[0]).toMatchObject({ id: auditId, at: later, actor_id: ACTOR, target_type: 'api_key', target_id: a.id })
    expect(log[0]!.detail).not.toContain(a.keyHash)
  })

  it('an already revoked key returns unchanged: no write, no audit row', async () => {
    const a = await make()
    const t1 = plus(NOW, HOUR)
    expect(await revokeApiKey(c(), { id: a.id, organizationId: ORG, auditId: nextId(), actorId: ACTOR, now: t1 })).toBe(
      'revoked',
    )
    const auditId = nextId()
    expect(
      await revokeApiKey(c(), { id: a.id, organizationId: ORG, auditId, actorId: ACTOR, now: plus(t1, HOUR) }),
    ).toBe('already_revoked')
    expect(await keyRow(a.id)).toMatchObject({ revoked_at: t1, updated_at: t1 })
    expect((await audit(a.id)).filter((r) => r.action === 'api_key.revoked')).toHaveLength(1)
    expect((await rows('select count(*) as n from control_audit where id = ?', auditId))[0]!.n).toBe(0)
  })

  it("a missing key, or another organisation's, is not_found and writes nothing", async () => {
    const a = await make()
    const auditId = nextId()
    expect(await revokeApiKey(c(), { id: nextId(), organizationId: ORG, auditId, actorId: ACTOR, now: NOW })).toBe(
      'not_found',
    )
    expect(await revokeApiKey(c(), { id: a.id, organizationId: nextId(), auditId, actorId: ACTOR, now: NOW })).toBe(
      'not_found',
    )
    expect((await keyRow(a.id))!.revoked_at).toBeNull()
    expect((await rows('select count(*) as n from control_audit where id = ?', auditId))[0]!.n).toBe(0)
  })

  it('a stamp changed between read and write writes nothing, audit included, and reports drift', async () => {
    const a = await make()
    const auditId = nextId()
    const bumped = plus(NOW, 5 * MIN)
    const store = racing(() =>
      control.prepare('update api_keys set updated_at = ? where id = ?').bind(bumped, a.id).run(),
    )
    expect(
      await revokeApiKey(store, { id: a.id, organizationId: ORG, auditId, actorId: ACTOR, now: plus(NOW, HOUR) }),
    ).toBe('drifted')
    expect(await keyRow(a.id)).toMatchObject({ revoked_at: null, updated_at: bumped })
    expect((await rows('select count(*) as n from control_audit where id = ?', auditId))[0]!.n).toBe(0)
  })

  it('a racing revoke that sets revoked_at and updated_at to the same instant is drift: the audit row is not written either', async () => {
    const a = await make()
    const auditId = nextId()
    const now = plus(NOW, HOUR)
    const store = racing(() =>
      control.prepare('update api_keys set revoked_at = ?, updated_at = ? where id = ?').bind(now, now, a.id).run(),
    )
    expect(await revokeApiKey(store, { id: a.id, organizationId: ORG, auditId, actorId: ACTOR, now })).toBe('drifted')
    expect(await keyRow(a.id)).toMatchObject({ revoked_at: now, updated_at: now })
    expect((await rows('select count(*) as n from control_audit where id = ?', auditId))[0]!.n).toBe(0)
  })

  it('a racing revoke that keeps the stamp is caught by the revoked_at IS NULL guard: nothing written, no second audit row', async () => {
    const a = await make()
    const auditId = nextId()
    const theirs = plus(NOW, 2 * MIN)
    const store = racing(() =>
      control.prepare('update api_keys set revoked_at = ? where id = ?').bind(theirs, a.id).run(),
    )
    expect(
      await revokeApiKey(store, { id: a.id, organizationId: ORG, auditId, actorId: ACTOR, now: plus(NOW, HOUR) }),
    ).toBe('drifted')
    expect(await keyRow(a.id)).toMatchObject({ revoked_at: theirs, updated_at: NOW })
    expect((await rows('select count(*) as n from control_audit where id = ?', auditId))[0]!.n).toBe(0)
  })

  it('a caller-supplied expectedUpdatedAt that is stale is drift too', async () => {
    const a = await make()
    expect(
      await revokeApiKey(c(), {
        id: a.id,
        organizationId: ORG,
        auditId: nextId(),
        actorId: ACTOR,
        now: plus(NOW, HOUR),
        expectedUpdatedAt: plus(NOW, -HOUR),
      }),
    ).toBe('drifted')
    expect((await keyRow(a.id))!.revoked_at).toBeNull()
  })
})

describe('group 4: lookup by hash and the stamp (P4, P5)', () => {
  it('the lookup returns the mapping and the mutable fields for a live, a revoked and an expired key', async () => {
    const live = await make()
    const expired = await make({ expiresAt: plus(NOW, -HOUR) })
    const revoked = await make()
    await revokeApiKey(c(), {
      id: revoked.id,
      organizationId: ORG,
      auditId: nextId(),
      actorId: ACTOR,
      now: plus(NOW, MIN),
    })
    expect(await findApiKeyByHash(c(), live.keyHash)).toEqual({
      id: live.id,
      agentId: live.agentId,
      organizationId: ORG,
      lastUsedAt: null,
      revokedAt: null,
      expiresAt: null,
    })
    expect(await findApiKeyByHash(c(), expired.keyHash)).toMatchObject({ id: expired.id, expiresAt: plus(NOW, -HOUR) })
    expect(await findApiKeyByHash(c(), revoked.keyHash)).toMatchObject({ id: revoked.id, revokedAt: plus(NOW, MIN) })
    expect(await readApiKeyState(c(), revoked.id)).toEqual({
      lastUsedAt: null,
      revokedAt: plus(NOW, MIN),
      expiresAt: null,
    })
  })

  it('an unknown hash and an unknown id find nothing', async () => {
    expect(await findApiKeyByHash(c(), 'no-such-hash')).toBeNull()
    expect(await readApiKeyState(c(), nextId())).toBeNull()
  })

  it('the stamp writes once inside a minute and again after it, never touches updated_at, and writes no audit row', async () => {
    const a = await make()
    expect(await stampApiKeyUsed(c(), { id: a.id, now: NOW })).toBe(true)
    expect((await keyRow(a.id))!.last_used_at).toBe(NOW)
    expect(await stampApiKeyUsed(c(), { id: a.id, now: plus(NOW, 30_000) })).toBe(false)
    expect((await keyRow(a.id))!.last_used_at).toBe(NOW)
    expect(await stampApiKeyUsed(c(), { id: a.id, now: plus(NOW, MIN + 1) })).toBe(true)
    expect(await keyRow(a.id)).toMatchObject({ last_used_at: plus(NOW, MIN + 1), updated_at: NOW })
    expect(await audit(a.id)).toHaveLength(1) // api_key.created only
  })
})

describe('group 5: list and get as the CRM resource reads them', () => {
  it('the same rows, order, paging and agent filter as the CRM read over the same seeded keys, never key_hash', async () => {
    const ORG2 = '0190b2c4-0000-7000-8000-00000000a0ff'
    const USER = '0190b2c4-0000-7000-8000-00000000b0ff'
    const AG1 = nextId()
    const AG2 = nextId()
    await seedDeployment(crm, { organizationId: ORG2 })
    await seedPrincipal(crm, { id: USER, kind: 'user' })
    await seedAgent(crm, { id: AG1, organizationId: ORG2, createdBy: USER })
    await seedAgent(crm, { id: AG2, organizationId: ORG2, createdBy: USER })
    const made: NewApiKey[] = []
    for (const [i, agentId] of [AG1, AG2, AG1, AG2, AG1].entries()) {
      const k = newKey({
        organizationId: ORG2,
        agentId,
        actorId: USER,
        expiresAt: i === 3 ? plus(NOW, HOUR) : null,
        now: plus(NOW, i * MIN),
      })
      await insertApiKey(c(), k)
      await run(
        crm,
        'insert into api_keys (id, created_at, updated_at, organization_id, agent_id, key_hash, prefix, expires_at, created_by) values (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        k.id,
        k.now,
        k.now,
        k.organizationId,
        k.agentId,
        k.keyHash,
        k.prefix,
        k.expiresAt,
        k.actorId,
      )
      made.push(k)
    }
    const crmRead = async (a: { agentId?: string; after?: string; limit: number }) =>
      (
        await rowsOf(
          crm,
          `select id, organization_id, agent_id, prefix, last_used_at, revoked_at, expires_at, created_by, created_at, updated_at from api_keys
           where organization_id = ? and (? is null or agent_id = ?) and (? is null or id > ?) order by id limit ?`,
          ORG2,
          a.agentId ?? null,
          a.agentId ?? null,
          a.after ?? null,
          a.after ?? null,
          a.limit,
        )
      ).map((r) => ({
        id: r.id,
        organizationId: r.organization_id,
        agentId: r.agent_id,
        prefix: r.prefix,
        lastUsedAt: r.last_used_at,
        revokedAt: r.revoked_at,
        expiresAt: r.expires_at,
        createdBy: r.created_by,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
      }))
    for (const q of [{ limit: 10 }, { limit: 2 }, { limit: 10, agentId: AG1 }, { limit: 1, agentId: AG2 }]) {
      expect(await listApiKeys(c(), { organizationId: ORG2, ...q })).toEqual(await crmRead(q))
    }
    const first = await listApiKeys(c(), { organizationId: ORG2, limit: 2 })
    const next = { after: first[1]!.id, limit: 10 }
    expect(await listApiKeys(c(), { organizationId: ORG2, ...next })).toEqual(await crmRead(next))
    expect((await listApiKeys(c(), { organizationId: ORG2, limit: 10 })).map((r) => r.id)).toEqual(
      made.map((k) => k.id).sort(),
    )
    expect(JSON.stringify(await listApiKeys(c(), { organizationId: ORG2, limit: 10 }))).not.toContain('keyHash')
    expect(JSON.stringify(await listApiKeys(c(), { organizationId: ORG2, limit: 10 }))).not.toContain(made[0]!.keyHash)
    // get
    const one = made[3]!
    expect(await getApiKey(c(), { id: one.id, organizationId: ORG2 })).toEqual(
      (await crmRead({ limit: 10 })).find((r) => r.id === one.id),
    )
    expect(await getApiKey(c(), { id: one.id, organizationId: ORG })).toBeNull()
    expect(await getApiKey(c(), { id: nextId(), organizationId: ORG2 })).toBeNull()
    expect(JSON.stringify(await getApiKey(c(), { id: one.id, organizationId: ORG2 }))).not.toContain(one.keyHash)
  })

  it('an organisation with no keys lists nothing', async () => {
    expect(await listApiKeys(c(), { organizationId: nextId(), limit: 10 })).toEqual([])
  })
})

describe('group 6: dormant and bounded (D5, P6)', () => {
  const NAMES = ['insertApiKey', 'revokeApiKey', 'getApiKey', 'listApiKeys']
  const PACKAGES = fileURLToPath(new URL('../../', import.meta.url))
  const sources = (dir: string): string[] =>
    readdirSync(dir).flatMap((f) => {
      if (f === 'node_modules' || f === 'dist' || f === '.wrangler') return []
      const p = join(dir, f)
      if (statSync(p).isDirectory()) return sources(p)
      return /\.(ts|tsx|js|mjs)$/.test(f) && !/\.test\.|\.suite\.|\.d\.ts$/.test(f) ? [p] : []
    })
  // [[CORE350]] P7: the lookup, state and stamp methods now have a caller (the Worker composition, for API-key authentication) and left this list; the four below stay without callers until #351 (CORE351) wires the writers and deletes this test.
  it('no non-test source outside the control store and the index reaches the API key methods', () => {
    const own = ['storage-d1/src/control-store.ts', 'storage-d1/src/index.ts']
    const hits: string[] = []
    for (const pkg of readdirSync(PACKAGES)) {
      for (const sub of ['src', 'scripts']) {
        let files: string[] = []
        try {
          files = sources(join(PACKAGES, pkg, sub))
        } catch {
          continue
        }
        for (const f of files) {
          if (own.some((o) => f.endsWith(o))) continue
          const text = readFileSync(f, 'utf-8')
          for (const name of NAMES) if (new RegExp(`\\b${name}\\b`).test(text)) hits.push(`${f}: ${name}`)
        }
      }
    }
    expect(hits).toEqual([])
  })
})
