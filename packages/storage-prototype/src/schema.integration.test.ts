import { expect, test } from 'vitest'
import { createOwnerTestDb } from '@vault/db/test'
import { sql } from 'kysely'
import { d1Fixture } from './test/d1.js'
import { installPostgres, removePostgres } from './fixtures/postgres.js'
test('Postgres machinery exists with forced RLS', async () => {
  const db = createOwnerTestDb()
  try {
    await installPostgres(db)
    const r = await sql<{
      relname: string
      relrowsecurity: boolean
      relforcerowsecurity: boolean
    }>`select c.relname,c.relrowsecurity,c.relforcerowsecurity from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='storage_prototype' and c.relkind='r'`.execute(
      db,
    )
    expect(r.rows.map((r) => r.relname).sort()).toEqual(['operations', 'rows'])
    expect(r.rows.every((r) => r.relrowsecurity && r.relforcerowsecurity)).toBe(true)
  } finally {
    await removePostgres(db)
    await db.destroy()
  }
})
test('D1 fixture machinery exists', async () => {
  const f = await d1Fixture()
  try {
    const r = await f.query(
      "select name from sqlite_master where type='table' and name like 'prototype_%' order by name",
    )
    expect(r.map((r) => r.name)).toEqual(['prototype_operations', 'prototype_rows'])
  } finally {
    await f.close()
  }
})

test('Postgres scratch grants, composite FK and fail-closed access', async () => {
  const { postgresFixture } = await import('./test/postgres.js')
  const { withOrganization } = await import('@vault/db')
  const { CompiledQuery } = await import('kysely')
  const { uuid7 } = await import('./uuid7.js')
  const f = await postgresFixture()
  try {
    await expect(
      f.db.executeQuery(CompiledQuery.raw('SELECT * FROM storage_prototype.operations')),
    ).rejects.toMatchObject({ code: '42501' })
    const grants = await f.query(
      "SELECT grantee,privilege_type FROM information_schema.role_table_grants WHERE table_schema='storage_prototype'",
    )
    expect(grants.some((g) => g.grantee === 'vault_app')).toBe(false)
    for (const role of ['vault_authenticated', 'vault_service'])
      expect(grants.filter((g) => g.grantee === role).map((g) => g.privilege_type)).toContain('DELETE')
    const fk = await f.query(
      "SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conrelid='storage_prototype.rows'::regclass AND contype='f'",
    )
    expect(fk.some((r) => r.definition.includes('(organization_id, operation_id)'))).toBe(true)
    const id = uuid7()
    await withOrganization(f.db, { organizationId: f.a.organizationId, principalId: f.a.actor.id }, (trx) =>
      trx.executeQuery(
        CompiledQuery.raw(
          "INSERT INTO storage_prototype.operations(id,organization_id,actor_id,input) VALUES($1,$2,$3,'{}')",
          [id, f.a.organizationId, f.a.actor.id],
        ),
      ),
    )
    await withOrganization(
      f.db,
      { organizationId: f.b.organizationId, principalId: f.b.actor.id },
      async (trx) => {
        expect(
          (await trx.executeQuery(CompiledQuery.raw('SELECT * FROM storage_prototype.operations'))).rows,
        ).toEqual([])
      },
    )
    await expect(
      withOrganization(f.db, { organizationId: f.b.organizationId, principalId: f.b.actor.id }, (trx) =>
        trx.executeQuery(
          CompiledQuery.raw(
            "INSERT INTO storage_prototype.operations(id,organization_id,actor_id,input) VALUES($1,$2,$3,'{}')",
            [uuid7(), f.a.organizationId, f.b.actor.id],
          ),
        ),
      ),
    ).rejects.toMatchObject({ code: '42501' })
  } finally {
    await f.close()
  }
})
test('D1 deployment, XOR, composite FK and partial live uniqueness constraints', async () => {
  const f = await d1Fixture()
  try {
    await expect(f.query('INSERT INTO deployment VALUES(2,?)', [f.b.organizationId])).rejects.toThrow()
    await expect(f.seed({ ...f.a, organizationId: f.b.organizationId })).rejects.toThrow()
    const c: any = await f.seed(f.a, 'contacts', { name: 'Live' })
    await expect(
      f.seed(f.a, 'identities', { kind: 'email', value: 'bad@example.com', contact_id: c.id, own: true }),
    ).rejects.toThrow()
    await expect(
      f.seed(f.a, 'identities', {
        kind: 'email',
        value: 'fk@example.com',
        contact_id: f.b.organizationId,
        own: false,
      }),
    ).rejects.toThrow()
    await f.seed(f.a, 'identities', {
      kind: 'email',
      value: 'unique@example.com',
      contact_id: c.id,
      own: false,
    })
    await expect(
      f.seed(f.a, 'identities', { kind: 'email', value: 'unique@example.com', contact_id: c.id, own: false }),
    ).rejects.toThrow()
    await f.query("UPDATE identities SET deleted_at=? WHERE value='unique@example.com'", [
      new Date().toISOString(),
    ])
    await f.seed(f.a, 'identities', {
      kind: 'email',
      value: 'unique@example.com',
      contact_id: c.id,
      own: false,
    })
    expect(await f.query("SELECT * FROM identities WHERE value='unique@example.com'")).toHaveLength(2)
  } finally {
    await f.close()
  }
})
