-- API105 (API6 D1, D15, D16): `events` gets `seq`, the commit-order key SQLite assigns at insert inside the single writer, and becomes
-- append-only. `id` stays the public event id (UUIDv7, UNIQUE). The table is rebuilt because a primary key cannot be changed in place;
-- rows are copied in rowid (insertion) order, so `seq` ascends in the order the rows were committed. Nothing references `events`.
-- AUTOINCREMENT (sqlite_sequence) so a deleted tail never lets a later event reuse a `seq` a reader already passed.
PRAGMA defer_foreign_keys = on;

CREATE TABLE events_new (
  seq INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
  id TEXT NOT NULL UNIQUE
    CHECK (length(id) = 36 AND id NOT GLOB '*[^0-9a-f-]*' AND substr(id, 9, 1) = '-' AND substr(id, 14, 1) = '-' AND substr(id, 19, 1) = '-' AND substr(id, 24, 1) = '-'),
  created_at TEXT NOT NULL CHECK (coalesce(strftime('%Y-%m-%dT%H:%M:%fZ', created_at) = created_at, 0)),
  organization_id TEXT NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  resource_type TEXT NOT NULL,
  resource_id TEXT NOT NULL
    CHECK (length(resource_id) = 36 AND resource_id NOT GLOB '*[^0-9a-f-]*' AND substr(resource_id, 9, 1) = '-' AND substr(resource_id, 14, 1) = '-' AND substr(resource_id, 19, 1) = '-' AND substr(resource_id, 24, 1) = '-'),
  actor_id TEXT NOT NULL REFERENCES principals (id),
  "before" TEXT CHECK ("before" IS NULL OR json_valid("before")),
  "after" TEXT CHECK ("after" IS NULL OR json_valid("after"))
) STRICT;

INSERT INTO events_new (id, created_at, organization_id, type, resource_type, resource_id, actor_id, "before", "after")
  SELECT id, created_at, organization_id, type, resource_type, resource_id, actor_id, "before", "after" FROM events ORDER BY rowid;

DROP TABLE events;
ALTER TABLE events_new RENAME TO events;

CREATE INDEX idx_events_resource_id_seq ON events (resource_id, seq);

-- Append-only (D15): an UPDATE aborts the statement (and so the batch). Inserts and deletes are untouched (the harness clears the table;
-- deleting the organisation cascades).
CREATE TRIGGER events_append_only BEFORE UPDATE ON events
BEGIN
  SELECT RAISE(ABORT, 'append_only');
END;
