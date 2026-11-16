-- Control 0005 (CORE328; CORE259 D3, D8, D11, D12): `api_keys` of CRM 0003 in the control database, dormant until CORE350 reads authentication from it and CORE351 moves the writers.
-- Every column, CHECK and the unique `key_hash` are the CRM table's own (P1); what changes is that the three foreign keys (`organizations`, `agents`, `principals`) are gone (D8):
-- `organization_id`, `agent_id` and `created_by` are CRM ids held by value. The id is the caller's, so a backfill can copy rows with their ids. Only the SHA-256 hash of a key is stored, never the key.
-- A key's creation and revocation write a `control_audit` row in the same batch; the `last_used_at` stamp is machinery and writes none (P2, P4).

CREATE TABLE api_keys (
  id TEXT PRIMARY KEY NOT NULL
    CHECK (length(id) = 36 AND id NOT GLOB '*[^0-9a-f-]*' AND substr(id, 9, 1) = '-' AND substr(id, 14, 1) = '-' AND substr(id, 19, 1) = '-' AND substr(id, 24, 1) = '-'),
  created_at TEXT NOT NULL CHECK (coalesce(strftime('%Y-%m-%dT%H:%M:%fZ', created_at) = created_at, 0)),
  updated_at TEXT NOT NULL CHECK (coalesce(strftime('%Y-%m-%dT%H:%M:%fZ', updated_at) = updated_at, 0)),
  organization_id TEXT NOT NULL CHECK (length(organization_id) = 36 AND organization_id NOT GLOB '*[^0-9a-f-]*'),
  agent_id TEXT NOT NULL CHECK (length(agent_id) = 36 AND agent_id NOT GLOB '*[^0-9a-f-]*'),
  key_hash TEXT NOT NULL UNIQUE,
  prefix TEXT NOT NULL,
  last_used_at TEXT CHECK (last_used_at IS NULL OR coalesce(strftime('%Y-%m-%dT%H:%M:%fZ', last_used_at) = last_used_at, 0)),
  revoked_at TEXT CHECK (revoked_at IS NULL OR coalesce(strftime('%Y-%m-%dT%H:%M:%fZ', revoked_at) = revoked_at, 0)),
  expires_at TEXT CHECK (expires_at IS NULL OR coalesce(strftime('%Y-%m-%dT%H:%M:%fZ', expires_at) = expires_at, 0)),
  created_by TEXT NOT NULL CHECK (length(created_by) = 36 AND created_by NOT GLOB '*[^0-9a-f-]*')
) STRICT;
