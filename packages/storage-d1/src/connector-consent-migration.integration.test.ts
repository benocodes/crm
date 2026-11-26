import { cpSync, mkdtempSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { D1Like } from './binding.js'
import { MIGRATIONS_DIR, applyMigrations, openLocalD1, type LocalD1 } from './test/index.js'
import { seedAgent, seedDeployment, seedPrincipal } from './test/seed.js'

// [[CORE666]] D4: the migration after 0030 adds the nullable `agents.consented_scopes` and nothing else. Seeded at 0030 with a delegated agent holding a 42-scope-style record by raw SQL (the permitted exception:
// the test proves what the database does, which no operation reaches): the old row reads NULL there and every other column is as it was.
const ORG = '0190b2c4-0000-7000-8000-00000000a001'
const USER = '0190b2c4-0000-7000-8000-00000000b001'
const AGENT = '0190b2c4-0000-7000-8000-00000000c001'
const RECORD = ['contacts:read', 'contacts:request_approval', 'contacts:write', 'tags:read']

let local: LocalD1
let d1: D1Like
beforeAll(async () => {
  local = await openLocalD1(['G'], { migrate: false })
  d1 = local.bindings.G!
})
afterAll(async () => {
  await local.dispose()
})
const all = async <T = Record<string, unknown>>(sqlText: string) =>
  ((await d1.prepare(sqlText).all()).results ?? []) as T[]

describe('the consent migration over a database at 0030 holding a delegated agent', () => {
  it('adds a nullable consented_scopes with no default, leaves the old agent NULL and every other column as it was', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mig30-'))
    for (const f of readdirSync(MIGRATIONS_DIR).filter((f) => f < '0031')) cpSync(join(MIGRATIONS_DIR, f), join(dir, f))
    await applyMigrations(d1, dir)
    await seedDeployment(d1, { organizationId: ORG, provider: 'better-auth', externalId: 'org_x' })
    await seedPrincipal(d1, { id: USER, kind: 'user' })
    await seedAgent(d1, { id: AGENT, organizationId: ORG, createdBy: USER, scopes: RECORD })
    await d1
      .prepare('update agents set auth_provider = ?, auth_client_id = ?, delegated_by = ? where id = ?')
      .bind('better-auth', 'client_x', USER, AGENT)
      .run()
    const before = await all('select * from agents')

    const name = readdirSync(MIGRATIONS_DIR).find((f) => f.startsWith('0031'))
    expect(name, 'the migration after 0030 exists').toMatch(/^0031_.*consent.*\.sql$/)
    const lone = mkdtempSync(join(tmpdir(), 'mig31only-'))
    cpSync(join(MIGRATIONS_DIR, name!), join(lone, name!))
    expect(await applyMigrations(d1, lone)).toEqual([name])

    const after = await all('select * from agents')
    expect(after.map((r) => r.consented_scopes)).toEqual([null])
    expect(after.map(({ consented_scopes: _c, ...rest }) => rest)).toEqual(before)
    expect(JSON.parse(after[0]!.scopes as string)).toEqual(RECORD)
    const cols = await all<{ name: string; notnull: number; dflt_value: unknown }>(
      "select name, \"notnull\", dflt_value from pragma_table_info('agents') where name = 'consented_scopes'",
    )
    expect(cols).toEqual([{ name: 'consented_scopes', notnull: 0, dflt_value: null }])
  })
})
