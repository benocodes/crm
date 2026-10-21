import { sql, type Kysely } from 'kysely'

export async function up(db: Kysely<any>): Promise<void> {
  await sql`
    ALTER TABLE users
      ADD COLUMN auth_provider text,
      ADD COLUMN auth_subject text,
      ADD COLUMN email_verified boolean NOT NULL DEFAULT false,
      ADD CONSTRAINT users_auth_pair CHECK ((auth_provider IS NULL) = (auth_subject IS NULL)),
      ADD CONSTRAINT users_auth_provider_subject_key UNIQUE (auth_provider, auth_subject)`.execute(db)

  await sql`ALTER TABLE memberships ADD COLUMN deleted_at timestamptz`.execute(db)
  await sql`ALTER TABLE memberships DROP CONSTRAINT memberships_organization_id_user_id_key`.execute(db)
  await sql`
    CREATE UNIQUE INDEX idx_memberships_live_unique ON memberships (organization_id, user_id)
    WHERE deleted_at IS NULL`.execute(db)
  await sql`CREATE INDEX idx_memberships_user_id ON memberships (user_id) WHERE deleted_at IS NULL`.execute(db)
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`DROP INDEX idx_memberships_user_id`.execute(db)
  await sql`DROP INDEX idx_memberships_live_unique`.execute(db)
  await sql`ALTER TABLE memberships DROP COLUMN deleted_at`.execute(db)
  await sql`ALTER TABLE memberships ADD CONSTRAINT memberships_organization_id_user_id_key UNIQUE (organization_id, user_id)`.execute(db)
  await sql`
    ALTER TABLE users
      DROP CONSTRAINT users_auth_provider_subject_key,
      DROP CONSTRAINT users_auth_pair,
      DROP COLUMN email_verified,
      DROP COLUMN auth_subject,
      DROP COLUMN auth_provider`.execute(db)
}
