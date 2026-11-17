-- CHN406 cycle 1 (D1, D2, D8, D12, D14): the capture settings of a Gmail connection, stored and readable, applied by nothing yet (CHN407 and CORE408 apply them).
-- The three scalar settings are typed columns on `channel_connections`; the two list settings are child tables with a composite foreign key to it; the workspace
-- blocklist is its own table, `blocked_senders` (its operations arrive with CHN410, so nothing writes it yet). Every existing connection, live or soft-deleted,
-- gets the label rows INBOX and SENT, so the defaults state what capture does today (CHN5 D5) and the label list is never empty. No mail_sync_*, credential or watch table is touched.
-- A value is stored trimmed and lowercased (the checks hold whatever writes the table); an address has an `@` past its first character, a domain has none (D7's normalisers are CHN409's).

ALTER TABLE channel_connections ADD COLUMN exclude_group_addresses INTEGER NOT NULL DEFAULT 0 CONSTRAINT channel_connections_exclude_group_addresses CHECK (exclude_group_addresses IN (0, 1));
ALTER TABLE channel_connections ADD COLUMN exclude_personal_domains INTEGER NOT NULL DEFAULT 0 CONSTRAINT channel_connections_exclude_personal_domains CHECK (exclude_personal_domains IN (0, 1));
ALTER TABLE channel_connections ADD COLUMN contact_creation TEXT NOT NULL DEFAULT 'sent_and_received' CONSTRAINT channel_connections_contact_creation CHECK (contact_creation IN ('sent_and_received', 'sent', 'none'));

CREATE TABLE connection_capture_labels (
  id TEXT PRIMARY KEY NOT NULL
    CHECK (length(id) = 36 AND id NOT GLOB '*[^0-9a-f-]*' AND substr(id, 9, 1) = '-' AND substr(id, 14, 1) = '-' AND substr(id, 19, 1) = '-' AND substr(id, 24, 1) = '-'),
  organization_id TEXT NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  connection_id TEXT NOT NULL,
  label_id TEXT NOT NULL CONSTRAINT connection_capture_labels_label_id CHECK (length(label_id) BETWEEN 1 AND 100 AND label_id NOT GLOB '*[^A-Za-z0-9_-]*'),
  created_at TEXT NOT NULL CHECK (coalesce(strftime('%Y-%m-%dT%H:%M:%fZ', created_at) = created_at, 0)),
  CONSTRAINT connection_capture_labels_connection_fk FOREIGN KEY (organization_id, connection_id) REFERENCES channel_connections (organization_id, id),
  CONSTRAINT connection_capture_labels_unique UNIQUE (connection_id, label_id)
) STRICT;

CREATE TABLE connection_blocked_senders (
  id TEXT PRIMARY KEY NOT NULL
    CHECK (length(id) = 36 AND id NOT GLOB '*[^0-9a-f-]*' AND substr(id, 9, 1) = '-' AND substr(id, 14, 1) = '-' AND substr(id, 19, 1) = '-' AND substr(id, 24, 1) = '-'),
  organization_id TEXT NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  connection_id TEXT NOT NULL,
  kind TEXT NOT NULL CONSTRAINT connection_blocked_senders_kind CHECK (kind IN ('address', 'domain')),
  value TEXT NOT NULL CONSTRAINT connection_blocked_senders_value CHECK (value = lower(value) AND value = trim(value) AND length(value) > 0 AND ((kind = 'address' AND instr(value, '@') > 1) OR (kind = 'domain' AND instr(value, '@') = 0))),
  created_at TEXT NOT NULL CHECK (coalesce(strftime('%Y-%m-%dT%H:%M:%fZ', created_at) = created_at, 0)),
  CONSTRAINT connection_blocked_senders_connection_fk FOREIGN KEY (organization_id, connection_id) REFERENCES channel_connections (organization_id, id),
  CONSTRAINT connection_blocked_senders_unique UNIQUE (connection_id, kind, value)
) STRICT;

CREATE TABLE blocked_senders (
  id TEXT PRIMARY KEY NOT NULL
    CHECK (length(id) = 36 AND id NOT GLOB '*[^0-9a-f-]*' AND substr(id, 9, 1) = '-' AND substr(id, 14, 1) = '-' AND substr(id, 19, 1) = '-' AND substr(id, 24, 1) = '-'),
  created_at TEXT NOT NULL CHECK (coalesce(strftime('%Y-%m-%dT%H:%M:%fZ', created_at) = created_at, 0)),
  updated_at TEXT NOT NULL CHECK (coalesce(strftime('%Y-%m-%dT%H:%M:%fZ', updated_at) = updated_at, 0)),
  organization_id TEXT NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  created_by TEXT NOT NULL REFERENCES principals (id),
  deleted_at TEXT CHECK (deleted_at IS NULL OR coalesce(strftime('%Y-%m-%dT%H:%M:%fZ', deleted_at) = deleted_at, 0)),
  kind TEXT NOT NULL CONSTRAINT blocked_senders_kind CHECK (kind IN ('address', 'domain')),
  value TEXT NOT NULL CONSTRAINT blocked_senders_value CHECK (value = lower(value) AND value = trim(value) AND length(value) > 0 AND ((kind = 'address' AND instr(value, '@') > 1) OR (kind = 'domain' AND instr(value, '@') = 0)))
) STRICT;

-- At most one live entry per (organisation, kind, value); a soft-deleted twin is allowed, so an entry can be blocked again after it was lifted.
CREATE UNIQUE INDEX idx_blocked_senders_live ON blocked_senders (organization_id, kind, value) WHERE deleted_at IS NULL;

-- Backfill: INBOX and SENT for every connection, live or deleted (D4, D12). Ids are UUIDv7-shaped (millisecond clock, version 7, variant 8-b, random tail), as the id check wants.
INSERT INTO connection_capture_labels (id, organization_id, connection_id, label_id, created_at)
SELECT
  printf('%08x-%04x-7%s-%s%s-%s',
    ((CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)) >> 16) & 4294967295,
    (CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)) & 65535,
    substr(lower(hex(randomblob(2))), 2, 3),
    substr('89ab', 1 + (abs(random()) % 4), 1),
    substr(lower(hex(randomblob(2))), 2, 3),
    lower(hex(randomblob(6)))),
  c.organization_id, c.id, l.label_id, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
FROM channel_connections c
CROSS JOIN (SELECT 'INBOX' AS label_id UNION ALL SELECT 'SENT') l;
