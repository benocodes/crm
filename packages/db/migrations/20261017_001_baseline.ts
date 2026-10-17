import { sql, type Kysely } from 'kysely'

const TENANT_TABLES = ['memberships', 'agents', 'api_keys', 'events', 'tasks']
const ALL_TABLES = ['organizations', 'principals', 'users', ...TENANT_TABLES]
const WITH_UPDATED_AT = ['organizations', 'users', 'memberships', 'agents', 'api_keys', 'tasks']

export async function up(db: Kysely<any>): Promise<void> {
  // Extensions and the `app` schema with its functions.
  await sql`CREATE EXTENSION IF NOT EXISTS pg_uuidv7`.execute(db)
  await sql`CREATE EXTENSION IF NOT EXISTS citext`.execute(db)
  await sql`CREATE SCHEMA IF NOT EXISTS app`.execute(db)
  await sql`
    CREATE FUNCTION app.current_organization_id() RETURNS uuid LANGUAGE sql STABLE
    AS $$ SELECT NULLIF(current_setting('app.organization_id', true), '')::uuid $$`.execute(db)
  await sql`
    CREATE FUNCTION app.current_principal_id() RETURNS uuid LANGUAGE sql STABLE
    AS $$ SELECT NULLIF(current_setting('app.principal_id', true), '')::uuid $$`.execute(db)
  await sql`
    CREATE FUNCTION app.set_updated_at() RETURNS trigger LANGUAGE plpgsql
    AS $$ BEGIN NEW.updated_at = now(); RETURN NEW; END $$`.execute(db)

  // Roles are cluster-wide: shared by every vault database on the cluster, created idempotently.
  await sql`
    DO $$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'vault_authenticated') THEN
        CREATE ROLE vault_authenticated NOLOGIN NOBYPASSRLS;
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'vault_service') THEN
        CREATE ROLE vault_service NOLOGIN BYPASSRLS;
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'vault_app') THEN
        CREATE ROLE vault_app LOGIN NOINHERIT NOSUPERUSER NOBYPASSRLS;
      END IF;
      ALTER ROLE vault_authenticated NOLOGIN NOBYPASSRLS;
      ALTER ROLE vault_service NOLOGIN BYPASSRLS;
      ALTER ROLE vault_app LOGIN NOINHERIT NOSUPERUSER NOBYPASSRLS;
    END
    $$`.execute(db)
  await sql`GRANT vault_authenticated, vault_service TO vault_app`.execute(db)
  // The owner can SET ROLE to either, so tests can exercise them.
  await sql`GRANT vault_authenticated, vault_service TO CURRENT_USER`.execute(db)

  // Tables, in FK order.
  const uuidv7 = sql`uuid_generate_v7()`
  const now = sql`now()`

  await db.schema
    .createTable('organizations')
    .addColumn('id', 'uuid', (c) => c.primaryKey().defaultTo(uuidv7))
    .addColumn('created_at', 'timestamptz', (c) => c.notNull().defaultTo(now))
    .addColumn('updated_at', 'timestamptz', (c) => c.notNull().defaultTo(now))
    .addColumn('name', 'text', (c) => c.notNull())
    .execute()

  await db.schema
    .createTable('principals')
    .addColumn('id', 'uuid', (c) => c.primaryKey().defaultTo(uuidv7))
    .addColumn('created_at', 'timestamptz', (c) => c.notNull().defaultTo(now))
    .addColumn('kind', 'text', (c) => c.notNull().check(sql`kind IN ('user','agent')`))
    .execute()

  await db.schema
    .createTable('users')
    .addColumn('id', 'uuid', (c) => c.primaryKey().references('principals.id').onDelete('cascade'))
    .addColumn('created_at', 'timestamptz', (c) => c.notNull().defaultTo(now))
    .addColumn('updated_at', 'timestamptz', (c) => c.notNull().defaultTo(now))
    .addColumn('email', sql`citext`, (c) => c.notNull().unique())
    .addColumn('name', 'text')
    .execute()

  await db.schema
    .createTable('memberships')
    .addColumn('id', 'uuid', (c) => c.primaryKey().defaultTo(uuidv7))
    .addColumn('created_at', 'timestamptz', (c) => c.notNull().defaultTo(now))
    .addColumn('updated_at', 'timestamptz', (c) => c.notNull().defaultTo(now))
    .addColumn('organization_id', 'uuid', (c) => c.notNull().references('organizations.id').onDelete('cascade'))
    .addColumn('user_id', 'uuid', (c) => c.notNull().references('users.id').onDelete('cascade'))
    .addColumn('role', 'text', (c) => c.notNull().check(sql`role IN ('owner','member')`))
    .addColumn('created_by', 'uuid', (c) => c.notNull().references('principals.id'))
    .addUniqueConstraint('memberships_organization_id_user_id_key', ['organization_id', 'user_id'])
    .execute()

  await db.schema
    .createTable('agents')
    .addColumn('id', 'uuid', (c) => c.primaryKey().references('principals.id').onDelete('cascade'))
    .addColumn('created_at', 'timestamptz', (c) => c.notNull().defaultTo(now))
    .addColumn('updated_at', 'timestamptz', (c) => c.notNull().defaultTo(now))
    .addColumn('organization_id', 'uuid', (c) => c.notNull().references('organizations.id').onDelete('cascade'))
    .addColumn('name', 'text', (c) => c.notNull())
    .addColumn('scopes', sql`text[]`, (c) => c.notNull().defaultTo(sql`'{}'`))
    .addColumn('disabled_at', 'timestamptz')
    .addColumn('created_by', 'uuid', (c) => c.notNull().references('principals.id'))
    .execute()

  await db.schema
    .createTable('api_keys')
    .addColumn('id', 'uuid', (c) => c.primaryKey().defaultTo(uuidv7))
    .addColumn('created_at', 'timestamptz', (c) => c.notNull().defaultTo(now))
    .addColumn('updated_at', 'timestamptz', (c) => c.notNull().defaultTo(now))
    .addColumn('organization_id', 'uuid', (c) => c.notNull().references('organizations.id').onDelete('cascade'))
    .addColumn('agent_id', 'uuid', (c) => c.notNull().references('agents.id').onDelete('cascade'))
    .addColumn('key_hash', 'text', (c) => c.notNull().unique())
    .addColumn('prefix', 'text', (c) => c.notNull())
    .addColumn('last_used_at', 'timestamptz')
    .addColumn('revoked_at', 'timestamptz')
    .addColumn('expires_at', 'timestamptz')
    .addColumn('created_by', 'uuid', (c) => c.notNull().references('principals.id'))
    .execute()

  await db.schema
    .createTable('events')
    .addColumn('id', 'uuid', (c) => c.primaryKey().defaultTo(uuidv7))
    .addColumn('created_at', 'timestamptz', (c) => c.notNull().defaultTo(now))
    .addColumn('organization_id', 'uuid', (c) => c.notNull().references('organizations.id').onDelete('cascade'))
    .addColumn('type', 'text', (c) => c.notNull())
    .addColumn('resource_type', 'text', (c) => c.notNull())
    .addColumn('resource_id', 'uuid', (c) => c.notNull())
    .addColumn('actor_id', 'uuid', (c) => c.notNull().references('principals.id'))
    .addColumn('before', 'jsonb')
    .addColumn('after', 'jsonb')
    .execute()

  await db.schema
    .createTable('tasks')
    .addColumn('id', 'uuid', (c) => c.primaryKey().defaultTo(uuidv7))
    .addColumn('created_at', 'timestamptz', (c) => c.notNull().defaultTo(now))
    .addColumn('updated_at', 'timestamptz', (c) => c.notNull().defaultTo(now))
    .addColumn('organization_id', 'uuid', (c) => c.notNull().references('organizations.id').onDelete('cascade'))
    .addColumn('title', 'text', (c) => c.notNull())
    .addColumn('notes', 'text')
    .addColumn('status', 'text', (c) => c.notNull().defaultTo('open').check(sql`status IN ('open','done')`))
    .addColumn('due_at', 'timestamptz')
    .addColumn('completed_at', 'timestamptz')
    .addColumn('assignee_id', 'uuid', (c) => c.references('principals.id'))
    .addColumn('created_by', 'uuid', (c) => c.notNull().references('principals.id'))
    .addColumn('deleted_at', 'timestamptz')
    .execute()

  // Indexes (no index on principals-FK columns beyond the plan's; add when a query needs them).
  await db.schema.createIndex('idx_events_organization_id_id').on('events').columns(['organization_id', 'id']).execute()
  await db.schema.createIndex('idx_tasks_organization_id_id').on('tasks').columns(['organization_id', 'id']).execute()

  // updated_at triggers.
  for (const t of WITH_UPDATED_AT) {
    await sql`
      CREATE TRIGGER set_updated_at BEFORE UPDATE ON ${sql.table(t)}
      FOR EACH ROW EXECUTE FUNCTION app.set_updated_at()`.execute(db)
  }

  // Grants.
  await sql`GRANT USAGE ON SCHEMA public, app TO vault_authenticated, vault_service`.execute(db)
  await sql`GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA app TO vault_authenticated, vault_service`.execute(db)
  await sql`GRANT ALL ON ALL TABLES IN SCHEMA public TO vault_service`.execute(db)
  await sql`GRANT SELECT ON organizations, principals, users, memberships, agents TO vault_authenticated`.execute(db)
  await sql`GRANT SELECT, INSERT ON events TO vault_authenticated`.execute(db)
  await sql`GRANT SELECT, INSERT, UPDATE ON tasks TO vault_authenticated`.execute(db)

  // RLS on every table, forced for the owner too.
  for (const t of ALL_TABLES) {
    await sql`ALTER TABLE ${sql.table(t)} ENABLE ROW LEVEL SECURITY`.execute(db)
    await sql`ALTER TABLE ${sql.table(t)} FORCE ROW LEVEL SECURITY`.execute(db)
  }

  await sql`
    CREATE POLICY organizations_tenant ON organizations FOR SELECT TO vault_authenticated
    USING (id = app.current_organization_id())`.execute(db)
  await sql`
    CREATE POLICY principals_tenant ON principals FOR SELECT TO vault_authenticated
    USING (
      EXISTS (SELECT 1 FROM memberships m WHERE m.user_id = principals.id AND m.organization_id = app.current_organization_id())
      OR EXISTS (SELECT 1 FROM agents a WHERE a.id = principals.id AND a.organization_id = app.current_organization_id())
    )`.execute(db)
  await sql`
    CREATE POLICY users_tenant ON users FOR SELECT TO vault_authenticated
    USING (EXISTS (SELECT 1 FROM memberships m WHERE m.user_id = users.id AND m.organization_id = app.current_organization_id()))`.execute(db)
  for (const t of TENANT_TABLES) {
    await sql`
      CREATE POLICY ${sql.id(`${t}_tenant`)} ON ${sql.table(t)} FOR ALL TO vault_authenticated
      USING (organization_id = app.current_organization_id())
      WITH CHECK (organization_id = app.current_organization_id())`.execute(db)
  }
}

export async function down(db: Kysely<any>): Promise<void> {
  // Roles (vault_authenticated, vault_service, vault_app) are deliberately NOT dropped: they are
  // cluster-wide and shared by every vault database on the cluster (dev, test, each worktree).
  for (const t of [...ALL_TABLES].reverse()) await sql`DROP TABLE IF EXISTS ${sql.table(t)} CASCADE`.execute(db)
  await sql`DROP SCHEMA IF EXISTS app CASCADE`.execute(db)
}
