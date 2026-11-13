-- 0018: the auth tables of the built-in provider (CORE243 D4, D5). Generated offline by `pnpm -C packages/auth schema:generate --write` from Better Auth's own schema planner
-- (against an empty SQLite: its planner cannot introspect D1), then reviewed. Machinery, not resources: deployment-scoped (no organization_id), written only by Better Auth, never
-- by an operation, absent from schema discovery. Names are the vault's: auth_ prefixed, snake_case columns, ids from the vault's UUIDv7 generator. Timestamps are the ISO-8601
-- text Better Auth writes. No constraint is added beyond what Better Auth's own writes satisfy.

create table "auth_users" ("id" text not null primary key, "name" text not null, "email" text not null unique, "email_verified" integer not null, "image" text, "created_at" date not null, "updated_at" date not null);

create table "auth_sessions" ("id" text not null primary key, "expires_at" date not null, "token" text not null unique, "created_at" date not null, "updated_at" date not null, "ip_address" text, "user_agent" text, "user_id" text not null references "auth_users" ("id") on delete cascade);

create table "auth_accounts" ("id" text not null primary key, "account_id" text not null, "provider_id" text not null, "user_id" text not null references "auth_users" ("id") on delete cascade, "access_token" text, "refresh_token" text, "id_token" text, "access_token_expires_at" date, "refresh_token_expires_at" date, "scope" text, "password" text, "created_at" date not null, "updated_at" date not null);

create table "auth_verifications" ("id" text not null primary key, "identifier" text not null, "value" text not null, "expires_at" date not null, "created_at" date not null, "updated_at" date not null);

create table "auth_jwks" ("id" text not null primary key, "public_key" text not null, "private_key" text not null, "created_at" date not null, "expires_at" date, "alg" text, "crv" text);

create table "auth_oauth_clients" ("id" text not null primary key, "client_id" text not null unique, "client_secret" text, "client_discovery_id" text, "disabled" integer, "skip_consent" integer, "enable_end_session" integer, "subject_type" text, "scopes" text, "client_credentials_scopes" text, "user_id" text references "auth_users" ("id") on delete cascade, "created_at" date, "updated_at" date, "name" text, "uri" text, "icon" text, "contacts" text, "tos" text, "policy" text, "software_id" text, "software_version" text, "software_statement" text, "redirect_uris" text not null, "post_logout_redirect_uris" text, "backchannel_logout_uri" text, "backchannel_logout_session_required" integer, "token_endpoint_auth_method" text, "application_type" text, "jwks" text, "jwks_uri" text, "grant_types" text, "response_types" text, "require_pkce" integer, "dpop_bound_access_tokens" integer, "reference_id" text, "metadata" text);

create table "auth_oauth_resources" ("id" text not null primary key, "identifier" text not null unique, "name" text not null, "access_token_ttl" integer, "refresh_token_ttl" integer, "signing_algorithm" text, "signing_key_id" text, "allowed_scopes" text, "custom_claims" text, "dpop_bound_access_tokens_required" integer, "disabled" integer, "created_at" date, "updated_at" date, "policy_version" integer, "metadata" text);

create table "auth_oauth_client_resources" ("id" text not null primary key, "client_id" text not null references "auth_oauth_clients" ("client_id") on delete cascade, "resource_id" text not null references "auth_oauth_resources" ("identifier") on delete cascade, "metadata" text, "created_at" date);

create table "auth_oauth_refresh_tokens" ("id" text not null primary key, "token" text not null unique, "client_id" text not null references "auth_oauth_clients" ("client_id") on delete cascade, "session_id" text references "auth_sessions" ("id") on delete set null, "user_id" text not null references "auth_users" ("id") on delete cascade, "reference_id" text, "authorization_code_id" text, "resources" text, "requested_user_info_claims" text, "expires_at" date not null, "created_at" date not null, "revoked" date, "rotated_at" date, "rotation_replay_response" text, "rotation_replay_expires_at" date, "auth_time" date, "confirmation" text, "scopes" text not null);

create table "auth_oauth_access_tokens" ("id" text not null primary key, "token" text not null unique, "client_id" text not null references "auth_oauth_clients" ("client_id") on delete cascade, "session_id" text references "auth_sessions" ("id") on delete set null, "user_id" text references "auth_users" ("id") on delete cascade, "reference_id" text, "authorization_code_id" text, "resources" text, "requested_user_info_claims" text, "refresh_id" text references "auth_oauth_refresh_tokens" ("id") on delete cascade, "expires_at" date not null, "created_at" date not null, "revoked" date, "confirmation" text, "scopes" text not null);

create table "auth_oauth_consents" ("id" text not null primary key, "client_id" text not null references "auth_oauth_clients" ("client_id") on delete cascade, "user_id" text references "auth_users" ("id") on delete cascade, "reference_id" text, "resources" text, "requested_user_info_claims" text, "scopes" text not null, "created_at" date not null, "updated_at" date not null);

create table "auth_oauth_client_assertions" ("id" text not null primary key, "expires_at" date not null);

create table "auth_device_codes" ("id" text not null primary key, "device_code" text not null, "user_code" text not null, "user_id" text, "expires_at" date not null, "status" text not null, "last_polled_at" date, "polling_interval" integer, "client_id" text, "scope" text, "resources" text, "oauth_client_id" text);

create table "auth_rate_limits" ("id" text not null primary key, "key" text not null unique, "count" integer not null, "last_request" bigint not null);

create index "auth_sessions_user_id_idx" on "auth_sessions" ("user_id");

create index "auth_accounts_user_id_idx" on "auth_accounts" ("user_id");

create index "auth_verifications_identifier_idx" on "auth_verifications" ("identifier");

create index "auth_oauth_clients_user_id_idx" on "auth_oauth_clients" ("user_id");

create index "auth_oauth_client_resources_client_id_idx" on "auth_oauth_client_resources" ("client_id");

create index "auth_oauth_client_resources_resource_id_idx" on "auth_oauth_client_resources" ("resource_id");

create index "auth_oauth_refresh_tokens_client_id_idx" on "auth_oauth_refresh_tokens" ("client_id");

create index "auth_oauth_refresh_tokens_session_id_idx" on "auth_oauth_refresh_tokens" ("session_id");

create index "auth_oauth_refresh_tokens_user_id_idx" on "auth_oauth_refresh_tokens" ("user_id");

create index "auth_oauth_refresh_tokens_authorization_code_id_idx" on "auth_oauth_refresh_tokens" ("authorization_code_id");

create index "auth_oauth_access_tokens_client_id_idx" on "auth_oauth_access_tokens" ("client_id");

create index "auth_oauth_access_tokens_session_id_idx" on "auth_oauth_access_tokens" ("session_id");

create index "auth_oauth_access_tokens_user_id_idx" on "auth_oauth_access_tokens" ("user_id");

create index "auth_oauth_access_tokens_authorization_code_id_idx" on "auth_oauth_access_tokens" ("authorization_code_id");

create index "auth_oauth_access_tokens_refresh_id_idx" on "auth_oauth_access_tokens" ("refresh_id");

create index "auth_oauth_consents_client_id_idx" on "auth_oauth_consents" ("client_id");

create index "auth_oauth_consents_user_id_idx" on "auth_oauth_consents" ("user_id");

create unique index "auth_oauth_client_resources_client_id_resource_id_uidx" on "auth_oauth_client_resources" ("client_id", "resource_id");

create unique index "auth_device_codes_device_code_uidx" on "auth_device_codes" ("device_code");

create unique index "auth_device_codes_user_code_uidx" on "auth_device_codes" ("user_code");
