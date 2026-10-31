-- CORE62: associations between built-in records (D1 only, [[CORE62]] D1-D4, D10, D22).
-- An endpoint is a table name plus an id (no FK: SQLite cannot target a dynamic table, D4); the pair is stored once, in
-- canonical order, so the strict tuple CHECK also forbids a self-association (D2). The relation list is closed on purpose:
-- a new relation is a deliberate migration. The type columns are lowercase identifiers, not a list, so custom-object
-- tables need no table rebuild (D10).

CREATE TABLE associations (
  id TEXT PRIMARY KEY NOT NULL
    CHECK (length(id) = 36 AND id NOT GLOB '*[^0-9a-f-]*' AND substr(id, 9, 1) = '-' AND substr(id, 14, 1) = '-' AND substr(id, 19, 1) = '-' AND substr(id, 24, 1) = '-'),
  organization_id TEXT NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  created_by TEXT NOT NULL REFERENCES principals (id),
  created_at TEXT NOT NULL CHECK (coalesce(strftime('%Y-%m-%dT%H:%M:%fZ', created_at) = created_at, 0)),
  a_type TEXT NOT NULL CONSTRAINT associations_a_type_identifier CHECK (length(a_type) > 0 AND a_type NOT GLOB '*[^a-z0-9_]*'),
  a_id TEXT NOT NULL CHECK (length(a_id) = 36 AND a_id NOT GLOB '*[^0-9a-f-]*' AND substr(a_id, 9, 1) = '-' AND substr(a_id, 14, 1) = '-' AND substr(a_id, 19, 1) = '-' AND substr(a_id, 24, 1) = '-'),
  b_type TEXT NOT NULL CONSTRAINT associations_b_type_identifier CHECK (length(b_type) > 0 AND b_type NOT GLOB '*[^a-z0-9_]*'),
  b_id TEXT NOT NULL CHECK (length(b_id) = 36 AND b_id NOT GLOB '*[^0-9a-f-]*' AND substr(b_id, 9, 1) = '-' AND substr(b_id, 14, 1) = '-' AND substr(b_id, 19, 1) = '-' AND substr(b_id, 24, 1) = '-'),
  relation TEXT NOT NULL DEFAULT 'related_to' CONSTRAINT associations_relation CHECK (relation IN ('related_to')),
  updated_at TEXT NOT NULL CHECK (coalesce(strftime('%Y-%m-%dT%H:%M:%fZ', updated_at) = updated_at, 0)),
  deleted_at TEXT CHECK (deleted_at IS NULL OR coalesce(strftime('%Y-%m-%dT%H:%M:%fZ', deleted_at) = deleted_at, 0)),
  CONSTRAINT associations_canonical_order CHECK (a_type < b_type OR (a_type = b_type AND a_id < b_id))
) STRICT;

CREATE UNIQUE INDEX idx_associations_live_unique ON associations (organization_id, a_type, a_id, b_type, b_id, relation) WHERE deleted_at IS NULL;
CREATE INDEX idx_associations_a ON associations (organization_id, a_type, a_id) WHERE deleted_at IS NULL;
CREATE INDEX idx_associations_b ON associations (organization_id, b_type, b_id) WHERE deleted_at IS NULL;
