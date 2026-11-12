-- API7 cycle 2 (D4, D14, D20; D1 only): webhook deliveries. One row per (subscription, event): the dispatcher inserts it `pending` when the event reaches the subscription's cursor,
-- and the sender (API220) claims, attempts and settles it. The rows are the queue (D6): `next_attempt_at` says when an attempt is due, `lease_until`/`lease_token` hold a claim
-- (only a pending row is ever leased, both columns or neither, as `0012`'s). `event_id` is a position and carries no foreign key to `events` (the feed's cursor rule, D5), so a row
-- outlives nothing and blocks nothing. Machinery written without events (D20), readable through `webhooks.deliveries` and listed in `schema.get`. `last_error` holds a code
-- (timeout, connection_failed, http_status, redirect, sender_failed, cancelled_subscription, cancelled_scope), never a response body.

CREATE TABLE webhook_deliveries (
  id TEXT PRIMARY KEY NOT NULL
    CHECK (length(id) = 36 AND id NOT GLOB '*[^0-9a-f-]*' AND substr(id, 9, 1) = '-' AND substr(id, 14, 1) = '-' AND substr(id, 19, 1) = '-' AND substr(id, 24, 1) = '-'),
  created_at TEXT NOT NULL CHECK (coalesce(strftime('%Y-%m-%dT%H:%M:%fZ', created_at) = created_at, 0)),
  organization_id TEXT NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  created_by TEXT NOT NULL REFERENCES principals (id),
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
