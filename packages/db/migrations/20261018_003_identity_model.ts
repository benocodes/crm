import { sql, type Kysely } from 'kysely'

const TABLES = ['companies', 'contacts', 'identities']
const uuidv7 = sql`uuid_generate_v7()`
const now = sql`now()`

export async function up(db: Kysely<any>): Promise<void> {
  const common = <T extends string>(name: T) =>
    db.schema
      .createTable(name)
      .addColumn('id', 'uuid', (c) => c.primaryKey().defaultTo(uuidv7))
      .addColumn('created_at', 'timestamptz', (c) => c.notNull().defaultTo(now))
      .addColumn('updated_at', 'timestamptz', (c) => c.notNull().defaultTo(now))
      .addColumn('organization_id', 'uuid', (c) => c.notNull().references('organizations.id').onDelete('cascade'))
      .addColumn('created_by', 'uuid', (c) => c.notNull().references('principals.id'))
      .addColumn('deleted_at', 'timestamptz')

  await common('companies')
    .addColumn('name', 'text', (c) => c.notNull())
    .addColumn('domain', sql`citext`)
    .addUniqueConstraint('idx_companies_organization_id_id_unique', ['organization_id', 'id'])
    .execute()
  await sql`
    CREATE UNIQUE INDEX idx_companies_domain_unique ON companies (organization_id, domain)
    WHERE deleted_at IS NULL AND domain IS NOT NULL`.execute(db)

  await common('contacts')
    .addColumn('name', 'text')
    .addColumn('company_id', 'uuid')
    .addColumn('merged_into_id', 'uuid')
    .addUniqueConstraint('idx_contacts_organization_id_id_unique', ['organization_id', 'id'])
    .addCheckConstraint('contacts_merged_is_deleted', sql`merged_into_id IS NULL OR deleted_at IS NOT NULL`)
    .addCheckConstraint('contacts_not_merged_into_self', sql`merged_into_id <> id`)
    .execute()
  await sql`
    ALTER TABLE contacts
      ADD CONSTRAINT contacts_company_fk FOREIGN KEY (organization_id, company_id) REFERENCES companies (organization_id, id),
      ADD CONSTRAINT contacts_merged_into_fk FOREIGN KEY (organization_id, merged_into_id) REFERENCES contacts (organization_id, id)`.execute(db)
  await db.schema.createIndex('idx_contacts_organization_id_company_id').on('contacts').columns(['organization_id', 'company_id']).execute()

  await common('identities')
    .addColumn('kind', 'text', (c) => c.notNull())
    .addColumn('value', 'text', (c) => c.notNull())
    .addColumn('contact_id', 'uuid')
    .addColumn('own', 'boolean', (c) => c.notNull().defaultTo(false))
    .addCheckConstraint('identities_kind', sql`kind IN ('email','phone')`)
    .addCheckConstraint('identities_own_xor_contact', sql`own = (contact_id IS NULL)`)
    .addUniqueConstraint('idx_identities_organization_id_id_unique', ['organization_id', 'id'])
    .execute()
  await sql`
    ALTER TABLE identities
      ADD CONSTRAINT identities_contact_fk FOREIGN KEY (organization_id, contact_id) REFERENCES contacts (organization_id, id)`.execute(db)
  await sql`
    CREATE UNIQUE INDEX idx_identities_address_unique ON identities (organization_id, kind, value)
    WHERE deleted_at IS NULL`.execute(db)
  await db.schema.createIndex('idx_identities_contact_id').on('identities').column('contact_id').execute()

  for (const t of TABLES) {
    await sql`
      CREATE TRIGGER set_updated_at BEFORE UPDATE ON ${sql.table(t)}
      FOR EACH ROW EXECUTE FUNCTION app.set_updated_at()`.execute(db)
    await sql`GRANT SELECT, INSERT, UPDATE ON ${sql.table(t)} TO vault_authenticated, vault_service`.execute(db)
    await sql`ALTER TABLE ${sql.table(t)} ENABLE ROW LEVEL SECURITY`.execute(db)
    await sql`ALTER TABLE ${sql.table(t)} FORCE ROW LEVEL SECURITY`.execute(db)
    await sql`
      CREATE POLICY ${sql.id(`${t}_tenant`)} ON ${sql.table(t)} FOR ALL TO vault_authenticated
      USING (organization_id = app.current_organization_id())
      WITH CHECK (organization_id = app.current_organization_id())`.execute(db)
  }
}

export async function down(db: Kysely<any>): Promise<void> {
  for (const t of ['identities', 'contacts', 'companies']) await sql`DROP TABLE IF EXISTS ${sql.table(t)} CASCADE`.execute(db)
}
