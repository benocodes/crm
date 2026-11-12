-- API7 cycle 1 (D1, D5, D12, D16, D20; D1 only): webhook subscriptions and their two machinery tables. A subscription belongs to one agent, names exact event types
-- and one target URL, and is soft-deleted. `webhook_secrets` holds the signing secrets SEALED (AES-256-GCM under CREDENTIALS_KEY, CHN5 D4): rows are inserted, never
-- updated (a BEFORE UPDATE trigger aborts), so a rotation is an insert and the 24-hour overlap a query. `webhook_dispatch_state` holds each subscription's position in the
-- event feed (`cursor_event_id`, an event id and no foreign key: it is a position), set by the create unit to the newest event at creation (D5). The two machinery tables are
-- written without events (D20) and are hidden from `schema.get`. `agents` gains the unique key its composite foreign key needs (the id is already unique alone).

CREATE UNIQUE INDEX idx_agents_organization_id ON agents (organization_id, id);

CREATE TABLE webhook_subscriptions (
  id TEXT PRIMARY KEY NOT NULL
    CHECK (length(id) = 36 AND id NOT GLOB '*[^0-9a-f-]*' AND substr(id, 9, 1) = '-' AND substr(id, 14, 1) = '-' AND substr(id, 19, 1) = '-' AND substr(id, 24, 1) = '-'),
  created_at TEXT NOT NULL CHECK (coalesce(strftime('%Y-%m-%dT%H:%M:%fZ', created_at) = created_at, 0)),
  updated_at TEXT NOT NULL CHECK (coalesce(strftime('%Y-%m-%dT%H:%M:%fZ', updated_at) = updated_at, 0)),
  organization_id TEXT NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  created_by TEXT NOT NULL REFERENCES principals (id),
  agent_id TEXT NOT NULL,
  url TEXT NOT NULL CONSTRAINT webhook_subscriptions_url CHECK (length(url) BETWEEN 1 AND 2048),
  event_types TEXT NOT NULL CONSTRAINT webhook_subscriptions_event_types CHECK (json_valid(event_types) AND json_type(event_types) = 'array' AND json_array_length(event_types) BETWEEN 1 AND 20),
  status TEXT NOT NULL CONSTRAINT webhook_subscriptions_status CHECK (status IN ('active', 'paused', 'disabled')),
  deleted_at TEXT CHECK (deleted_at IS NULL OR coalesce(strftime('%Y-%m-%dT%H:%M:%fZ', deleted_at) = deleted_at, 0)),
  UNIQUE (organization_id, id),
  CONSTRAINT webhook_subscriptions_agent_fk FOREIGN KEY (organization_id, agent_id) REFERENCES agents (organization_id, id)
) STRICT;

CREATE INDEX idx_webhook_subscriptions_agent ON webhook_subscriptions (organization_id, agent_id) WHERE deleted_at IS NULL;

CREATE TABLE webhook_secrets (
  id TEXT PRIMARY KEY NOT NULL
    CHECK (length(id) = 36 AND id NOT GLOB '*[^0-9a-f-]*' AND substr(id, 9, 1) = '-' AND substr(id, 14, 1) = '-' AND substr(id, 19, 1) = '-' AND substr(id, 24, 1) = '-'),
  created_at TEXT NOT NULL CHECK (coalesce(strftime('%Y-%m-%dT%H:%M:%fZ', created_at) = created_at, 0)),
  organization_id TEXT NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  created_by TEXT NOT NULL REFERENCES principals (id),
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
  organization_id TEXT NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  created_by TEXT NOT NULL REFERENCES principals (id),
  cursor_event_id TEXT NOT NULL
    CHECK (length(cursor_event_id) = 36 AND cursor_event_id NOT GLOB '*[^0-9a-f-]*' AND substr(cursor_event_id, 9, 1) = '-' AND substr(cursor_event_id, 14, 1) = '-' AND substr(cursor_event_id, 19, 1) = '-' AND substr(cursor_event_id, 24, 1) = '-'),
  last_dispatched_at TEXT CHECK (last_dispatched_at IS NULL OR coalesce(strftime('%Y-%m-%dT%H:%M:%fZ', last_dispatched_at) = last_dispatched_at, 0)),
  last_success_at TEXT CHECK (last_success_at IS NULL OR coalesce(strftime('%Y-%m-%dT%H:%M:%fZ', last_success_at) = last_success_at, 0)),
  CONSTRAINT webhook_dispatch_state_subscription_fk FOREIGN KEY (organization_id, subscription_id) REFERENCES webhook_subscriptions (organization_id, id)
) STRICT;
