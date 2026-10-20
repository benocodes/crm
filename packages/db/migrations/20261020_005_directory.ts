import { sql, type Kysely } from 'kysely'

// [[CORE3]] D1, D22, [[CORE27]] grants: Clerk Organizations is the source of truth, so organisations carry
// their provider link, the directory sync writes as one `system` principal, and tenants only read memberships.
export async function up(db: Kysely<any>): Promise<void> {
  await sql`
    ALTER TABLE organizations
      ADD COLUMN auth_provider text,
      ADD COLUMN auth_org_id text,
      ADD CONSTRAINT organizations_auth_pair CHECK ((auth_provider IS NULL) = (auth_org_id IS NULL)),
      ADD CONSTRAINT organizations_auth_provider_org_key UNIQUE (auth_provider, auth_org_id)`.execute(db)

  await sql`ALTER TABLE principals DROP CONSTRAINT principals_kind_check`.execute(db)
  await sql`ALTER TABLE principals ADD CONSTRAINT principals_kind_check CHECK (kind IN ('user','agent','system'))`.execute(db)
  await sql`CREATE UNIQUE INDEX idx_principals_single_system ON principals (kind) WHERE kind = 'system'`.execute(db)
  await sql`DROP POLICY principals_tenant ON principals`.execute(db)
  await sql`
    CREATE POLICY principals_tenant ON principals FOR SELECT TO vault_authenticated
    USING (
      EXISTS (SELECT 1 FROM memberships m WHERE m.user_id = principals.id AND m.organization_id = app.current_organization_id())
      OR EXISTS (SELECT 1 FROM agents a WHERE a.id = principals.id AND a.organization_id = app.current_organization_id())
      OR kind = 'system'
    )`.execute(db)

  await sql`GRANT INSERT ON principals TO vault_authenticated`.execute(db)
  await sql`
    CREATE POLICY principals_insert_agent ON principals FOR INSERT TO vault_authenticated
    WITH CHECK (kind = 'agent' AND app.current_organization_id() IS NOT NULL)`.execute(db)

  await sql`GRANT INSERT ON agents TO vault_authenticated`.execute(db)
  await sql`GRANT UPDATE (name, scopes, disabled_at) ON agents TO vault_authenticated`.execute(db)

  await sql`
    GRANT SELECT (id, created_at, updated_at, organization_id, agent_id, prefix, last_used_at, revoked_at, expires_at, created_by)
    ON api_keys TO vault_authenticated`.execute(db)
  await sql`GRANT INSERT ON api_keys TO vault_authenticated`.execute(db)
  await sql`GRANT UPDATE (revoked_at) ON api_keys TO vault_authenticated`.execute(db)
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`REVOKE ALL ON api_keys FROM vault_authenticated`.execute(db)
  await sql`REVOKE ALL ON agents FROM vault_authenticated`.execute(db)
  await sql`GRANT SELECT ON agents TO vault_authenticated`.execute(db)
  await sql`DROP POLICY IF EXISTS principals_insert_agent ON principals`.execute(db)
  await sql`REVOKE INSERT ON principals FROM vault_authenticated`.execute(db)
  await sql`DROP POLICY principals_tenant ON principals`.execute(db)
  await sql`
    CREATE POLICY principals_tenant ON principals FOR SELECT TO vault_authenticated
    USING (
      EXISTS (SELECT 1 FROM memberships m WHERE m.user_id = principals.id AND m.organization_id = app.current_organization_id())
      OR EXISTS (SELECT 1 FROM agents a WHERE a.id = principals.id AND a.organization_id = app.current_organization_id())
    )`.execute(db)
  await sql`DROP INDEX idx_principals_single_system`.execute(db)
  await sql`DELETE FROM principals WHERE kind = 'system'`.execute(db)
  await sql`ALTER TABLE principals DROP CONSTRAINT principals_kind_check`.execute(db)
  await sql`ALTER TABLE principals ADD CONSTRAINT principals_kind_check CHECK (kind IN ('user','agent'))`.execute(db)
  await sql`
    ALTER TABLE organizations
      DROP CONSTRAINT organizations_auth_provider_org_key,
      DROP CONSTRAINT organizations_auth_pair,
      DROP COLUMN auth_org_id,
      DROP COLUMN auth_provider`.execute(db)
}
