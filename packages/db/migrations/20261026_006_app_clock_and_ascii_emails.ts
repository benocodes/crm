import { sql, type Kysely } from 'kysely'

// [[CORE36]] D2, D7. The application owns every timestamp it writes (one injected clock per unit, on both
// engines), so the `updated_at` trigger goes from every table that has it, together with its function.
// Emails are lowercase ASCII on Postgres exactly as on D1 (citext stays for case-insensitive comparison).
const WITH_UPDATED_AT = ['organizations', 'users', 'memberships', 'agents', 'api_keys', 'tasks', 'companies', 'contacts', 'identities']

export async function up(db: Kysely<any>): Promise<void> {
  for (const t of WITH_UPDATED_AT) await sql`DROP TRIGGER IF EXISTS set_updated_at ON ${sql.table(t)}`.execute(db)
  await sql`DROP FUNCTION app.set_updated_at()`.execute(db)

  await sql`
    ALTER TABLE identities ADD CONSTRAINT identities_email_ascii_lower
      CHECK (kind <> 'email' OR (value = lower(value) AND value ~ '^[ -~]*$'))`.execute(db)
  // users.email is citext, on which `email = lower(email)` is always true: the checks compare as text.
  await sql`
    ALTER TABLE users ADD CONSTRAINT users_email_ascii_lower
      CHECK (email::text = lower(email::text) AND email::text ~ '^[ -~]*$')`.execute(db)
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`ALTER TABLE users DROP CONSTRAINT IF EXISTS users_email_ascii_lower`.execute(db)
  await sql`ALTER TABLE identities DROP CONSTRAINT IF EXISTS identities_email_ascii_lower`.execute(db)
  await sql`
    CREATE FUNCTION app.set_updated_at() RETURNS trigger LANGUAGE plpgsql
    AS $$ BEGIN NEW.updated_at = now(); RETURN NEW; END $$`.execute(db)
  for (const t of WITH_UPDATED_AT) {
    await sql`
      CREATE TRIGGER set_updated_at BEFORE UPDATE ON ${sql.table(t)}
      FOR EACH ROW EXECUTE FUNCTION app.set_updated_at()`.execute(db)
  }
}
