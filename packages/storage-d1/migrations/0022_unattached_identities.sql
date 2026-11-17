-- CORE408 D3: an identity may be neither own nor a contact's (an unattached identity: a captured address the contact
-- policy did not qualify). The owner rule `own = (contact_id IS NULL)` becomes `own = 0 OR contact_id IS NULL`.
-- D1 cannot alter a CHECK in place, so the table is rebuilt, copying every column, constraint, index and key from 0002.
-- `identities` is a parent (interaction_participants, channel_connections): a rebuild by create-new, copy, drop, rename
-- leaves the deferred foreign-key counter raised by the drop, so the rows go to a side table first and back into a
-- re-created `identities`, whose inserts clear the counter.
PRAGMA defer_foreign_keys = on;

CREATE TABLE identities_backup AS SELECT * FROM identities;
DROP TABLE identities;

CREATE TABLE identities (
  id TEXT PRIMARY KEY NOT NULL
    CHECK (length(id) = 36 AND id NOT GLOB '*[^0-9a-f-]*' AND substr(id, 9, 1) = '-' AND substr(id, 14, 1) = '-' AND substr(id, 19, 1) = '-' AND substr(id, 24, 1) = '-'),
  created_at TEXT NOT NULL CHECK (coalesce(strftime('%Y-%m-%dT%H:%M:%fZ', created_at) = created_at, 0)),
  updated_at TEXT NOT NULL CHECK (coalesce(strftime('%Y-%m-%dT%H:%M:%fZ', updated_at) = updated_at, 0)),
  organization_id TEXT NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  created_by TEXT NOT NULL REFERENCES principals (id),
  deleted_at TEXT CHECK (deleted_at IS NULL OR coalesce(strftime('%Y-%m-%dT%H:%M:%fZ', deleted_at) = deleted_at, 0)),
  kind TEXT NOT NULL,
  value TEXT NOT NULL,
  contact_id TEXT,
  own INTEGER NOT NULL DEFAULT 0 CHECK (own IN (0, 1)),
  CONSTRAINT identities_kind CHECK (kind IN ('email', 'phone')),
  CONSTRAINT identities_own_has_no_contact CHECK (own = 0 OR contact_id IS NULL),
  CONSTRAINT identities_email_ascii_lower CHECK (kind <> 'email' OR (value = lower(value) AND value NOT GLOB '*[^ -~]*')),
  UNIQUE (organization_id, id),
  CONSTRAINT identities_contact_fk FOREIGN KEY (organization_id, contact_id) REFERENCES contacts (organization_id, id)
) STRICT;

INSERT INTO identities (id, created_at, updated_at, organization_id, created_by, deleted_at, kind, value, contact_id, own)
SELECT id, created_at, updated_at, organization_id, created_by, deleted_at, kind, value, contact_id, own FROM identities_backup;
DROP TABLE identities_backup;

CREATE UNIQUE INDEX idx_identities_address_unique ON identities (organization_id, kind, value) WHERE deleted_at IS NULL;
CREATE INDEX idx_identities_contact_id ON identities (contact_id);
