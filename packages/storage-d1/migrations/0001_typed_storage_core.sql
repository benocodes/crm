-- D1 schema slice 1 (CORE35 cycle 1): what `tasks` and the events outbox need. Forward-only; later cycles
-- append 0002_..., 0003_... for the tables they migrate. Wrangler-compatible (NNNN_<name>.sql); apply with
-- `wrangler d1 migrations apply` in a self-hosted deployment, or through the local Miniflare test helper.
--
-- Conventions: canonical lowercase UUID text, ISO-8601 UTC timestamps with milliseconds, validated as exactly strftime('%Y-%m-%dT%H:%M:%fZ') output (D1 caps LIKE/GLOB patterns at 50 bytes),
-- booleans as checked 0/1 integers, JSON as checked text. Foreign keys are always enforced by D1.
--
-- Tenancy (D18): a D1 deployment is ONE organisation. The singleton `deployment` marker fixes its id;
-- organizations.id is a foreign key onto the marker, so only that organisation can exist, and every tenant
-- table's organization_id references organizations, so a row for a second organisation cannot be stored.

CREATE TABLE deployment (
  singleton INTEGER PRIMARY KEY NOT NULL CHECK (singleton = 1),
  organization_id TEXT NOT NULL UNIQUE
    CHECK (length(organization_id) = 36 AND organization_id NOT GLOB '*[^0-9a-f-]*' AND substr(organization_id, 9, 1) = '-' AND substr(organization_id, 14, 1) = '-' AND substr(organization_id, 19, 1) = '-' AND substr(organization_id, 24, 1) = '-'),
  auth_provider TEXT NOT NULL,
  auth_org_id TEXT NOT NULL,
  UNIQUE (auth_provider, auth_org_id)
) STRICT;

CREATE TABLE organizations (
  id TEXT PRIMARY KEY NOT NULL REFERENCES deployment (organization_id),
  created_at TEXT NOT NULL CHECK (coalesce(strftime('%Y-%m-%dT%H:%M:%fZ', created_at) = created_at, 0)),
  updated_at TEXT NOT NULL CHECK (coalesce(strftime('%Y-%m-%dT%H:%M:%fZ', updated_at) = updated_at, 0)),
  name TEXT NOT NULL,
  auth_provider TEXT,
  auth_org_id TEXT,
  CHECK ((auth_provider IS NULL) = (auth_org_id IS NULL)),
  UNIQUE (auth_provider, auth_org_id)
) STRICT;

CREATE TABLE principals (
  id TEXT PRIMARY KEY NOT NULL
    CHECK (length(id) = 36 AND id NOT GLOB '*[^0-9a-f-]*' AND substr(id, 9, 1) = '-' AND substr(id, 14, 1) = '-' AND substr(id, 19, 1) = '-' AND substr(id, 24, 1) = '-'),
  created_at TEXT NOT NULL CHECK (coalesce(strftime('%Y-%m-%dT%H:%M:%fZ', created_at) = created_at, 0)),
  kind TEXT NOT NULL CHECK (kind IN ('user', 'agent', 'system'))
) STRICT;

-- At most one system principal (the directory sync's attribution, CORE3).
CREATE UNIQUE INDEX idx_principals_single_system ON principals (kind) WHERE kind = 'system';

-- Emails are stored lowercase ASCII (D-ASCII): a deliberate, documented restriction that replaces citext.
CREATE TABLE users (
  id TEXT PRIMARY KEY NOT NULL REFERENCES principals (id) ON DELETE CASCADE,
  created_at TEXT NOT NULL CHECK (coalesce(strftime('%Y-%m-%dT%H:%M:%fZ', created_at) = created_at, 0)),
  updated_at TEXT NOT NULL CHECK (coalesce(strftime('%Y-%m-%dT%H:%M:%fZ', updated_at) = updated_at, 0)),
  email TEXT NOT NULL UNIQUE CHECK (email = lower(email) AND email NOT GLOB '*[^ -~]*'),
  name TEXT,
  auth_provider TEXT,
  auth_subject TEXT,
  email_verified INTEGER NOT NULL DEFAULT 0 CHECK (email_verified IN (0, 1)),
  CHECK ((auth_provider IS NULL) = (auth_subject IS NULL)),
  UNIQUE (auth_provider, auth_subject)
) STRICT;

CREATE TABLE events (
  id TEXT PRIMARY KEY NOT NULL
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

CREATE INDEX idx_events_organization_id_id ON events (organization_id, id);

CREATE TABLE tasks (
  id TEXT PRIMARY KEY NOT NULL
    CHECK (length(id) = 36 AND id NOT GLOB '*[^0-9a-f-]*' AND substr(id, 9, 1) = '-' AND substr(id, 14, 1) = '-' AND substr(id, 19, 1) = '-' AND substr(id, 24, 1) = '-'),
  created_at TEXT NOT NULL CHECK (coalesce(strftime('%Y-%m-%dT%H:%M:%fZ', created_at) = created_at, 0)),
  updated_at TEXT NOT NULL CHECK (coalesce(strftime('%Y-%m-%dT%H:%M:%fZ', updated_at) = updated_at, 0)),
  organization_id TEXT NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  notes TEXT,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'done')),
  due_at TEXT CHECK (due_at IS NULL OR coalesce(strftime('%Y-%m-%dT%H:%M:%fZ', due_at) = due_at, 0)),
  completed_at TEXT CHECK (completed_at IS NULL OR coalesce(strftime('%Y-%m-%dT%H:%M:%fZ', completed_at) = completed_at, 0)),
  assignee_id TEXT REFERENCES principals (id),
  created_by TEXT NOT NULL REFERENCES principals (id),
  deleted_at TEXT CHECK (deleted_at IS NULL OR coalesce(strftime('%Y-%m-%dT%H:%M:%fZ', deleted_at) = deleted_at, 0))
) STRICT;

CREATE INDEX idx_tasks_organization_id_id ON tasks (organization_id, id);
