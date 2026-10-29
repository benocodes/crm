-- D1 schema slice 4 (CORE25 cycle 1): the messaging model. Forward-only, in 0001/0002's conventions (canonical lowercase
-- UUID text, strftime-validated ISO timestamps, 0/1 checked booleans, json_valid text, STRICT tables). The same ten tables
-- and the same constraint NAMES as Postgres migration 008 (D44): composite intra-organisation foreign keys, the live-link
-- partial unique indexes, D31's (organization_id, message_id, thread_id) key and the named vocabulary and shape CHECKs (D54).
-- Append-only (D41): the eight capture tables get a BEFORE UPDATE trigger that aborts with 'append_only'; there is no
-- trigger on DELETE, so the test harness can still clear a database, and none on the two link tables, which are soft-deleted.
-- GLOB patterns stay under D1's 50 byte limit. The sources' connection_id has no foreign key yet (D19).

CREATE TABLE threads (
  id TEXT PRIMARY KEY NOT NULL
    CHECK (length(id) = 36 AND id NOT GLOB '*[^0-9a-f-]*' AND substr(id, 9, 1) = '-' AND substr(id, 14, 1) = '-' AND substr(id, 19, 1) = '-' AND substr(id, 24, 1) = '-'),
  organization_id TEXT NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  created_by TEXT NOT NULL REFERENCES principals (id),
  created_at TEXT NOT NULL CHECK (coalesce(strftime('%Y-%m-%dT%H:%M:%fZ', created_at) = created_at, 0)),
  channel TEXT NOT NULL,
  subject TEXT,
  CONSTRAINT threads_channel CHECK (channel IN ('email')),
  UNIQUE (organization_id, id)
) STRICT;

CREATE TABLE messages (
  id TEXT PRIMARY KEY NOT NULL
    CHECK (length(id) = 36 AND id NOT GLOB '*[^0-9a-f-]*' AND substr(id, 9, 1) = '-' AND substr(id, 14, 1) = '-' AND substr(id, 19, 1) = '-' AND substr(id, 24, 1) = '-'),
  organization_id TEXT NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  created_by TEXT NOT NULL REFERENCES principals (id),
  created_at TEXT NOT NULL CHECK (coalesce(strftime('%Y-%m-%dT%H:%M:%fZ', created_at) = created_at, 0)),
  thread_id TEXT NOT NULL CHECK (length(thread_id) = 36 AND thread_id NOT GLOB '*[^0-9a-f-]*' AND substr(thread_id, 9, 1) = '-' AND substr(thread_id, 14, 1) = '-' AND substr(thread_id, 19, 1) = '-' AND substr(thread_id, 24, 1) = '-'),
  channel TEXT NOT NULL,
  kind TEXT NOT NULL,
  external_id TEXT NOT NULL,
  in_reply_to TEXT,
  author TEXT NOT NULL CHECK (json_valid(author)),
  occurred_at TEXT NOT NULL CHECK (coalesce(strftime('%Y-%m-%dT%H:%M:%fZ', occurred_at) = occurred_at, 0)),
  preview TEXT NOT NULL,
  content_key TEXT,
  version INTEGER NOT NULL,
  retracted_at TEXT CHECK (retracted_at IS NULL OR coalesce(strftime('%Y-%m-%dT%H:%M:%fZ', retracted_at) = retracted_at, 0)),
  CONSTRAINT messages_channel CHECK (channel IN ('email')),
  CONSTRAINT messages_kind CHECK (kind IN ('message', 'reaction')),
  CONSTRAINT messages_content_key CHECK (kind <> 'message' OR content_key IS NOT NULL),
  CONSTRAINT messages_preview_length CHECK (length(preview) <= 200),
  CONSTRAINT messages_version_positive CHECK (version >= 1),
  CONSTRAINT messages_thread_fk FOREIGN KEY (organization_id, thread_id) REFERENCES threads (organization_id, id),
  UNIQUE (organization_id, id),
  UNIQUE (organization_id, id, thread_id)
) STRICT;

CREATE UNIQUE INDEX idx_messages_external_id_unique ON messages (organization_id, channel, external_id);
CREATE INDEX idx_messages_thread_occurred ON messages (organization_id, thread_id, occurred_at, id);
CREATE INDEX idx_messages_occurred ON messages (organization_id, occurred_at, id);

CREATE TABLE files (
  id TEXT PRIMARY KEY NOT NULL
    CHECK (length(id) = 36 AND id NOT GLOB '*[^0-9a-f-]*' AND substr(id, 9, 1) = '-' AND substr(id, 14, 1) = '-' AND substr(id, 19, 1) = '-' AND substr(id, 24, 1) = '-'),
  organization_id TEXT NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  created_by TEXT NOT NULL REFERENCES principals (id),
  created_at TEXT NOT NULL CHECK (coalesce(strftime('%Y-%m-%dT%H:%M:%fZ', created_at) = created_at, 0)),
  name TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  storage_key TEXT NOT NULL,
  CONSTRAINT files_size_nonnegative CHECK (size_bytes >= 0),
  CONSTRAINT files_sha256_hex CHECK (length(sha256) = 64 AND sha256 NOT GLOB '*[^0-9a-f]*'),
  UNIQUE (organization_id, id)
) STRICT;

CREATE INDEX idx_files_sha256 ON files (organization_id, sha256);

CREATE TABLE interactions (
  id TEXT PRIMARY KEY NOT NULL
    CHECK (length(id) = 36 AND id NOT GLOB '*[^0-9a-f-]*' AND substr(id, 9, 1) = '-' AND substr(id, 14, 1) = '-' AND substr(id, 19, 1) = '-' AND substr(id, 24, 1) = '-'),
  organization_id TEXT NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  created_by TEXT NOT NULL REFERENCES principals (id),
  created_at TEXT NOT NULL CHECK (coalesce(strftime('%Y-%m-%dT%H:%M:%fZ', created_at) = created_at, 0)),
  kind TEXT NOT NULL,
  channel TEXT NOT NULL,
  direction TEXT NOT NULL,
  occurred_at TEXT NOT NULL CHECK (coalesce(strftime('%Y-%m-%dT%H:%M:%fZ', occurred_at) = occurred_at, 0)),
  thread_id TEXT CHECK (thread_id IS NULL OR length(thread_id) = 36 AND thread_id NOT GLOB '*[^0-9a-f-]*' AND substr(thread_id, 9, 1) = '-' AND substr(thread_id, 14, 1) = '-' AND substr(thread_id, 19, 1) = '-' AND substr(thread_id, 24, 1) = '-'),
  message_id TEXT CHECK (message_id IS NULL OR length(message_id) = 36 AND message_id NOT GLOB '*[^0-9a-f-]*' AND substr(message_id, 9, 1) = '-' AND substr(message_id, 14, 1) = '-' AND substr(message_id, 19, 1) = '-' AND substr(message_id, 24, 1) = '-'),
  CONSTRAINT interactions_kind CHECK (kind IN ('message', 'reaction')),
  CONSTRAINT interactions_channel CHECK (channel IN ('email')),
  CONSTRAINT interactions_direction CHECK (direction IN ('inbound', 'outbound')),
  CONSTRAINT interactions_kind_pointers CHECK (kind NOT IN ('message', 'reaction') OR (message_id IS NOT NULL AND thread_id IS NOT NULL)),
  CONSTRAINT interactions_thread_fk FOREIGN KEY (organization_id, thread_id) REFERENCES threads (organization_id, id),
  CONSTRAINT interactions_message_fk FOREIGN KEY (organization_id, message_id, thread_id) REFERENCES messages (organization_id, id, thread_id),
  UNIQUE (organization_id, id)
) STRICT;

CREATE UNIQUE INDEX idx_interactions_message_unique ON interactions (organization_id, message_id);
CREATE INDEX idx_interactions_occurred ON interactions (organization_id, occurred_at, id);
CREATE INDEX idx_interactions_thread_occurred ON interactions (organization_id, thread_id, occurred_at);

CREATE TABLE interaction_participants (
  id TEXT PRIMARY KEY NOT NULL
    CHECK (length(id) = 36 AND id NOT GLOB '*[^0-9a-f-]*' AND substr(id, 9, 1) = '-' AND substr(id, 14, 1) = '-' AND substr(id, 19, 1) = '-' AND substr(id, 24, 1) = '-'),
  organization_id TEXT NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  created_by TEXT NOT NULL REFERENCES principals (id),
  created_at TEXT NOT NULL CHECK (coalesce(strftime('%Y-%m-%dT%H:%M:%fZ', created_at) = created_at, 0)),
  interaction_id TEXT NOT NULL CHECK (length(interaction_id) = 36 AND interaction_id NOT GLOB '*[^0-9a-f-]*' AND substr(interaction_id, 9, 1) = '-' AND substr(interaction_id, 14, 1) = '-' AND substr(interaction_id, 19, 1) = '-' AND substr(interaction_id, 24, 1) = '-'),
  identity_id TEXT NOT NULL CHECK (length(identity_id) = 36 AND identity_id NOT GLOB '*[^0-9a-f-]*' AND substr(identity_id, 9, 1) = '-' AND substr(identity_id, 14, 1) = '-' AND substr(identity_id, 19, 1) = '-' AND substr(identity_id, 24, 1) = '-'),
  role TEXT NOT NULL,
  CONSTRAINT interaction_participants_role CHECK (role IN ('from', 'to', 'cc', 'bcc')),
  CONSTRAINT interaction_participants_interaction_fk FOREIGN KEY (organization_id, interaction_id) REFERENCES interactions (organization_id, id),
  CONSTRAINT interaction_participants_identity_fk FOREIGN KEY (organization_id, identity_id) REFERENCES identities (organization_id, id)
) STRICT;

CREATE UNIQUE INDEX idx_interaction_participants_unique ON interaction_participants (organization_id, interaction_id, role, identity_id);
CREATE INDEX idx_interaction_participants_identity ON interaction_participants (organization_id, identity_id, interaction_id);

CREATE TABLE message_attachments (
  id TEXT PRIMARY KEY NOT NULL
    CHECK (length(id) = 36 AND id NOT GLOB '*[^0-9a-f-]*' AND substr(id, 9, 1) = '-' AND substr(id, 14, 1) = '-' AND substr(id, 19, 1) = '-' AND substr(id, 24, 1) = '-'),
  organization_id TEXT NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  created_by TEXT NOT NULL REFERENCES principals (id),
  created_at TEXT NOT NULL CHECK (coalesce(strftime('%Y-%m-%dT%H:%M:%fZ', created_at) = created_at, 0)),
  message_id TEXT NOT NULL CHECK (length(message_id) = 36 AND message_id NOT GLOB '*[^0-9a-f-]*' AND substr(message_id, 9, 1) = '-' AND substr(message_id, 14, 1) = '-' AND substr(message_id, 19, 1) = '-' AND substr(message_id, 24, 1) = '-'),
  position INTEGER NOT NULL,
  file_id TEXT CHECK (file_id IS NULL OR length(file_id) = 36 AND file_id NOT GLOB '*[^0-9a-f-]*' AND substr(file_id, 9, 1) = '-' AND substr(file_id, 14, 1) = '-' AND substr(file_id, 19, 1) = '-' AND substr(file_id, 24, 1) = '-'),
  type TEXT NOT NULL,
  name TEXT,
  mime_type TEXT,
  size_bytes INTEGER,
  inline INTEGER NOT NULL CHECK (inline IN (0, 1)),
  content_id TEXT,
  fetch_status TEXT NOT NULL,
  fetch_metadata TEXT CHECK (fetch_metadata IS NULL OR json_valid(fetch_metadata)),
  fetch_error TEXT,
  CONSTRAINT message_attachments_type CHECK (type IN ('image', 'file', 'video', 'audio')),
  CONSTRAINT message_attachments_fetch_status CHECK (fetch_status IN ('stored', 'pending', 'failed', 'skipped')),
  CONSTRAINT message_attachments_stored_file CHECK ((fetch_status = 'stored') = (file_id IS NOT NULL)),
  CONSTRAINT message_attachments_position_nonnegative CHECK (position >= 0),
  CONSTRAINT message_attachments_size_nonnegative CHECK (size_bytes IS NULL OR size_bytes >= 0),
  CONSTRAINT message_attachments_message_fk FOREIGN KEY (organization_id, message_id) REFERENCES messages (organization_id, id),
  CONSTRAINT message_attachments_file_fk FOREIGN KEY (organization_id, file_id) REFERENCES files (organization_id, id)
) STRICT;

CREATE UNIQUE INDEX idx_message_attachments_position_unique ON message_attachments (organization_id, message_id, position);
CREATE INDEX idx_message_attachments_file ON message_attachments (organization_id, file_id);

-- Provider source tables are machinery (D17), not resources: they map provider ids to ours and carry no events.
CREATE TABLE message_sources (
  id TEXT PRIMARY KEY NOT NULL
    CHECK (length(id) = 36 AND id NOT GLOB '*[^0-9a-f-]*' AND substr(id, 9, 1) = '-' AND substr(id, 14, 1) = '-' AND substr(id, 19, 1) = '-' AND substr(id, 24, 1) = '-'),
  organization_id TEXT NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  created_by TEXT NOT NULL REFERENCES principals (id),
  created_at TEXT NOT NULL CHECK (coalesce(strftime('%Y-%m-%dT%H:%M:%fZ', created_at) = created_at, 0)),
  message_id TEXT NOT NULL CHECK (length(message_id) = 36 AND message_id NOT GLOB '*[^0-9a-f-]*' AND substr(message_id, 9, 1) = '-' AND substr(message_id, 14, 1) = '-' AND substr(message_id, 19, 1) = '-' AND substr(message_id, 24, 1) = '-'),
  connection_id TEXT NOT NULL CHECK (length(connection_id) = 36 AND connection_id NOT GLOB '*[^0-9a-f-]*' AND substr(connection_id, 9, 1) = '-' AND substr(connection_id, 14, 1) = '-' AND substr(connection_id, 19, 1) = '-' AND substr(connection_id, 24, 1) = '-'),
  provider_message_id TEXT NOT NULL,
  provider_thread_id TEXT NOT NULL,
  CONSTRAINT message_sources_message_fk FOREIGN KEY (organization_id, message_id) REFERENCES messages (organization_id, id)
) STRICT;

CREATE UNIQUE INDEX idx_message_sources_provider_unique ON message_sources (organization_id, connection_id, provider_message_id);
CREATE INDEX idx_message_sources_message ON message_sources (organization_id, message_id);

CREATE TABLE thread_sources (
  id TEXT PRIMARY KEY NOT NULL
    CHECK (length(id) = 36 AND id NOT GLOB '*[^0-9a-f-]*' AND substr(id, 9, 1) = '-' AND substr(id, 14, 1) = '-' AND substr(id, 19, 1) = '-' AND substr(id, 24, 1) = '-'),
  organization_id TEXT NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  created_by TEXT NOT NULL REFERENCES principals (id),
  created_at TEXT NOT NULL CHECK (coalesce(strftime('%Y-%m-%dT%H:%M:%fZ', created_at) = created_at, 0)),
  thread_id TEXT NOT NULL CHECK (length(thread_id) = 36 AND thread_id NOT GLOB '*[^0-9a-f-]*' AND substr(thread_id, 9, 1) = '-' AND substr(thread_id, 14, 1) = '-' AND substr(thread_id, 19, 1) = '-' AND substr(thread_id, 24, 1) = '-'),
  connection_id TEXT NOT NULL CHECK (length(connection_id) = 36 AND connection_id NOT GLOB '*[^0-9a-f-]*' AND substr(connection_id, 9, 1) = '-' AND substr(connection_id, 14, 1) = '-' AND substr(connection_id, 19, 1) = '-' AND substr(connection_id, 24, 1) = '-'),
  provider_thread_id TEXT NOT NULL,
  CONSTRAINT thread_sources_thread_fk FOREIGN KEY (organization_id, thread_id) REFERENCES threads (organization_id, id)
) STRICT;

CREATE UNIQUE INDEX idx_thread_sources_provider_unique ON thread_sources (organization_id, connection_id, provider_thread_id);
CREATE INDEX idx_thread_sources_thread ON thread_sources (organization_id, thread_id);

CREATE TABLE contact_files (
  id TEXT PRIMARY KEY NOT NULL
    CHECK (length(id) = 36 AND id NOT GLOB '*[^0-9a-f-]*' AND substr(id, 9, 1) = '-' AND substr(id, 14, 1) = '-' AND substr(id, 19, 1) = '-' AND substr(id, 24, 1) = '-'),
  organization_id TEXT NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  created_by TEXT NOT NULL REFERENCES principals (id),
  created_at TEXT NOT NULL CHECK (coalesce(strftime('%Y-%m-%dT%H:%M:%fZ', created_at) = created_at, 0)),
  contact_id TEXT NOT NULL CHECK (length(contact_id) = 36 AND contact_id NOT GLOB '*[^0-9a-f-]*' AND substr(contact_id, 9, 1) = '-' AND substr(contact_id, 14, 1) = '-' AND substr(contact_id, 19, 1) = '-' AND substr(contact_id, 24, 1) = '-'),
  file_id TEXT NOT NULL CHECK (length(file_id) = 36 AND file_id NOT GLOB '*[^0-9a-f-]*' AND substr(file_id, 9, 1) = '-' AND substr(file_id, 14, 1) = '-' AND substr(file_id, 19, 1) = '-' AND substr(file_id, 24, 1) = '-'),
  updated_at TEXT NOT NULL CHECK (coalesce(strftime('%Y-%m-%dT%H:%M:%fZ', updated_at) = updated_at, 0)),
  deleted_at TEXT CHECK (deleted_at IS NULL OR coalesce(strftime('%Y-%m-%dT%H:%M:%fZ', deleted_at) = deleted_at, 0)),
  CONSTRAINT contact_files_contact_fk FOREIGN KEY (organization_id, contact_id) REFERENCES contacts (organization_id, id),
  CONSTRAINT contact_files_file_fk FOREIGN KEY (organization_id, file_id) REFERENCES files (organization_id, id)
) STRICT;

CREATE UNIQUE INDEX idx_contact_files_live_unique ON contact_files (organization_id, contact_id, file_id) WHERE deleted_at IS NULL;
CREATE INDEX idx_contact_files_file ON contact_files (organization_id, file_id);

CREATE TABLE company_files (
  id TEXT PRIMARY KEY NOT NULL
    CHECK (length(id) = 36 AND id NOT GLOB '*[^0-9a-f-]*' AND substr(id, 9, 1) = '-' AND substr(id, 14, 1) = '-' AND substr(id, 19, 1) = '-' AND substr(id, 24, 1) = '-'),
  organization_id TEXT NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  created_by TEXT NOT NULL REFERENCES principals (id),
  created_at TEXT NOT NULL CHECK (coalesce(strftime('%Y-%m-%dT%H:%M:%fZ', created_at) = created_at, 0)),
  company_id TEXT NOT NULL CHECK (length(company_id) = 36 AND company_id NOT GLOB '*[^0-9a-f-]*' AND substr(company_id, 9, 1) = '-' AND substr(company_id, 14, 1) = '-' AND substr(company_id, 19, 1) = '-' AND substr(company_id, 24, 1) = '-'),
  file_id TEXT NOT NULL CHECK (length(file_id) = 36 AND file_id NOT GLOB '*[^0-9a-f-]*' AND substr(file_id, 9, 1) = '-' AND substr(file_id, 14, 1) = '-' AND substr(file_id, 19, 1) = '-' AND substr(file_id, 24, 1) = '-'),
  updated_at TEXT NOT NULL CHECK (coalesce(strftime('%Y-%m-%dT%H:%M:%fZ', updated_at) = updated_at, 0)),
  deleted_at TEXT CHECK (deleted_at IS NULL OR coalesce(strftime('%Y-%m-%dT%H:%M:%fZ', deleted_at) = deleted_at, 0)),
  CONSTRAINT company_files_company_fk FOREIGN KEY (organization_id, company_id) REFERENCES companies (organization_id, id),
  CONSTRAINT company_files_file_fk FOREIGN KEY (organization_id, file_id) REFERENCES files (organization_id, id)
) STRICT;

CREATE UNIQUE INDEX idx_company_files_live_unique ON company_files (organization_id, company_id, file_id) WHERE deleted_at IS NULL;
CREATE INDEX idx_company_files_file ON company_files (organization_id, file_id);

-- Append-only (D41): an UPDATE of a capture row aborts the statement (and so the batch). Inserts and deletes are untouched.

CREATE TRIGGER threads_append_only BEFORE UPDATE ON threads
BEGIN
  SELECT RAISE(ABORT, 'append_only');
END;

CREATE TRIGGER messages_append_only BEFORE UPDATE ON messages
BEGIN
  SELECT RAISE(ABORT, 'append_only');
END;

CREATE TRIGGER interactions_append_only BEFORE UPDATE ON interactions
BEGIN
  SELECT RAISE(ABORT, 'append_only');
END;

CREATE TRIGGER files_append_only BEFORE UPDATE ON files
BEGIN
  SELECT RAISE(ABORT, 'append_only');
END;

CREATE TRIGGER interaction_participants_append_only BEFORE UPDATE ON interaction_participants
BEGIN
  SELECT RAISE(ABORT, 'append_only');
END;

CREATE TRIGGER message_attachments_append_only BEFORE UPDATE ON message_attachments
BEGIN
  SELECT RAISE(ABORT, 'append_only');
END;

CREATE TRIGGER message_sources_append_only BEFORE UPDATE ON message_sources
BEGIN
  SELECT RAISE(ABORT, 'append_only');
END;

CREATE TRIGGER thread_sources_append_only BEFORE UPDATE ON thread_sources
BEGIN
  SELECT RAISE(ABORT, 'append_only');
END;
