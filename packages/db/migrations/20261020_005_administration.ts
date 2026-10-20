import { sql, type Kysely } from 'kysely'

export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable('invitations')
    .addColumn('id', 'uuid', (c) => c.primaryKey().defaultTo(sql`uuid_generate_v7()`))
    .addColumn('created_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
    .addColumn('updated_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
    .addColumn('organization_id', 'uuid', (c) => c.notNull().references('organizations.id').onDelete('cascade'))
    .addColumn('email', sql`citext`, (c) => c.notNull())
    .addColumn('role', 'text', (c) => c.notNull().check(sql`role IN ('owner','member')`))
    .addColumn('expires_at', 'timestamptz', (c) => c.notNull())
    .addColumn('accepted_at', 'timestamptz')
    .addColumn('accepted_by', 'uuid', (c) => c.references('users.id'))
    .addColumn('created_by', 'uuid', (c) => c.notNull().references('principals.id'))
    .addColumn('deleted_at', 'timestamptz')
    .addCheckConstraint('invitations_accepted_pair', sql`(accepted_at IS NULL) = (accepted_by IS NULL)`)
    .execute()
  await sql`
    CREATE UNIQUE INDEX idx_invitations_pending_unique ON invitations (organization_id, email)
    WHERE deleted_at IS NULL AND accepted_at IS NULL`.execute(db)
  await sql`
    CREATE INDEX idx_invitations_email ON invitations (email)
    WHERE deleted_at IS NULL AND accepted_at IS NULL`.execute(db)
  await sql`
    CREATE TRIGGER set_updated_at BEFORE UPDATE ON invitations
    FOR EACH ROW EXECUTE FUNCTION app.set_updated_at()`.execute(db)
  await sql`ALTER TABLE invitations ENABLE ROW LEVEL SECURITY`.execute(db)
  await sql`ALTER TABLE invitations FORCE ROW LEVEL SECURITY`.execute(db)
  await sql`
    CREATE POLICY invitations_tenant ON invitations FOR ALL TO vault_authenticated
    USING (organization_id = app.current_organization_id())
    WITH CHECK (organization_id = app.current_organization_id())`.execute(db)
  await sql`GRANT SELECT, INSERT, UPDATE ON invitations TO vault_service`.execute(db)
  await sql`GRANT SELECT, INSERT ON invitations TO vault_authenticated`.execute(db)
  await sql`GRANT UPDATE (deleted_at) ON invitations TO vault_authenticated`.execute(db)

  await sql`GRANT UPDATE (role, deleted_at) ON memberships TO vault_authenticated`.execute(db)

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
  await sql`REVOKE UPDATE (role, deleted_at) ON memberships FROM vault_authenticated`.execute(db)
  await sql`DROP TABLE IF EXISTS invitations CASCADE`.execute(db)
}
