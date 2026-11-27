-- Genesis schema for the control-plane D1 database ([[CORE678]]).
-- Generated from the catalogue (sqlite_master, creation order) of the 36-file chain this replaces, with no row data.
-- Not tidied: object order, quoting and CHECK text are what the chain left.

CREATE TABLE "auth_users" ("id" text not null primary key, "name" text not null, "email" text not null unique, "email_verified" integer not null, "image" text, "created_at" date not null, "updated_at" date not null);

CREATE TABLE "auth_sessions" ("id" text not null primary key, "expires_at" date not null, "token" text not null unique, "created_at" date not null, "updated_at" date not null, "ip_address" text, "user_agent" text, "user_id" text not null references "auth_users" ("id") on delete cascade);

CREATE TABLE "auth_accounts" ("id" text not null primary key, "account_id" text not null, "provider_id" text not null, "user_id" text not null references "auth_users" ("id") on delete cascade, "access_token" text, "refresh_token" text, "id_token" text, "access_token_expires_at" date, "refresh_token_expires_at" date, "scope" text, "password" text, "created_at" date not null, "updated_at" date not null);

CREATE TABLE "auth_verifications" ("id" text not null primary key, "identifier" text not null, "value" text not null, "expires_at" date not null, "created_at" date not null, "updated_at" date not null);

CREATE TABLE "auth_jwks" ("id" text not null primary key, "public_key" text not null, "private_key" text not null, "created_at" date not null, "expires_at" date, "alg" text, "crv" text);

CREATE TABLE "auth_oauth_clients" ("id" text not null primary key, "client_id" text not null unique, "client_secret" text, "client_discovery_id" text, "disabled" integer, "skip_consent" integer, "enable_end_session" integer, "subject_type" text, "scopes" text, "client_credentials_scopes" text, "user_id" text references "auth_users" ("id") on delete cascade, "created_at" date, "updated_at" date, "name" text, "uri" text, "icon" text, "contacts" text, "tos" text, "policy" text, "software_id" text, "software_version" text, "software_statement" text, "redirect_uris" text not null, "post_logout_redirect_uris" text, "backchannel_logout_uri" text, "backchannel_logout_session_required" integer, "token_endpoint_auth_method" text, "application_type" text, "jwks" text, "jwks_uri" text, "grant_types" text, "response_types" text, "require_pkce" integer, "dpop_bound_access_tokens" integer, "reference_id" text, "metadata" text);

CREATE TABLE "auth_oauth_resources" ("id" text not null primary key, "identifier" text not null unique, "name" text not null, "access_token_ttl" integer, "refresh_token_ttl" integer, "signing_algorithm" text, "signing_key_id" text, "allowed_scopes" text, "custom_claims" text, "dpop_bound_access_tokens_required" integer, "disabled" integer, "created_at" date, "updated_at" date, "policy_version" integer, "metadata" text);

CREATE TABLE "auth_oauth_client_resources" ("id" text not null primary key, "client_id" text not null references "auth_oauth_clients" ("client_id") on delete cascade, "resource_id" text not null references "auth_oauth_resources" ("identifier") on delete cascade, "metadata" text, "created_at" date);

CREATE TABLE "auth_oauth_refresh_tokens" ("id" text not null primary key, "token" text not null unique, "client_id" text not null references "auth_oauth_clients" ("client_id") on delete cascade, "session_id" text references "auth_sessions" ("id") on delete set null, "user_id" text not null references "auth_users" ("id") on delete cascade, "reference_id" text, "authorization_code_id" text, "resources" text, "requested_user_info_claims" text, "expires_at" date not null, "created_at" date not null, "revoked" date, "rotated_at" date, "rotation_replay_response" text, "rotation_replay_expires_at" date, "auth_time" date, "confirmation" text, "scopes" text not null);

CREATE TABLE "auth_oauth_access_tokens" ("id" text not null primary key, "token" text not null unique, "client_id" text not null references "auth_oauth_clients" ("client_id") on delete cascade, "session_id" text references "auth_sessions" ("id") on delete set null, "user_id" text references "auth_users" ("id") on delete cascade, "reference_id" text, "authorization_code_id" text, "resources" text, "requested_user_info_claims" text, "refresh_id" text references "auth_oauth_refresh_tokens" ("id") on delete cascade, "expires_at" date not null, "created_at" date not null, "revoked" date, "confirmation" text, "scopes" text not null);

CREATE TABLE "auth_oauth_consents" ("id" text not null primary key, "client_id" text not null references "auth_oauth_clients" ("client_id") on delete cascade, "user_id" text references "auth_users" ("id") on delete cascade, "reference_id" text, "resources" text, "requested_user_info_claims" text, "scopes" text not null, "created_at" date not null, "updated_at" date not null);

CREATE TABLE "auth_oauth_client_assertions" ("id" text not null primary key, "expires_at" date not null);

CREATE TABLE "auth_device_codes" ("id" text not null primary key, "device_code" text not null, "user_code" text not null, "user_id" text, "expires_at" date not null, "status" text not null, "last_polled_at" date, "polling_interval" integer, "client_id" text, "scope" text, "resources" text, "oauth_client_id" text);

CREATE TABLE "auth_rate_limits" ("id" text not null primary key, "key" text not null unique, "count" integer not null, "last_request" bigint not null);

CREATE INDEX "auth_sessions_user_id_idx" on "auth_sessions" ("user_id");

CREATE INDEX "auth_accounts_user_id_idx" on "auth_accounts" ("user_id");

CREATE INDEX "auth_verifications_identifier_idx" on "auth_verifications" ("identifier");

CREATE INDEX "auth_oauth_clients_user_id_idx" on "auth_oauth_clients" ("user_id");

CREATE INDEX "auth_oauth_client_resources_client_id_idx" on "auth_oauth_client_resources" ("client_id");

CREATE INDEX "auth_oauth_client_resources_resource_id_idx" on "auth_oauth_client_resources" ("resource_id");

CREATE INDEX "auth_oauth_refresh_tokens_client_id_idx" on "auth_oauth_refresh_tokens" ("client_id");

CREATE INDEX "auth_oauth_refresh_tokens_session_id_idx" on "auth_oauth_refresh_tokens" ("session_id");

CREATE INDEX "auth_oauth_refresh_tokens_user_id_idx" on "auth_oauth_refresh_tokens" ("user_id");

CREATE INDEX "auth_oauth_refresh_tokens_authorization_code_id_idx" on "auth_oauth_refresh_tokens" ("authorization_code_id");

CREATE INDEX "auth_oauth_access_tokens_client_id_idx" on "auth_oauth_access_tokens" ("client_id");

CREATE INDEX "auth_oauth_access_tokens_session_id_idx" on "auth_oauth_access_tokens" ("session_id");

CREATE INDEX "auth_oauth_access_tokens_user_id_idx" on "auth_oauth_access_tokens" ("user_id");

CREATE INDEX "auth_oauth_access_tokens_authorization_code_id_idx" on "auth_oauth_access_tokens" ("authorization_code_id");

CREATE INDEX "auth_oauth_access_tokens_refresh_id_idx" on "auth_oauth_access_tokens" ("refresh_id");

CREATE INDEX "auth_oauth_consents_client_id_idx" on "auth_oauth_consents" ("client_id");

CREATE INDEX "auth_oauth_consents_user_id_idx" on "auth_oauth_consents" ("user_id");

CREATE UNIQUE INDEX "auth_oauth_client_resources_client_id_resource_id_uidx" on "auth_oauth_client_resources" ("client_id", "resource_id");

CREATE UNIQUE INDEX "auth_device_codes_device_code_uidx" on "auth_device_codes" ("device_code");

CREATE UNIQUE INDEX "auth_device_codes_user_code_uidx" on "auth_device_codes" ("user_code");

CREATE TABLE control_deployment (
  singleton integer primary key not null check (singleton = 1),
  organization_id text not null
    check (length(organization_id) = 36 and organization_id not glob '*[^0-9a-f-]*' and substr(organization_id, 9, 1) = '-' and substr(organization_id, 14, 1) = '-' and substr(organization_id, 19, 1) = '-' and substr(organization_id, 24, 1) = '-')
) strict;

CREATE TABLE invitations (
  id text primary key not null
    check (length(id) = 36 and id not glob '*[^0-9a-f-]*'),
  organization_id text not null
    check (length(organization_id) = 36 and organization_id not glob '*[^0-9a-f-]*'),
  email text not null
    check (length(email) > 0 and email = lower(trim(email))),
  role text not null
    check (role in ('owner', 'member', 'agent')),
  token_hash text not null unique
    check (length(token_hash) = 64),
  expires_at text not null
    check (coalesce(strftime('%Y-%m-%dT%H:%M:%fZ', expires_at) = expires_at, 0)),
  created_by text not null
    check (length(created_by) = 36 and created_by not glob '*[^0-9a-f-]*'),
  created_at text not null
    check (coalesce(strftime('%Y-%m-%dT%H:%M:%fZ', created_at) = created_at, 0)),
  accepted_at text
    check (accepted_at is null or coalesce(strftime('%Y-%m-%dT%H:%M:%fZ', accepted_at) = accepted_at, 0)),
  revoked_at text
    check (revoked_at is null or coalesce(strftime('%Y-%m-%dT%H:%M:%fZ', revoked_at) = revoked_at, 0))
, delivery text not null default 'link' check (delivery in ('link', 'email'))) strict;

CREATE INDEX invitations_email_idx on invitations (email);

CREATE TABLE control_audit (
  id text primary key not null
    check (length(id) = 36 and id not glob '*[^0-9a-f-]*'),
  at text not null
    check (coalesce(strftime('%Y-%m-%dT%H:%M:%fZ', at) = at, 0)),
  actor_id text not null
    check (length(actor_id) = 36 and actor_id not glob '*[^0-9a-f-]*'),
  action text not null
    check (length(action) > 0),
  target_type text not null
    check (length(target_type) > 0),
  target_id text not null
    check (length(target_id) > 0),
  detail text not null
    check (json_valid(detail))
) strict;

CREATE INDEX control_audit_target_idx on control_audit (target_type, target_id);

CREATE INDEX control_audit_at_idx on control_audit (at);

CREATE TRIGGER control_audit_no_update BEFORE UPDATE ON control_audit
BEGIN
  SELECT RAISE(ABORT, 'append_only');
END;

CREATE TRIGGER control_audit_no_delete BEFORE DELETE ON control_audit
BEGIN
  SELECT RAISE(ABORT, 'append_only');
END;

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

CREATE INDEX idx_webhook_deliveries_due ON webhook_deliveries (next_attempt_at, id) WHERE status = 'pending';

CREATE INDEX idx_webhook_deliveries_list ON webhook_deliveries (organization_id, subscription_id, id);

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
