import { CompiledQuery, type Kysely } from 'kysely'
import type { Database } from '@vault/db'
export async function installPostgres(db: Kysely<Database>) {
  const { rows } = await db.executeQuery<{ name: string }>(
    CompiledQuery.raw('select current_database() as name'),
  )
  if (rows[0]?.name !== 'vault_test_core33') throw new Error('requires vault_test_core33')
  await db.executeQuery(
    CompiledQuery.raw(`CREATE SCHEMA IF NOT EXISTS storage_prototype;
 CREATE TABLE IF NOT EXISTS storage_prototype.operations (
 id uuid PRIMARY KEY, organization_id uuid NOT NULL REFERENCES organizations(id), actor_id uuid NOT NULL REFERENCES principals(id),
 created_at timestamptz NOT NULL DEFAULT now(), input jsonb NOT NULL, outcome jsonb, UNIQUE(organization_id,id));
 CREATE TABLE IF NOT EXISTS storage_prototype.rows (
 id uuid PRIMARY KEY, organization_id uuid NOT NULL REFERENCES organizations(id), actor_id uuid NOT NULL REFERENCES principals(id),
 created_at timestamptz NOT NULL DEFAULT now(), operation_id uuid NOT NULL, slot text NOT NULL, ordinal integer NOT NULL, payload jsonb NOT NULL,
 FOREIGN KEY(organization_id,operation_id) REFERENCES storage_prototype.operations(organization_id,id), UNIQUE(organization_id,operation_id,slot,ordinal));
 GRANT USAGE ON SCHEMA storage_prototype TO vault_authenticated,vault_service;
 GRANT SELECT,INSERT,UPDATE,DELETE ON storage_prototype.operations,storage_prototype.rows TO vault_authenticated,vault_service;`),
  )
  for (const name of ['operations', 'rows']) {
    await db.executeQuery(
      CompiledQuery.raw(`ALTER TABLE storage_prototype.${name} ENABLE ROW LEVEL SECURITY; ALTER TABLE storage_prototype.${name} FORCE ROW LEVEL SECURITY;
 DROP POLICY IF EXISTS ${name}_tenant ON storage_prototype.${name};
 CREATE POLICY ${name}_tenant ON storage_prototype.${name} TO vault_authenticated USING(organization_id=app.current_organization_id()) WITH CHECK(organization_id=app.current_organization_id());`),
    )
  }
}
export async function removePostgres(db: Kysely<Database>) {
  await db.executeQuery(CompiledQuery.raw('DROP SCHEMA IF EXISTS storage_prototype CASCADE'))
}
