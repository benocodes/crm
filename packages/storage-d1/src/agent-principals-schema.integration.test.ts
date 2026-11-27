import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { D1Like } from './binding.js'
import { openLocalD1, type LocalD1 } from './test/index.js'
import { seedDeployment, seedPrincipal } from './test/seed.js'

// CORE77 D23: the four `agents` columns in genesis (auth_subject, auth_client_id, auth_provider, delegated_by): their CHECKs and partial unique indexes.
const ORG = '0190b2c4-0000-7000-8000-00000000a001'
const SYSTEM = '0190b2c4-0000-7000-8000-00000000b000'
const USER = '0190b2c4-0000-7000-8000-00000000b001'
const USER2 = '0190b2c4-0000-7000-8000-00000000b002'
const AT = '2026-10-22T09:00:00.000Z'
let n = 0x100

let local: LocalD1
let d1: D1Like
beforeAll(async () => {
  local = await openLocalD1(['D1'])
  d1 = local.bindings.D1!
  await seedDeployment(d1, { organizationId: ORG, provider: 'clerk', externalId: 'org_x' })
  await seedPrincipal(d1, { id: SYSTEM, kind: 'system' })
  await seedPrincipal(d1, { id: USER, kind: 'user', authSubject: 'user_1' })
  await seedPrincipal(d1, { id: USER2, kind: 'user', authSubject: 'user_2' })
})
afterAll(async () => {
  await local.dispose()
})

const agentId = () => `0190b2c4-0000-7000-8000-00000000${(n++).toString(16).padStart(4, '0')}`
/** A new agent row (its principal first) with the given columns over the defaults of a plain agent. */
async function insertAgent(over: Record<string, unknown> = {}): Promise<string | null> {
  const id = agentId()
  const row: Record<string, unknown> = {
    id,
    created_at: AT,
    updated_at: AT,
    organization_id: ORG,
    name: 'a',
    scopes: '[]',
    created_by: SYSTEM,
    ...over,
  }
  const cols = Object.keys(row)
  try {
    await d1.batch([
      d1.prepare("INSERT INTO principals (id, kind, created_at) VALUES (?, 'agent', ?)").bind(id, AT),
      d1
        .prepare(
          `INSERT INTO agents (${cols.map((c) => `"${c}"`).join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`,
        )
        .bind(...Object.values(row)),
    ])
    return null
  } catch (e) {
    return (e as Error).message
  }
}

describe('agent principals', () => {
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
    expect(
      await insertAgent({
        auth_provider: 'clerk',
        auth_subject: 'user_x',
        auth_client_id: 'client_x',
        delegated_by: USER,
      }),
    ).toMatch(/CHECK/)
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
    const fks = (
      await d1.prepare('select "table" as t, "from" as f from pragma_foreign_key_list(\'agents\') order by 1, 2').all()
    ).results as Array<{ t: string; f: string }>
    expect(fks).toContainEqual({ t: 'users', f: 'delegated_by' })
    expect(await insertAgent({ auth_provider: 'clerk', auth_client_id: 'client_z', delegated_by: SYSTEM })).toMatch(
      /FOREIGN KEY/i,
    )
  })

  it('(auth_provider, auth_subject) is unique', async () => {
    expect(await insertAgent({ auth_provider: 'clerk', auth_subject: 'user_dup' })).toBeNull()
    expect(await insertAgent({ auth_provider: 'clerk', auth_subject: 'user_dup' })).toMatch(/UNIQUE/)
  })

  it('(auth_provider, auth_client_id, delegated_by) is unique, and another human or client may repeat the rest', async () => {
    expect(await insertAgent({ auth_provider: 'clerk', auth_client_id: 'client_dup', delegated_by: USER })).toBeNull()
    expect(await insertAgent({ auth_provider: 'clerk', auth_client_id: 'client_dup', delegated_by: USER })).toMatch(
      /UNIQUE/,
    )
    expect(await insertAgent({ auth_provider: 'clerk', auth_client_id: 'client_dup', delegated_by: USER2 })).toBeNull()
    expect(await insertAgent({ auth_provider: 'clerk', auth_client_id: 'client_dup2', delegated_by: USER })).toBeNull()
  })

  it('the unique indexes are partial: many plain agents coexist', async () => {
    expect(await insertAgent()).toBeNull()
    expect(await insertAgent()).toBeNull()
  })
})
