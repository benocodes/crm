-- [[OPS260]], [[CORE259]] D13: the auth tables moved to the control-plane database (control migration 0001). 0018 stays (forward-only; a CRM database at 0018 had them, empty or not);
-- this drops the 14 copies, children first so no foreign key is ever violated. After every CRM migration the CRM database holds no `auth_*` table. `auth_` stays a reserved prefix.
drop table "auth_oauth_access_tokens";
drop table "auth_oauth_refresh_tokens";
drop table "auth_oauth_client_resources";
drop table "auth_oauth_consents";
drop table "auth_oauth_client_assertions";
drop table "auth_oauth_resources";
drop table "auth_oauth_clients";
drop table "auth_sessions";
drop table "auth_accounts";
drop table "auth_verifications";
drop table "auth_jwks";
drop table "auth_device_codes";
drop table "auth_rate_limits";
drop table "auth_users";
