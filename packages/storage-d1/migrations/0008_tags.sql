-- CORE129: tags (D1 only, D2, D4, D5). A tag is a named list; membership is an `associations` edge, so the table holds only the list itself.
-- `name` compares case-insensitively through its NOCASE collation (ASCII folding) and is unique among live tags per organisation.

CREATE TABLE tags (
  id TEXT PRIMARY KEY NOT NULL
    CHECK (length(id) = 36 AND id NOT GLOB '*[^0-9a-f-]*' AND substr(id, 9, 1) = '-' AND substr(id, 14, 1) = '-' AND substr(id, 19, 1) = '-' AND substr(id, 24, 1) = '-'),
  created_at TEXT NOT NULL CHECK (coalesce(strftime('%Y-%m-%dT%H:%M:%fZ', created_at) = created_at, 0)),
  updated_at TEXT NOT NULL CHECK (coalesce(strftime('%Y-%m-%dT%H:%M:%fZ', updated_at) = updated_at, 0)),
  organization_id TEXT NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  name TEXT NOT NULL COLLATE NOCASE CONSTRAINT tags_name_length CHECK (length(name) BETWEEN 1 AND 100),
  description TEXT CONSTRAINT tags_description_length CHECK (description IS NULL OR length(description) BETWEEN 1 AND 1000),
  created_by TEXT NOT NULL REFERENCES principals (id),
  deleted_at TEXT CHECK (deleted_at IS NULL OR coalesce(strftime('%Y-%m-%dT%H:%M:%fZ', deleted_at) = deleted_at, 0))
) STRICT;

CREATE INDEX idx_tags_organization_id_id ON tags (organization_id, id);
CREATE UNIQUE INDEX idx_tags_live_name ON tags (organization_id, name) WHERE deleted_at IS NULL;
