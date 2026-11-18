-- #451 (user ruling 451.1, amends CHN406 D12): the table defaults of the three capture settings become what a new connection gets: exclude_group_addresses 1,
-- exclude_personal_domains 1, contact_creation 'sent'. D1 cannot alter a column default in place, so `channel_connections` is rebuilt by 0022/0024's pattern: it is
-- a parent (credentials, watches, sync state and cursors, the two source tables, action_executions and the two capture child tables), so the rows go to a side
-- table, the drop raises the deferred foreign-key counter, and the inserts into the re-created table clear it. Every existing row keeps the value it has;
-- no connection's settings change. Columns, CHECKs, UNIQUE and indexes are copied from 0010 and 0021.
PRAGMA defer_foreign_keys = on;

CREATE TABLE channel_connections_backup AS SELECT * FROM channel_connections;
DROP TABLE channel_connections;

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
  exclude_group_addresses INTEGER NOT NULL DEFAULT 1 CONSTRAINT channel_connections_exclude_group_addresses CHECK (exclude_group_addresses IN (0, 1)),
  exclude_personal_domains INTEGER NOT NULL DEFAULT 1 CONSTRAINT channel_connections_exclude_personal_domains CHECK (exclude_personal_domains IN (0, 1)),
  contact_creation TEXT NOT NULL DEFAULT 'sent' CONSTRAINT channel_connections_contact_creation CHECK (contact_creation IN ('sent_and_received', 'sent', 'none')),
  UNIQUE (organization_id, id),
  CONSTRAINT channel_connections_identity_fk FOREIGN KEY (organization_id, identity_id) REFERENCES identities (organization_id, id)
) STRICT;

INSERT INTO channel_connections (id, created_at, updated_at, organization_id, created_by, deleted_at, provider, account_id, identity_id, owner_id, status, granted_scopes, connected_at, exclude_group_addresses, exclude_personal_domains, contact_creation)
SELECT id, created_at, updated_at, organization_id, created_by, deleted_at, provider, account_id, identity_id, owner_id, status, granted_scopes, connected_at, exclude_group_addresses, exclude_personal_domains, contact_creation FROM channel_connections_backup;
DROP TABLE channel_connections_backup;

CREATE UNIQUE INDEX idx_channel_connections_live_account ON channel_connections (organization_id, provider, account_id) WHERE deleted_at IS NULL;
CREATE INDEX idx_channel_connections_owner ON channel_connections (owner_id);
