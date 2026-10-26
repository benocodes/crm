-- D1 schema slice 3 (CORE40): administration. Forward-only, in 0001/0002's conventions (canonical lowercase UUID text,
-- strftime-validated ISO timestamps, STRICT tables). Mirrors the Postgres constraints exactly (CORE40 P2), with the
-- plain foreign keys Postgres has: a D1 database holds ONE organisation, so a composite intra-organisation key would
-- protect nothing more here (the cross-organisation hole is a Postgres problem, closed by the plan read under RLS
-- and the commit guard). `agents.scopes` is a JSON array of text: SQLite CHECKs cannot hold a subquery, so the
-- element types are checked by the zod record on read. Memberships have no public writer: the directory sync
-- writes them (legacy, Postgres only, until CORE41); a D1 deployment seeds them.

CREATE TABLE memberships (
  id TEXT PRIMARY KEY NOT NULL
    CHECK (length(id) = 36 AND id NOT GLOB '*[^0-9a-f-]*' AND substr(id, 9, 1) = '-' AND substr(id, 14, 1) = '-' AND substr(id, 19, 1) = '-' AND substr(id, 24, 1) = '-'),
  created_at TEXT NOT NULL CHECK (coalesce(strftime('%Y-%m-%dT%H:%M:%fZ', created_at) = created_at, 0)),
  updated_at TEXT NOT NULL CHECK (coalesce(strftime('%Y-%m-%dT%H:%M:%fZ', updated_at) = updated_at, 0)),
  organization_id TEXT NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('owner', 'member')),
  created_by TEXT NOT NULL REFERENCES principals (id),
  deleted_at TEXT CHECK (deleted_at IS NULL OR coalesce(strftime('%Y-%m-%dT%H:%M:%fZ', deleted_at) = deleted_at, 0))
) STRICT;

CREATE UNIQUE INDEX idx_memberships_live_unique ON memberships (organization_id, user_id) WHERE deleted_at IS NULL;
CREATE INDEX idx_memberships_user_id ON memberships (user_id) WHERE deleted_at IS NULL;

CREATE TABLE agents (
  id TEXT PRIMARY KEY NOT NULL REFERENCES principals (id) ON DELETE CASCADE
    CHECK (length(id) = 36 AND id NOT GLOB '*[^0-9a-f-]*' AND substr(id, 9, 1) = '-' AND substr(id, 14, 1) = '-' AND substr(id, 19, 1) = '-' AND substr(id, 24, 1) = '-'),
  created_at TEXT NOT NULL CHECK (coalesce(strftime('%Y-%m-%dT%H:%M:%fZ', created_at) = created_at, 0)),
  updated_at TEXT NOT NULL CHECK (coalesce(strftime('%Y-%m-%dT%H:%M:%fZ', updated_at) = updated_at, 0)),
  organization_id TEXT NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  scopes TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(scopes) AND json_type(scopes) = 'array'),
  disabled_at TEXT CHECK (disabled_at IS NULL OR coalesce(strftime('%Y-%m-%dT%H:%M:%fZ', disabled_at) = disabled_at, 0)),
  created_by TEXT NOT NULL REFERENCES principals (id)
) STRICT;

CREATE TABLE api_keys (
  id TEXT PRIMARY KEY NOT NULL
    CHECK (length(id) = 36 AND id NOT GLOB '*[^0-9a-f-]*' AND substr(id, 9, 1) = '-' AND substr(id, 14, 1) = '-' AND substr(id, 19, 1) = '-' AND substr(id, 24, 1) = '-'),
  created_at TEXT NOT NULL CHECK (coalesce(strftime('%Y-%m-%dT%H:%M:%fZ', created_at) = created_at, 0)),
  updated_at TEXT NOT NULL CHECK (coalesce(strftime('%Y-%m-%dT%H:%M:%fZ', updated_at) = updated_at, 0)),
  organization_id TEXT NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL REFERENCES agents (id) ON DELETE CASCADE,
  key_hash TEXT NOT NULL UNIQUE,
  prefix TEXT NOT NULL,
  last_used_at TEXT CHECK (last_used_at IS NULL OR coalesce(strftime('%Y-%m-%dT%H:%M:%fZ', last_used_at) = last_used_at, 0)),
  revoked_at TEXT CHECK (revoked_at IS NULL OR coalesce(strftime('%Y-%m-%dT%H:%M:%fZ', revoked_at) = revoked_at, 0)),
  expires_at TEXT CHECK (expires_at IS NULL OR coalesce(strftime('%Y-%m-%dT%H:%M:%fZ', expires_at) = expires_at, 0)),
  created_by TEXT NOT NULL REFERENCES principals (id)
) STRICT;
