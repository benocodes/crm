import { sql, type Kysely } from 'kysely'

// [[CORE25]] D41, D44, D45, D54: the messaging model. Eight capture tables (threads, messages, interactions, files,
// interaction participants, message attachments, message sources, thread sources) that are append-only by GRANT, and
// two soft-deleted link tables (contact_files, company_files). Every intra-organisation reference is a composite key
// (invariant 1), every vocabulary and shape rule a NAMED CHECK (the D1 migration 0004 carries the same names), RLS
// enabled and forced in the same migration. No timestamp has a default: the unit clock writes them (CORE36 D2).
//
// Grants: the tenant role gets SELECT, INSERT on every table and nothing else except, on the links, UPDATE of
// (deleted_at, updated_at) - and of contact_id on contact_files, because merge re-points a link to the survivor (D35).
// vault_service gets SELECT only. Nobody gets DELETE.

const CAPTURE = ['threads', 'messages', 'interactions', 'files', 'interaction_participants', 'message_attachments', 'message_sources', 'thread_sources']
const LINKS = ['contact_files', 'company_files']
const ALL = [...CAPTURE, ...LINKS]

/** The columns every table starts with. */
const base = `
  id uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  organization_id uuid NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  created_by uuid NOT NULL REFERENCES principals (id),
  created_at timestamptz NOT NULL`

export async function up(db: Kysely<any>): Promise<void> {
  const run = (text: string) => sql.raw(text).execute(db)

  await run(`
    CREATE TABLE threads (${base},
      channel text NOT NULL,
      subject text,
      CONSTRAINT threads_channel CHECK (channel IN ('email')),
      CONSTRAINT idx_threads_organization_id_id_unique UNIQUE (organization_id, id)
    )`)

  await run(`
    CREATE TABLE messages (${base},
      thread_id uuid NOT NULL,
      channel text NOT NULL,
      kind text NOT NULL,
      external_id text NOT NULL,
      in_reply_to text,
      author jsonb NOT NULL,
      occurred_at timestamptz NOT NULL,
      preview text NOT NULL,
      content_key text,
      version integer NOT NULL,
      retracted_at timestamptz,
      CONSTRAINT messages_channel CHECK (channel IN ('email')),
      CONSTRAINT messages_kind CHECK (kind IN ('message', 'reaction')),
      CONSTRAINT messages_content_key CHECK (kind <> 'message' OR content_key IS NOT NULL),
      CONSTRAINT messages_preview_length CHECK (char_length(preview) <= 200),
      CONSTRAINT messages_version_positive CHECK (version >= 1),
      CONSTRAINT messages_thread_fk FOREIGN KEY (organization_id, thread_id) REFERENCES threads (organization_id, id),
      CONSTRAINT idx_messages_organization_id_id_unique UNIQUE (organization_id, id),
      CONSTRAINT idx_messages_organization_id_id_thread_id_unique UNIQUE (organization_id, id, thread_id)
    )`)
  await run(`CREATE UNIQUE INDEX idx_messages_external_id_unique ON messages (organization_id, channel, external_id)`)
  await run(`CREATE INDEX idx_messages_thread_occurred ON messages (organization_id, thread_id, occurred_at, id)`)
  await run(`CREATE INDEX idx_messages_occurred ON messages (organization_id, occurred_at, id)`)

  await run(`
    CREATE TABLE files (${base},
      name text NOT NULL,
      mime_type text NOT NULL,
      size_bytes bigint NOT NULL,
      sha256 text NOT NULL,
      storage_key text NOT NULL,
      CONSTRAINT files_size_nonnegative CHECK (size_bytes >= 0),
      CONSTRAINT files_sha256_hex CHECK (sha256 ~ '^[0-9a-f]{64}$'),
      CONSTRAINT idx_files_organization_id_id_unique UNIQUE (organization_id, id)
    )`)
  await run(`CREATE INDEX idx_files_sha256 ON files (organization_id, sha256)`)

  await run(`
    CREATE TABLE interactions (${base},
      kind text NOT NULL,
      channel text NOT NULL,
      direction text NOT NULL,
      occurred_at timestamptz NOT NULL,
      thread_id uuid,
      message_id uuid,
      CONSTRAINT interactions_kind CHECK (kind IN ('message', 'reaction')),
      CONSTRAINT interactions_channel CHECK (channel IN ('email')),
      CONSTRAINT interactions_direction CHECK (direction IN ('inbound', 'outbound')),
      CONSTRAINT interactions_kind_pointers CHECK (kind NOT IN ('message', 'reaction') OR (message_id IS NOT NULL AND thread_id IS NOT NULL)),
      CONSTRAINT interactions_thread_fk FOREIGN KEY (organization_id, thread_id) REFERENCES threads (organization_id, id),
      CONSTRAINT interactions_message_fk FOREIGN KEY (organization_id, message_id, thread_id) REFERENCES messages (organization_id, id, thread_id),
      CONSTRAINT idx_interactions_organization_id_id_unique UNIQUE (organization_id, id)
    )`)
  await run(`CREATE UNIQUE INDEX idx_interactions_message_unique ON interactions (organization_id, message_id)`)
  await run(`CREATE INDEX idx_interactions_occurred ON interactions (organization_id, occurred_at, id)`)
  await run(`CREATE INDEX idx_interactions_thread_occurred ON interactions (organization_id, thread_id, occurred_at)`)

  await run(`
    CREATE TABLE interaction_participants (${base},
      interaction_id uuid NOT NULL,
      identity_id uuid NOT NULL,
      role text NOT NULL,
      CONSTRAINT interaction_participants_role CHECK (role IN ('from', 'to', 'cc', 'bcc')),
      CONSTRAINT interaction_participants_interaction_fk FOREIGN KEY (organization_id, interaction_id) REFERENCES interactions (organization_id, id),
      CONSTRAINT interaction_participants_identity_fk FOREIGN KEY (organization_id, identity_id) REFERENCES identities (organization_id, id)
    )`)
  await run(`CREATE UNIQUE INDEX idx_interaction_participants_unique ON interaction_participants (organization_id, interaction_id, role, identity_id)`)
  await run(`CREATE INDEX idx_interaction_participants_identity ON interaction_participants (organization_id, identity_id, interaction_id)`)

  await run(`
    CREATE TABLE message_attachments (${base},
      message_id uuid NOT NULL,
      position integer NOT NULL,
      file_id uuid,
      type text NOT NULL,
      name text,
      mime_type text,
      size_bytes bigint,
      inline boolean NOT NULL,
      content_id text,
      fetch_status text NOT NULL,
      fetch_metadata jsonb,
      fetch_error text,
      CONSTRAINT message_attachments_type CHECK (type IN ('image', 'file', 'video', 'audio')),
      CONSTRAINT message_attachments_fetch_status CHECK (fetch_status IN ('stored', 'pending', 'failed', 'skipped')),
      CONSTRAINT message_attachments_stored_file CHECK ((fetch_status = 'stored') = (file_id IS NOT NULL)),
      CONSTRAINT message_attachments_position_nonnegative CHECK (position >= 0),
      CONSTRAINT message_attachments_size_nonnegative CHECK (size_bytes IS NULL OR size_bytes >= 0),
      CONSTRAINT message_attachments_message_fk FOREIGN KEY (organization_id, message_id) REFERENCES messages (organization_id, id),
      CONSTRAINT message_attachments_file_fk FOREIGN KEY (organization_id, file_id) REFERENCES files (organization_id, id)
    )`)
  await run(`CREATE UNIQUE INDEX idx_message_attachments_position_unique ON message_attachments (organization_id, message_id, position)`)
  await run(`CREATE INDEX idx_message_attachments_file ON message_attachments (organization_id, file_id)`)

  // Provider source tables are machinery (D17): connection_id has no foreign key yet (D19: channel_connections arrive with CHN).
  await run(`
    CREATE TABLE message_sources (${base},
      message_id uuid NOT NULL,
      connection_id uuid NOT NULL,
      provider_message_id text NOT NULL,
      provider_thread_id text NOT NULL,
      CONSTRAINT message_sources_message_fk FOREIGN KEY (organization_id, message_id) REFERENCES messages (organization_id, id)
    )`)
  await run(`CREATE UNIQUE INDEX idx_message_sources_provider_unique ON message_sources (organization_id, connection_id, provider_message_id)`)
  await run(`CREATE INDEX idx_message_sources_message ON message_sources (organization_id, message_id)`)

  await run(`
    CREATE TABLE thread_sources (${base},
      thread_id uuid NOT NULL,
      connection_id uuid NOT NULL,
      provider_thread_id text NOT NULL,
      CONSTRAINT thread_sources_thread_fk FOREIGN KEY (organization_id, thread_id) REFERENCES threads (organization_id, id)
    )`)
  await run(`CREATE UNIQUE INDEX idx_thread_sources_provider_unique ON thread_sources (organization_id, connection_id, provider_thread_id)`)
  await run(`CREATE INDEX idx_thread_sources_thread ON thread_sources (organization_id, thread_id)`)

  for (const [table, parent, parentTable] of [['contact_files', 'contact', 'contacts'], ['company_files', 'company', 'companies']] as const) {
    await run(`
      CREATE TABLE ${table} (${base},
        ${parent}_id uuid NOT NULL,
        file_id uuid NOT NULL,
        updated_at timestamptz NOT NULL,
        deleted_at timestamptz,
        CONSTRAINT ${table}_${parent}_fk FOREIGN KEY (organization_id, ${parent}_id) REFERENCES ${parentTable} (organization_id, id),
        CONSTRAINT ${table}_file_fk FOREIGN KEY (organization_id, file_id) REFERENCES files (organization_id, id)
      )`)
    await run(`CREATE UNIQUE INDEX idx_${table}_live_unique ON ${table} (organization_id, ${parent}_id, file_id) WHERE deleted_at IS NULL`)
    await run(`CREATE INDEX idx_${table}_file ON ${table} (organization_id, file_id)`)
  }

  for (const t of ALL) {
    await sql`ALTER TABLE ${sql.table(t)} ENABLE ROW LEVEL SECURITY`.execute(db)
    await sql`ALTER TABLE ${sql.table(t)} FORCE ROW LEVEL SECURITY`.execute(db)
    await sql`
      CREATE POLICY ${sql.id(`${t}_tenant`)} ON ${sql.table(t)} FOR ALL TO vault_authenticated
      USING (organization_id = app.current_organization_id())
      WITH CHECK (organization_id = app.current_organization_id())`.execute(db)
    await sql`GRANT SELECT, INSERT ON ${sql.table(t)} TO vault_authenticated`.execute(db)
    await sql`GRANT SELECT ON ${sql.table(t)} TO vault_service`.execute(db)
  }
  await sql`GRANT UPDATE (contact_id, deleted_at, updated_at) ON contact_files TO vault_authenticated`.execute(db)
  await sql`GRANT UPDATE (deleted_at, updated_at) ON company_files TO vault_authenticated`.execute(db)
}

export async function down(db: Kysely<any>): Promise<void> {
  for (const t of [...ALL].reverse()) await sql`DROP TABLE IF EXISTS ${sql.table(t)} CASCADE`.execute(db)
}
