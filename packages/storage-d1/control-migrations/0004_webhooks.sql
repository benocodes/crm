-- Control 0004 (CORE327; CORE259 D3, D8, D13): the four webhook tables of CRM 0016/0017 in the control database, dormant until CORE337 switches the operations, dispatch and sender onto them.
-- Columns, checks, unique keys, indexes, the lease check and the append-only trigger on `webhook_secrets` (an UPDATE aborts) are the CRM tables' own. What changes (P1): every foreign key into a CRM
-- table (`organizations`, `principals`, `agents`) is gone (D8), so `organization_id`, `created_by` and `agent_id` are by-value UUID columns with a format check, as `invitations` holds them;
-- the foreign keys among the four tables stay. `webhook_secrets` hold secrets SEALED (AES-256-GCM under CREDENTIALS_KEY); `cursor_event_id` and `event_id` are positions and carry no foreign key.
-- The machinery tables (state, deliveries) are written without audit rows (P3); a subscription change writes its `control_audit` row in the same batch.

CREATE TABLE webhook_subscriptions (
  id TEXT PRIMARY KEY NOT NULL
    CHECK (length(id) = 36 AND id NOT GLOB '*[^0-9a-f-]*' AND substr(id, 9, 1) = '-' AND substr(id, 14, 1) = '-' AND substr(id, 19, 1) = '-' AND substr(id, 24, 1) = '-'),
  created_at TEXT NOT NULL CHECK (coalesce(strftime('%Y-%m-%dT%H:%M:%fZ', created_at) = created_at, 0)),
  updated_at TEXT NOT NULL CHECK (coalesce(strftime('%Y-%m-%dT%H:%M:%fZ', updated_at) = updated_at, 0)),
  organization_id TEXT NOT NULL CHECK (length(organization_id) = 36 AND organization_id NOT GLOB '*[^0-9a-f-]*'),
  created_by TEXT NOT NULL CHECK (length(created_by) = 36 AND created_by NOT GLOB '*[^0-9a-f-]*'),
  agent_id TEXT NOT NULL CHECK (length(agent_id) = 36 AND agent_id NOT GLOB '*[^0-9a-f-]*'),
  url TEXT NOT NULL CONSTRAINT webhook_subscriptions_url CHECK (length(url) BETWEEN 1 AND 2048),
  event_types TEXT NOT NULL CONSTRAINT webhook_subscriptions_event_types CHECK (json_valid(event_types) AND json_type(event_types) = 'array' AND json_array_length(event_types) BETWEEN 1 AND 20),
  status TEXT NOT NULL CONSTRAINT webhook_subscriptions_status CHECK (status IN ('active', 'paused', 'disabled')),
  deleted_at TEXT CHECK (deleted_at IS NULL OR coalesce(strftime('%Y-%m-%dT%H:%M:%fZ', deleted_at) = deleted_at, 0)),
  UNIQUE (organization_id, id)
) STRICT;

CREATE INDEX idx_webhook_subscriptions_agent ON webhook_subscriptions (organization_id, agent_id) WHERE deleted_at IS NULL;

CREATE TABLE webhook_secrets (
  id TEXT PRIMARY KEY NOT NULL
    CHECK (length(id) = 36 AND id NOT GLOB '*[^0-9a-f-]*' AND substr(id, 9, 1) = '-' AND substr(id, 14, 1) = '-' AND substr(id, 19, 1) = '-' AND substr(id, 24, 1) = '-'),
  created_at TEXT NOT NULL CHECK (coalesce(strftime('%Y-%m-%dT%H:%M:%fZ', created_at) = created_at, 0)),
  organization_id TEXT NOT NULL CHECK (length(organization_id) = 36 AND organization_id NOT GLOB '*[^0-9a-f-]*'),
  created_by TEXT NOT NULL CHECK (length(created_by) = 36 AND created_by NOT GLOB '*[^0-9a-f-]*'),
  subscription_id TEXT NOT NULL,
  sealed TEXT NOT NULL CHECK (length(sealed) > 0),
  key_version INTEGER NOT NULL CHECK (key_version >= 1),
  CONSTRAINT webhook_secrets_subscription_fk FOREIGN KEY (organization_id, subscription_id) REFERENCES webhook_subscriptions (organization_id, id)
) STRICT;

CREATE INDEX idx_webhook_secrets_subscription ON webhook_secrets (organization_id, subscription_id, created_at, id);

-- Append-only (D12): an UPDATE aborts the statement. A secret is superseded by a newer row, never changed.
CREATE TRIGGER webhook_secrets_append_only BEFORE UPDATE ON webhook_secrets
BEGIN
  SELECT RAISE(ABORT, 'append_only');
END;

CREATE TABLE webhook_dispatch_state (
  subscription_id TEXT PRIMARY KEY NOT NULL
    CHECK (length(subscription_id) = 36 AND subscription_id NOT GLOB '*[^0-9a-f-]*' AND substr(subscription_id, 9, 1) = '-' AND substr(subscription_id, 14, 1) = '-' AND substr(subscription_id, 19, 1) = '-' AND substr(subscription_id, 24, 1) = '-'),
  created_at TEXT NOT NULL CHECK (coalesce(strftime('%Y-%m-%dT%H:%M:%fZ', created_at) = created_at, 0)),
  organization_id TEXT NOT NULL CHECK (length(organization_id) = 36 AND organization_id NOT GLOB '*[^0-9a-f-]*'),
  created_by TEXT NOT NULL CHECK (length(created_by) = 36 AND created_by NOT GLOB '*[^0-9a-f-]*'),
  cursor_event_id TEXT NOT NULL
    CHECK (length(cursor_event_id) = 36 AND cursor_event_id NOT GLOB '*[^0-9a-f-]*' AND substr(cursor_event_id, 9, 1) = '-' AND substr(cursor_event_id, 14, 1) = '-' AND substr(cursor_event_id, 19, 1) = '-' AND substr(cursor_event_id, 24, 1) = '-'),
  last_dispatched_at TEXT CHECK (last_dispatched_at IS NULL OR coalesce(strftime('%Y-%m-%dT%H:%M:%fZ', last_dispatched_at) = last_dispatched_at, 0)),
  last_success_at TEXT CHECK (last_success_at IS NULL OR coalesce(strftime('%Y-%m-%dT%H:%M:%fZ', last_success_at) = last_success_at, 0)),
  CONSTRAINT webhook_dispatch_state_subscription_fk FOREIGN KEY (organization_id, subscription_id) REFERENCES webhook_subscriptions (organization_id, id)
) STRICT;

CREATE TABLE webhook_deliveries (
  id TEXT PRIMARY KEY NOT NULL
    CHECK (length(id) = 36 AND id NOT GLOB '*[^0-9a-f-]*' AND substr(id, 9, 1) = '-' AND substr(id, 14, 1) = '-' AND substr(id, 19, 1) = '-' AND substr(id, 24, 1) = '-'),
  created_at TEXT NOT NULL CHECK (coalesce(strftime('%Y-%m-%dT%H:%M:%fZ', created_at) = created_at, 0)),
  organization_id TEXT NOT NULL CHECK (length(organization_id) = 36 AND organization_id NOT GLOB '*[^0-9a-f-]*'),
  created_by TEXT NOT NULL CHECK (length(created_by) = 36 AND created_by NOT GLOB '*[^0-9a-f-]*'),
  subscription_id TEXT NOT NULL,
  event_id TEXT NOT NULL
    CHECK (length(event_id) = 36 AND event_id NOT GLOB '*[^0-9a-f-]*' AND substr(event_id, 9, 1) = '-' AND substr(event_id, 14, 1) = '-' AND substr(event_id, 19, 1) = '-' AND substr(event_id, 24, 1) = '-'),
  event_type TEXT NOT NULL,
  status TEXT NOT NULL CONSTRAINT webhook_deliveries_status CHECK (status IN ('pending', 'delivered', 'dead', 'cancelled')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at TEXT NOT NULL CHECK (coalesce(strftime('%Y-%m-%dT%H:%M:%fZ', next_attempt_at) = next_attempt_at, 0)),
  lease_until TEXT CHECK (lease_until IS NULL OR coalesce(strftime('%Y-%m-%dT%H:%M:%fZ', lease_until) = lease_until, 0)),
  lease_token TEXT,
  last_attempt_at TEXT CHECK (last_attempt_at IS NULL OR coalesce(strftime('%Y-%m-%dT%H:%M:%fZ', last_attempt_at) = last_attempt_at, 0)),
  last_status_code INTEGER,
  last_error TEXT,
  delivered_at TEXT CHECK (delivered_at IS NULL OR coalesce(strftime('%Y-%m-%dT%H:%M:%fZ', delivered_at) = delivered_at, 0)),
  CONSTRAINT webhook_deliveries_lease CHECK ((lease_until IS NULL) = (lease_token IS NULL) AND (lease_token IS NULL OR status = 'pending')),
  UNIQUE (subscription_id, event_id),
  CONSTRAINT webhook_deliveries_subscription_fk FOREIGN KEY (organization_id, subscription_id) REFERENCES webhook_subscriptions (organization_id, id)
) STRICT;

-- UNIQUE (subscription_id, event_id) is the dispatcher's idempotence (D4, invariant 3): a second insert of the pair is `ON CONFLICT DO NOTHING`.
-- The sender's due scan (D6): pending rows by when they are due.
CREATE INDEX idx_webhook_deliveries_due ON webhook_deliveries (next_attempt_at, id) WHERE status = 'pending';
-- `webhooks.deliveries` (D14): a subscription's rows by id.
CREATE INDEX idx_webhook_deliveries_list ON webhook_deliveries (organization_id, subscription_id, id);
