-- CORE74: notes (D1 only, [[CORE62]] D17, D22). A Markdown note is a record in its own right and links to other records through
-- `associations`. The title is optional; the body is required and bounded (the API validates the same limits).

CREATE TABLE notes (
  id TEXT PRIMARY KEY NOT NULL
    CHECK (length(id) = 36 AND id NOT GLOB '*[^0-9a-f-]*' AND substr(id, 9, 1) = '-' AND substr(id, 14, 1) = '-' AND substr(id, 19, 1) = '-' AND substr(id, 24, 1) = '-'),
  created_at TEXT NOT NULL CHECK (coalesce(strftime('%Y-%m-%dT%H:%M:%fZ', created_at) = created_at, 0)),
  updated_at TEXT NOT NULL CHECK (coalesce(strftime('%Y-%m-%dT%H:%M:%fZ', updated_at) = updated_at, 0)),
  organization_id TEXT NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  title TEXT CONSTRAINT notes_title_length CHECK (title IS NULL OR length(title) BETWEEN 1 AND 500),
  content TEXT NOT NULL CONSTRAINT notes_content_length CHECK (length(content) BETWEEN 1 AND 100000),
  created_by TEXT NOT NULL REFERENCES principals (id),
  deleted_at TEXT CHECK (deleted_at IS NULL OR coalesce(strftime('%Y-%m-%dT%H:%M:%fZ', deleted_at) = deleted_at, 0))
) STRICT;

CREATE INDEX idx_notes_organization_id_id ON notes (organization_id, id);
