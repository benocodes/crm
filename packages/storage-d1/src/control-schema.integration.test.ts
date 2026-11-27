import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { D1Like } from './binding.js'
import { CONTROL_MIGRATIONS } from './control-migrations-manifest.js'
import { readMigrationState } from './migration-state.js'
import { CONTROL_MIGRATIONS_DIR, applyControlMigrations, openLocalD1, type LocalD1 } from './test/index.js'

// [[CORE259]] D4, D13: control 0001 applied to an EMPTY D1 under its own tracker; it holds the auth tables and the control marker and nothing of the CRM.
const ORG = '0190b2c4-0000-7000-8000-00000000a001'
let local: LocalD1
let control: D1Like
beforeAll(async () => {
  local = await openLocalD1(['CONTROL'], { migrate: false })
  control = local.bindings.CONTROL!
})
afterAll(() => local.dispose())

const tables = async (d1: D1Like) =>
  (
    ((
      await d1
        .prepare(
          "select name from sqlite_master where type = 'table' and name not like 'sqlite_%' and name not like '_cf_%' order by name",
        )
        .all()
    ).results ?? []) as Array<{ name: string }>
  ).map((r) => r.name)
const run = (d1: D1Like, text: string, ...binds: unknown[]) =>
  d1
    .prepare(text)
    .bind(...binds)
    .run()
    .then(
      () => null,
      (e: Error) => e.message,
    )

describe('control genesis on an empty database', () => {
  it('applies from its own directory, tracked in its own d1_migrations, and the tracker equals the shipped manifest', async () => {
    expect(await applyControlMigrations(control)).toEqual(['0001_genesis.sql'])
    const state = await readMigrationState(
      control,
      CONTROL_MIGRATIONS.map((m) => m.name),
    )
    expect(state).toMatchObject({
      status: 'current',
      applied: ['0001_genesis.sql'],
    })
    expect(CONTROL_MIGRATIONS_DIR).toMatch(/storage-d1\/control-migrations$/)
  })

  it('creates the 14 auth tables, control_deployment (0002, CORE245) invitations and control_audit, (0004, CORE327) the four webhook tables, (0005, CORE328) api_keys, and no CRM table', async () => {
    const names = (await tables(control)).filter((n) => n !== 'd1_migrations')
    expect(names).toContain('control_deployment')
    expect(names).toEqual(expect.arrayContaining(['invitations', 'control_audit']))
    expect(names.filter((n) => n.startsWith('auth_'))).toHaveLength(14)
    expect(names.filter((n) => n.startsWith('webhook_'))).toHaveLength(4)
    expect(names).toContain('api_keys')
    expect(names).toHaveLength(22)
    for (const crmTable of ['deployment', 'organizations', 'principals', 'events'])
      expect(names).not.toContain(crmTable)
  })

  it('control_deployment is a singleton holding one organisation id', async () => {
    expect(
      await run(control, 'insert into control_deployment (singleton, organization_id) values (1, ?)', ORG),
    ).toBeNull()
    expect(
      await run(control, 'insert into control_deployment (singleton, organization_id) values (2, ?)', ORG),
    ).toMatch(/CHECK/i)
    expect(
      await run(control, 'insert into control_deployment (singleton, organization_id) values (1, ?)', ORG),
    ).toMatch(/UNIQUE|PRIMARY/i)
    expect(
      await run(control, 'insert into control_deployment (singleton, organization_id) values (1, ?)', null),
    ).not.toBeNull()
  })

  it('no foreign key or trigger links the two databases: control tables reference only control tables', async () => {
    for (const t of (await tables(control)).filter((n) => n !== 'd1_migrations')) {
      const fks = ((await control.prepare(`select "table" as ref from pragma_foreign_key_list('${t}')`).all())
        .results ?? []) as Array<{ ref: string }>
      for (const fk of fks) expect(fk.ref, t).toMatch(/^(auth_|webhook_subscriptions$)/)
    }
    const triggers = ((await control.prepare("select name from sqlite_master where type = 'trigger'").all()).results ??
      []) as unknown[]
    // control_audit's two append-only triggers (0002, CORE245 P5) and webhook_secrets' (0004, CORE327 P1) are the only ones, and name no other database.
    expect(triggers.map((t) => (t as { name: string }).name).sort()).toEqual([
      'control_audit_no_delete',
      'control_audit_no_update',
      'webhook_secrets_append_only',
    ])
  })
})
