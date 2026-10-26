import { sql, type Kysely } from 'kysely'

// [[CORE40]] P3. The prepared runtime stamps every `updated_at` itself (one injected clock per unit,
// [[CORE36]] D2), and an agent update or a key revoke now moves it. The tenant role could update only
// `agents (name, scopes, disabled_at)` and `api_keys (revoked_at)`, so those writes would fail 42501.
// Widening one column is the reversible direction; nothing else changes (no table, policy or service grant).
export async function up(db: Kysely<any>): Promise<void> {
  await sql`GRANT UPDATE (updated_at) ON agents TO vault_authenticated`.execute(db)
  await sql`GRANT UPDATE (updated_at) ON api_keys TO vault_authenticated`.execute(db)
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`REVOKE UPDATE (updated_at) ON agents, api_keys FROM vault_authenticated`.execute(db)
}
