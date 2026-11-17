-- CHN421 cycle 1 (D10, D11, D19): the capture tables accept channel 'form', and a form is a message or thread source.
-- D1 cannot alter a CHECK or a column's nullability in place, so the tables are rebuilt, copying every column, constraint, index and
-- append-only trigger from 0004 (sources: 0010). `threads`, `messages` and `interactions` are parents (interaction_participants,
-- message_attachments, the two source tables, action_requests), so by 0022's pattern the rows go to side tables first and back into
-- re-created tables whose inserts clear the deferred foreign-key counter the drops raise. The source tables are leaves and use 0010's
-- create-new, copy, drop, rename. Only the three `channel` CHECKs, the source tables' columns, CHECK and indexes change.
-- `connection_id` becomes nullable and `form_id` is added; exactly one is set (message_sources_one_source). NULLs never conflict in a
-- unique index, so the connection index and the form index stay plain (invariant 3).
PRAGMA defer_foreign_keys = on;

CREATE TABLE threads_backup AS SELECT * FROM threads;
CREATE TABLE messages_backup AS SELECT * FROM messages;
CREATE TABLE interactions_backup AS SELECT * FROM interactions;
DROP TABLE interactions;
DROP TABLE messages;
DROP TABLE threads;

CREATE TABLE threads (
  id TEXT PRIMARY KEY NOT NULL
    CHECK (length(id) = 36 AND id NOT GLOB '*[^0-9a-f-]*' AND substr(id, 9, 1) = '-' AND substr(id, 14, 1) = '-' AND substr(id, 19, 1) = '-' AND substr(id, 24, 1) = '-'),
  organization_id TEXT NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  created_by TEXT NOT NULL REFERENCES principals (id),
  created_at TEXT NOT NULL CHECK (coalesce(strftime('%Y-%m-%dT%H:%M:%fZ', created_at) = created_at, 0)),
  channel TEXT NOT NULL,
  subject TEXT,
  CONSTRAINT threads_channel CHECK (channel IN ('email', 'form')),
  UNIQUE (organization_id, id)
) STRICT;

INSERT INTO threads (id, organization_id, created_by, created_at, channel, subject)
SELECT id, organization_id, created_by, created_at, channel, subject FROM threads_backup;
DROP TABLE threads_backup;

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
  CONSTRAINT messages_channel CHECK (channel IN ('email', 'form')),
  CONSTRAINT messages_kind CHECK (kind IN ('message', 'reaction')),
  CONSTRAINT messages_content_key CHECK (kind <> 'message' OR content_key IS NOT NULL),
  CONSTRAINT messages_preview_length CHECK (length(preview) <= 200),
  CONSTRAINT messages_version_positive CHECK (version >= 1),
  CONSTRAINT messages_thread_fk FOREIGN KEY (organization_id, thread_id) REFERENCES threads (organization_id, id),
  UNIQUE (organization_id, id),
  UNIQUE (organization_id, id, thread_id)
) STRICT;

INSERT INTO messages (id, organization_id, created_by, created_at, thread_id, channel, kind, external_id, in_reply_to, author, occurred_at, preview, content_key, version, retracted_at)
SELECT id, organization_id, created_by, created_at, thread_id, channel, kind, external_id, in_reply_to, author, occurred_at, preview, content_key, version, retracted_at FROM messages_backup;
DROP TABLE messages_backup;

CREATE UNIQUE INDEX idx_messages_external_id_unique ON messages (organization_id, channel, external_id);
CREATE INDEX idx_messages_thread_occurred ON messages (organization_id, thread_id, occurred_at, id);
CREATE INDEX idx_messages_occurred ON messages (organization_id, occurred_at, id);

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
  CONSTRAINT interactions_channel CHECK (channel IN ('email', 'form')),
  CONSTRAINT interactions_direction CHECK (direction IN ('inbound', 'outbound')),
  CONSTRAINT interactions_kind_pointers CHECK (kind NOT IN ('message', 'reaction') OR (message_id IS NOT NULL AND thread_id IS NOT NULL)),
  CONSTRAINT interactions_thread_fk FOREIGN KEY (organization_id, thread_id) REFERENCES threads (organization_id, id),
  CONSTRAINT interactions_message_fk FOREIGN KEY (organization_id, message_id, thread_id) REFERENCES messages (organization_id, id, thread_id),
  UNIQUE (organization_id, id)
) STRICT;

INSERT INTO interactions (id, organization_id, created_by, created_at, kind, channel, direction, occurred_at, thread_id, message_id)
SELECT id, organization_id, created_by, created_at, kind, channel, direction, occurred_at, thread_id, message_id FROM interactions_backup;
DROP TABLE interactions_backup;

CREATE UNIQUE INDEX idx_interactions_message_unique ON interactions (organization_id, message_id);
CREATE INDEX idx_interactions_occurred ON interactions (organization_id, occurred_at, id);
CREATE INDEX idx_interactions_thread_occurred ON interactions (organization_id, thread_id, occurred_at);

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

CREATE TABLE message_sources_new (
  id TEXT PRIMARY KEY NOT NULL
    CHECK (length(id) = 36 AND id NOT GLOB '*[^0-9a-f-]*' AND substr(id, 9, 1) = '-' AND substr(id, 14, 1) = '-' AND substr(id, 19, 1) = '-' AND substr(id, 24, 1) = '-'),
  organization_id TEXT NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  created_by TEXT NOT NULL REFERENCES principals (id),
  created_at TEXT NOT NULL CHECK (coalesce(strftime('%Y-%m-%dT%H:%M:%fZ', created_at) = created_at, 0)),
  message_id TEXT NOT NULL CHECK (length(message_id) = 36 AND message_id NOT GLOB '*[^0-9a-f-]*' AND substr(message_id, 9, 1) = '-' AND substr(message_id, 14, 1) = '-' AND substr(message_id, 19, 1) = '-' AND substr(message_id, 24, 1) = '-'),
  connection_id TEXT CHECK (connection_id IS NULL OR length(connection_id) = 36 AND connection_id NOT GLOB '*[^0-9a-f-]*' AND substr(connection_id, 9, 1) = '-' AND substr(connection_id, 14, 1) = '-' AND substr(connection_id, 19, 1) = '-' AND substr(connection_id, 24, 1) = '-'),
  form_id TEXT CHECK (form_id IS NULL OR length(form_id) = 36 AND form_id NOT GLOB '*[^0-9a-f-]*' AND substr(form_id, 9, 1) = '-' AND substr(form_id, 14, 1) = '-' AND substr(form_id, 19, 1) = '-' AND substr(form_id, 24, 1) = '-'),
  provider_message_id TEXT NOT NULL,
  provider_thread_id TEXT NOT NULL,
  CONSTRAINT message_sources_one_source CHECK ((connection_id IS NULL) <> (form_id IS NULL)),
  CONSTRAINT message_sources_message_fk FOREIGN KEY (organization_id, message_id) REFERENCES messages (organization_id, id),
  CONSTRAINT message_sources_connection_fk FOREIGN KEY (organization_id, connection_id) REFERENCES channel_connections (organization_id, id),
  CONSTRAINT message_sources_form_fk FOREIGN KEY (organization_id, form_id) REFERENCES forms (organization_id, id)
) STRICT;

INSERT INTO message_sources_new (id, organization_id, created_by, created_at, message_id, connection_id, provider_message_id, provider_thread_id)
  SELECT id, organization_id, created_by, created_at, message_id, connection_id, provider_message_id, provider_thread_id FROM message_sources;

DROP TABLE message_sources;
ALTER TABLE message_sources_new RENAME TO message_sources;

CREATE UNIQUE INDEX idx_message_sources_provider_unique ON message_sources (organization_id, connection_id, provider_message_id);
CREATE UNIQUE INDEX idx_message_sources_form_unique ON message_sources (organization_id, form_id, provider_message_id);
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
  connection_id TEXT CHECK (connection_id IS NULL OR length(connection_id) = 36 AND connection_id NOT GLOB '*[^0-9a-f-]*' AND substr(connection_id, 9, 1) = '-' AND substr(connection_id, 14, 1) = '-' AND substr(connection_id, 19, 1) = '-' AND substr(connection_id, 24, 1) = '-'),
  form_id TEXT CHECK (form_id IS NULL OR length(form_id) = 36 AND form_id NOT GLOB '*[^0-9a-f-]*' AND substr(form_id, 9, 1) = '-' AND substr(form_id, 14, 1) = '-' AND substr(form_id, 19, 1) = '-' AND substr(form_id, 24, 1) = '-'),
  provider_thread_id TEXT NOT NULL,
  CONSTRAINT thread_sources_one_source CHECK ((connection_id IS NULL) <> (form_id IS NULL)),
  CONSTRAINT thread_sources_thread_fk FOREIGN KEY (organization_id, thread_id) REFERENCES threads (organization_id, id),
  CONSTRAINT thread_sources_connection_fk FOREIGN KEY (organization_id, connection_id) REFERENCES channel_connections (organization_id, id),
  CONSTRAINT thread_sources_form_fk FOREIGN KEY (organization_id, form_id) REFERENCES forms (organization_id, id)
) STRICT;

INSERT INTO thread_sources_new (id, organization_id, created_by, created_at, thread_id, connection_id, provider_thread_id)
  SELECT id, organization_id, created_by, created_at, thread_id, connection_id, provider_thread_id FROM thread_sources;

DROP TABLE thread_sources;
ALTER TABLE thread_sources_new RENAME TO thread_sources;

CREATE UNIQUE INDEX idx_thread_sources_provider_unique ON thread_sources (organization_id, connection_id, provider_thread_id);
CREATE UNIQUE INDEX idx_thread_sources_form_unique ON thread_sources (organization_id, form_id, provider_thread_id);
CREATE INDEX idx_thread_sources_thread ON thread_sources (organization_id, thread_id);

CREATE TRIGGER thread_sources_append_only BEFORE UPDATE ON thread_sources
BEGIN
  SELECT RAISE(ABORT, 'append_only');
END;
