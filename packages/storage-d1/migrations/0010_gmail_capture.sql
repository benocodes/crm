-- CHN5 cycle 2 (CHN140; D3, D4, D22, D27, D30, D31, D41): the Gmail connection and its machinery (D1 only).
-- `channel_connections` is the one resource: a grant to one Google account, owned by a user. The four machinery tables (the credential,
-- the Gmail watch, the sync state and the cursor) are not resources and emit no events; nothing exposes them. The credential holds the
-- refresh token only as AES-256-GCM ciphertext (base64url text of iv || ciphertext || tag) with the version of the key that sealed it.
-- `message_sources` and `thread_sources` are rebuilt to gain the foreign key to the connection (D1 cannot add one in place): CORE25
-- left `connection_id` a plain column until this table exists. No deployed database holds source rows (no connection could exist
-- before this migration), so the copy is empty in practice; a row that did exist would fail the key check and abort the migration.

CREATE TABLE channel_connections (
  id TEXT PRIMARY KEY NOT NULL
    CHECK (length(id) = 36 AND id NOT GLOB '*[^0-9a-f-]*' AND substr(id, 9, 1) = '-' AND substr(id, 14, 1) = '-' AND substr(id, 19, 1) = '-' AND substr(id, 24, 1) = '-'),
  created_at TEXT NOT NULL CHECK (coalesce(strftime('%Y-%m-%dT%H:%M:%fZ', created_at) = created_at, 0)),
  updated_at TEXT NOT NULL CHECK (coalesce(strftime('%Y-%m-%dT%H:%M:%fZ', updated_at) = updated_at, 0)),
  organization_id TEXT NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  created_by TEXT NOT NULL REFERENCES principals (id),
  deleted_at TEXT CHECK (deleted_at IS NULL OR coalesce(strftime('%Y-%m-%dT%H:%M:%fZ', deleted_at) = deleted_at, 0)),
  provider TEXT NOT NULL CONSTRAINT channel_connections_provider CHECK (provider IN ('google')),
  account_id TEXT NOT NULL CONSTRAINT channel_connections_account_id CHECK (length(account_id) > 0),
  identity_id TEXT NOT NULL,
  owner_id TEXT NOT NULL REFERENCES users (id),
  status TEXT NOT NULL CONSTRAINT channel_connections_status CHECK (status IN ('active', 'reauth_required', 'suspended')),
  granted_scopes TEXT NOT NULL CONSTRAINT channel_connections_granted_scopes CHECK (json_valid(granted_scopes) AND json_type(granted_scopes) = 'array'),
  connected_at TEXT NOT NULL CHECK (coalesce(strftime('%Y-%m-%dT%H:%M:%fZ', connected_at) = connected_at, 0)),
  UNIQUE (organization_id, id),
  CONSTRAINT channel_connections_identity_fk FOREIGN KEY (organization_id, identity_id) REFERENCES identities (organization_id, id)
) STRICT;

CREATE UNIQUE INDEX idx_channel_connections_live_account ON channel_connections (organization_id, provider, account_id) WHERE deleted_at IS NULL;
CREATE INDEX idx_channel_connections_owner ON channel_connections (owner_id);

CREATE TABLE channel_credentials (
  id TEXT PRIMARY KEY NOT NULL
    CHECK (length(id) = 36 AND id NOT GLOB '*[^0-9a-f-]*' AND substr(id, 9, 1) = '-' AND substr(id, 14, 1) = '-' AND substr(id, 19, 1) = '-' AND substr(id, 24, 1) = '-'),
  organization_id TEXT NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  created_by TEXT NOT NULL REFERENCES principals (id),
  created_at TEXT NOT NULL CHECK (coalesce(strftime('%Y-%m-%dT%H:%M:%fZ', created_at) = created_at, 0)),
  connection_id TEXT NOT NULL,
  refresh_token_ciphertext TEXT NOT NULL CHECK (length(refresh_token_ciphertext) > 0),
  key_version INTEGER NOT NULL CHECK (key_version >= 1),
  CONSTRAINT channel_credentials_connection_fk FOREIGN KEY (organization_id, connection_id) REFERENCES channel_connections (organization_id, id)
) STRICT;

CREATE INDEX idx_channel_credentials_connection ON channel_credentials (organization_id, connection_id, created_at);

CREATE TABLE gmail_watches (
  connection_id TEXT PRIMARY KEY NOT NULL
    CHECK (length(connection_id) = 36 AND connection_id NOT GLOB '*[^0-9a-f-]*' AND substr(connection_id, 9, 1) = '-' AND substr(connection_id, 14, 1) = '-' AND substr(connection_id, 19, 1) = '-' AND substr(connection_id, 24, 1) = '-'),
  organization_id TEXT NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  created_by TEXT NOT NULL REFERENCES principals (id),
  created_at TEXT NOT NULL CHECK (coalesce(strftime('%Y-%m-%dT%H:%M:%fZ', created_at) = created_at, 0)),
  mailbox TEXT NOT NULL CONSTRAINT gmail_watches_mailbox CHECK (mailbox = lower(mailbox) AND length(mailbox) > 0),
  expires_at TEXT NOT NULL CHECK (coalesce(strftime('%Y-%m-%dT%H:%M:%fZ', expires_at) = expires_at, 0)),
  CONSTRAINT gmail_watches_connection_fk FOREIGN KEY (organization_id, connection_id) REFERENCES channel_connections (organization_id, id)
) STRICT;

CREATE INDEX idx_gmail_watches_mailbox ON gmail_watches (mailbox);

CREATE TABLE mail_sync_state (
  connection_id TEXT PRIMARY KEY NOT NULL
    CHECK (length(connection_id) = 36 AND connection_id NOT GLOB '*[^0-9a-f-]*' AND substr(connection_id, 9, 1) = '-' AND substr(connection_id, 14, 1) = '-' AND substr(connection_id, 19, 1) = '-' AND substr(connection_id, 24, 1) = '-'),
  organization_id TEXT NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  created_by TEXT NOT NULL REFERENCES principals (id),
  created_at TEXT NOT NULL CHECK (coalesce(strftime('%Y-%m-%dT%H:%M:%fZ', created_at) = created_at, 0)),
  sync_requested_at TEXT CHECK (sync_requested_at IS NULL OR coalesce(strftime('%Y-%m-%dT%H:%M:%fZ', sync_requested_at) = sync_requested_at, 0)),
  lease_until TEXT CHECK (lease_until IS NULL OR coalesce(strftime('%Y-%m-%dT%H:%M:%fZ', lease_until) = lease_until, 0)),
  run_id TEXT,
  last_success_at TEXT CHECK (last_success_at IS NULL OR coalesce(strftime('%Y-%m-%dT%H:%M:%fZ', last_success_at) = last_success_at, 0)),
  last_error_code TEXT,
  last_error_at TEXT CHECK (last_error_at IS NULL OR coalesce(strftime('%Y-%m-%dT%H:%M:%fZ', last_error_at) = last_error_at, 0)),
  CONSTRAINT mail_sync_state_connection_fk FOREIGN KEY (organization_id, connection_id) REFERENCES channel_connections (organization_id, id)
) STRICT;

CREATE TABLE mail_sync_cursors (
  connection_id TEXT PRIMARY KEY NOT NULL
    CHECK (length(connection_id) = 36 AND connection_id NOT GLOB '*[^0-9a-f-]*' AND substr(connection_id, 9, 1) = '-' AND substr(connection_id, 14, 1) = '-' AND substr(connection_id, 19, 1) = '-' AND substr(connection_id, 24, 1) = '-'),
  organization_id TEXT NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  created_by TEXT NOT NULL REFERENCES principals (id),
  created_at TEXT NOT NULL CHECK (coalesce(strftime('%Y-%m-%dT%H:%M:%fZ', created_at) = created_at, 0)),
  history_id TEXT NOT NULL CHECK (length(history_id) > 0),
  page_token TEXT,
  last_synced_at TEXT CHECK (last_synced_at IS NULL OR coalesce(strftime('%Y-%m-%dT%H:%M:%fZ', last_synced_at) = last_synced_at, 0)),
  CONSTRAINT mail_sync_cursors_connection_fk FOREIGN KEY (organization_id, connection_id) REFERENCES channel_connections (organization_id, id)
) STRICT;

-- The source tables, rebuilt with the connection foreign key (D27). Same columns, indexes and append-only triggers as 0004; the
-- triggers and indexes go with the dropped tables, so they are re-created. Nothing references the source tables.
PRAGMA defer_foreign_keys = on;

CREATE TABLE message_sources_new (
  id TEXT PRIMARY KEY NOT NULL
    CHECK (length(id) = 36 AND id NOT GLOB '*[^0-9a-f-]*' AND substr(id, 9, 1) = '-' AND substr(id, 14, 1) = '-' AND substr(id, 19, 1) = '-' AND substr(id, 24, 1) = '-'),
  organization_id TEXT NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  created_by TEXT NOT NULL REFERENCES principals (id),
  created_at TEXT NOT NULL CHECK (coalesce(strftime('%Y-%m-%dT%H:%M:%fZ', created_at) = created_at, 0)),
  message_id TEXT NOT NULL CHECK (length(message_id) = 36 AND message_id NOT GLOB '*[^0-9a-f-]*' AND substr(message_id, 9, 1) = '-' AND substr(message_id, 14, 1) = '-' AND substr(message_id, 19, 1) = '-' AND substr(message_id, 24, 1) = '-'),
  connection_id TEXT NOT NULL CHECK (length(connection_id) = 36 AND connection_id NOT GLOB '*[^0-9a-f-]*' AND substr(connection_id, 9, 1) = '-' AND substr(connection_id, 14, 1) = '-' AND substr(connection_id, 19, 1) = '-' AND substr(connection_id, 24, 1) = '-'),
  provider_message_id TEXT NOT NULL,
  provider_thread_id TEXT NOT NULL,
  CONSTRAINT message_sources_message_fk FOREIGN KEY (organization_id, message_id) REFERENCES messages (organization_id, id),
  CONSTRAINT message_sources_connection_fk FOREIGN KEY (organization_id, connection_id) REFERENCES channel_connections (organization_id, id)
) STRICT;

INSERT INTO message_sources_new (id, organization_id, created_by, created_at, message_id, connection_id, provider_message_id, provider_thread_id)
  SELECT id, organization_id, created_by, created_at, message_id, connection_id, provider_message_id, provider_thread_id FROM message_sources;

DROP TABLE message_sources;
ALTER TABLE message_sources_new RENAME TO message_sources;

CREATE UNIQUE INDEX idx_message_sources_provider_unique ON message_sources (organization_id, connection_id, provider_message_id);
CREATE INDEX idx_message_sources_message ON message_sources (organization_id, message_id);

CREATE TRIGGER message_sources_append_only BEFORE UPDATE ON message_sources
BEGIN
  SELECT RAISE(ABORT, 'append_only');
END;

CREATE TABLE thread_sources_new (
  id TEXT PRIMARY KEY NOT NULL
    CHECK (length(id) = 36 AND id NOT GLOB '*[^0-9a-f-]*' AND substr(id, 9, 1) = '-' AND substr(id, 14, 1) = '-' AND substr(id, 19, 1) = '-' AND substr(id, 24, 1) = '-'),
  organization_id TEXT NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  created_by TEXT NOT NULL REFERENCES principals (id),
  created_at TEXT NOT NULL CHECK (coalesce(strftime('%Y-%m-%dT%H:%M:%fZ', created_at) = created_at, 0)),
  thread_id TEXT NOT NULL CHECK (length(thread_id) = 36 AND thread_id NOT GLOB '*[^0-9a-f-]*' AND substr(thread_id, 9, 1) = '-' AND substr(thread_id, 14, 1) = '-' AND substr(thread_id, 19, 1) = '-' AND substr(thread_id, 24, 1) = '-'),
  connection_id TEXT NOT NULL CHECK (length(connection_id) = 36 AND connection_id NOT GLOB '*[^0-9a-f-]*' AND substr(connection_id, 9, 1) = '-' AND substr(connection_id, 14, 1) = '-' AND substr(connection_id, 19, 1) = '-' AND substr(connection_id, 24, 1) = '-'),
  provider_thread_id TEXT NOT NULL,
  CONSTRAINT thread_sources_thread_fk FOREIGN KEY (organization_id, thread_id) REFERENCES threads (organization_id, id),
  CONSTRAINT thread_sources_connection_fk FOREIGN KEY (organization_id, connection_id) REFERENCES channel_connections (organization_id, id)
) STRICT;

INSERT INTO thread_sources_new (id, organization_id, created_by, created_at, thread_id, connection_id, provider_thread_id)
  SELECT id, organization_id, created_by, created_at, thread_id, connection_id, provider_thread_id FROM thread_sources;

DROP TABLE thread_sources;
ALTER TABLE thread_sources_new RENAME TO thread_sources;

CREATE UNIQUE INDEX idx_thread_sources_provider_unique ON thread_sources (organization_id, connection_id, provider_thread_id);
CREATE INDEX idx_thread_sources_thread ON thread_sources (organization_id, thread_id);

CREATE TRIGGER thread_sources_append_only BEFORE UPDATE ON thread_sources
BEGIN
  SELECT RAISE(ABORT, 'append_only');
END;
