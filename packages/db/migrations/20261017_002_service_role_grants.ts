import { sql, type Kysely } from 'kysely'

// Narrows vault_service from ALL on every table to what it does today: look up, insert (seeds, account
// operations, bootstrap) and update (last_used_at). No DELETE/TRUNCATE (soft delete is the default),
// events stay append-only, and Kysely's own tables are owner-only. vault_authenticated is unchanged.
export async function up(db: Kysely<any>): Promise<void> {
  await sql`REVOKE ALL ON ALL TABLES IN SCHEMA public FROM vault_service`.execute(db)
  await sql`GRANT SELECT, INSERT, UPDATE ON organizations, principals, users, memberships, agents, api_keys, tasks TO vault_service`.execute(db)
  await sql`GRANT SELECT, INSERT ON events TO vault_service`.execute(db)
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`GRANT ALL ON ALL TABLES IN SCHEMA public TO vault_service`.execute(db)
}
