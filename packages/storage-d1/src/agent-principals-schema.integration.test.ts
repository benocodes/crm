import { cpSync, mkdtempSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { D1Like } from './binding.js'
import { MIGRATIONS_DIR, applyMigrations, openLocalD1, type LocalD1 } from './test/index.js'
import { seedAgent, seedDeployment, seedPrincipal } from './test/seed.js'

// CORE77 D23: the four `agents` columns and migration 0007, applied over a database at 0006 that already holds an agent and a key.
const ORG = '0190b2c4-0000-7000-8000-00000000a001'
const SYSTEM = '0190b2c4-0000-7000-8000-00000000b000'
const USER = '0190b2c4-0000-7000-8000-00000000b001'
const USER2 = '0190b2c4-0000-7000-8000-00000000b002'
const OLD_AGENT = '0190b2c4-0000-7000-8000-00000000c001'
const KEY = '0190b2c4-0000-7000-8000-00000000d001'
const AT = '2026-10-22T09:00:00.000Z'
let n = 0x100

let local: LocalD1
let d1: D1Like
beforeAll(async () => {
  local = await openLocalD1(['D1'], { migrate: false })
  d1 = local.bindings.D1!
})
afterAll(async () => {
  await local.dispose()
})

const agentId = () => `0190b2c4-0000-7000-8000-00000000${(n++).toString(16).padStart(4, '0')}`
/** A new agent row (its principal first) with the given columns over the defaults of a plain agent. */
async function insertAgent(over: Record<string, unknown> = {}): Promise<string | null> {
  const id = agentId()
  const row: Record<string, unknown> = { id, created_at: AT, updated_at: AT, organization_id: ORG, name: 'a', scopes: '[]', created_by: SYSTEM, ...over }
  const cols = Object.keys(row)
  try {
    await d1.batch([
      d1.prepare("INSERT INTO principals (id, kind, created_at) VALUES (?, 'agent', ?)").bind(id, AT),
      d1.prepare(`INSERT INTO agents (${cols.map((c) => `"${c}"`).join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`).bind(...Object.values(row)),
    ])
    return null
  } catch (e) {
    return (e as Error).message
  }
}

describe('migration 0007_agent_principals over a database at 0006 with an agent and a key', () => {
  it('applies, keeps the agent and its key, and the new columns are null', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mig-'))
    for (const f of readdirSync(MIGRATIONS_DIR).filter((f) => f < '0007')) cpSync(join(MIGRATIONS_DIR, f), join(dir, f))
    expect(readdirSync(dir).sort().pop()).toBe('0006_notes.sql')
    await applyMigrations(d1, dir)
    await seedDeployment(d1, { organizationId: ORG, provider: 'clerk', externalId: 'org_x' })
    await seedPrincipal(d1, { id: SYSTEM, kind: 'system' })
    await seedPrincipal(d1, { id: USER, kind: 'user', authSubject: 'user_1' })
    await seedPrincipal(d1, { id: USER2, kind: 'user', authSubject: 'user_2' })
    await seedAgent(d1, { id: OLD_AGENT, organizationId: ORG, createdBy: SYSTEM, name: 'operator', scopes: ['tasks:read'] })
    await d1
      .prepare('INSERT INTO api_keys (id, created_at, updated_at, organization_id, agent_id, key_hash, prefix, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .bind(KEY, AT, AT, ORG, OLD_AGENT, 'h'.repeat(64), 'vk_abcdefg', SYSTEM)
      .run()
    const cols = (await d1.prepare("select name from pragma_table_info('agents')").all()).results!.map((r) => (r as { name: string }).name)
    expect(cols).not.toContain('auth_subject')

    const only = mkdtempSync(join(tmpdir(), 'mig7-'))
    for (const f of readdirSync(MIGRATIONS_DIR).filter((f) => f.startsWith('0007'))) cpSync(join(MIGRATIONS_DIR, f), join(only, f))
    expect(await applyMigrations(d1, only)).toEqual(['0007_agent_principals.sql'])

    const after = (await d1.prepare("select name from pragma_table_info('agents')").all()).results!.map((r) => (r as { name: string }).name)
    expect(after).toEqual(expect.arrayContaining(['auth_provider', 'auth_subject', 'auth_client_id', 'delegated_by']))
    expect((await d1.prepare('select name, scopes, auth_provider, auth_subject, auth_client_id, delegated_by from agents').all()).results).toEqual([
      { name: 'operator', scopes: '["tasks:read"]', auth_provider: null, auth_subject: null, auth_client_id: null, delegated_by: null },
    ])
    expect((await d1.prepare('select agent_id, prefix from api_keys').all()).results).toEqual([{ agent_id: OLD_AGENT, prefix: 'vk_abcdefg' }])
  })

  it('a plain agent (an API-key agent) still inserts with none of the four columns', async () => {
    expect(await insertAgent()).toBeNull()
  })

  it('an agent account: auth_subject with auth_provider', async () => {
    expect(await insertAgent({ auth_provider: 'clerk', auth_subject: 'user_g' })).toBeNull()
  })

  it('a delegated agent: auth_client_id with auth_provider and delegated_by', async () => {
    expect(await insertAgent({ auth_provider: 'clerk', auth_client_id: 'client_1', delegated_by: USER })).toBeNull()
  })

  it('refuses auth_subject and auth_client_id together (mutually exclusive)', async () => {
    expect(await insertAgent({ auth_provider: 'clerk', auth_subject: 'user_x', auth_client_id: 'client_x', delegated_by: USER })).toMatch(/CHECK/)
  })

  it.each([
    ['auth_subject', { auth_subject: 'user_nop' }],
    ['auth_client_id', { auth_client_id: 'client_nop', delegated_by: USER }],
  ])('refuses %s without auth_provider', async (_c, row) => {
    expect(await insertAgent(row)).toMatch(/CHECK/)
  })

  it('refuses auth_provider with neither an auth_subject nor an auth_client_id', async () => {
    expect(await insertAgent({ auth_provider: 'clerk' })).toMatch(/CHECK/)
  })

  it('refuses delegated_by without auth_client_id, and auth_client_id without delegated_by', async () => {
    expect(await insertAgent({ delegated_by: USER })).toMatch(/CHECK/)
    expect(await insertAgent({ auth_provider: 'clerk', auth_subject: 'user_y', delegated_by: USER })).toMatch(/CHECK/)
    expect(await insertAgent({ auth_provider: 'clerk', auth_client_id: 'client_y' })).toMatch(/CHECK/)
  })

  it('delegated_by references users', async () => {
    const fks = (await d1.prepare("select \"table\" as t, \"from\" as f from pragma_foreign_key_list('agents') order by 1, 2").all()).results as Array<{ t: string; f: string }>
    expect(fks).toContainEqual({ t: 'users', f: 'delegated_by' })
    expect(await insertAgent({ auth_provider: 'clerk', auth_client_id: 'client_z', delegated_by: SYSTEM })).toMatch(/FOREIGN KEY/i)
  })

  it('(auth_provider, auth_subject) is unique', async () => {
    expect(await insertAgent({ auth_provider: 'clerk', auth_subject: 'user_dup' })).toBeNull()
    expect(await insertAgent({ auth_provider: 'clerk', auth_subject: 'user_dup' })).toMatch(/UNIQUE/)
  })

  it('(auth_provider, auth_client_id, delegated_by) is unique, and another human or client may repeat the rest', async () => {
    expect(await insertAgent({ auth_provider: 'clerk', auth_client_id: 'client_dup', delegated_by: USER })).toBeNull()
    expect(await insertAgent({ auth_provider: 'clerk', auth_client_id: 'client_dup', delegated_by: USER })).toMatch(/UNIQUE/)
    expect(await insertAgent({ auth_provider: 'clerk', auth_client_id: 'client_dup', delegated_by: USER2 })).toBeNull()
    expect(await insertAgent({ auth_provider: 'clerk', auth_client_id: 'client_dup2', delegated_by: USER })).toBeNull()
  })

  it('the unique indexes are partial: many plain agents coexist', async () => {
    expect(await insertAgent()).toBeNull()
    expect(await insertAgent()).toBeNull()
  })
})
