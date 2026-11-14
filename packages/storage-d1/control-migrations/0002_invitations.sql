-- Control 0002 (CORE245; CORE243 D14 as revised by CORE259 D3, D9 (c), D12). Invitations and the control-plane audit log, in the control database only (never the CRM database, never a resource: no organization-level events).
-- invitations: one row per invitation. The token itself is never stored: only its SHA-256 (token_hash, unique). Timestamps are ISO-8601 text with milliseconds and a Z, as the CRM tables hold them.
-- Live = not accepted, not revoked and expires_at in the future (judged by the writer's clock, not a stored flag). At most one live invitation per email is enforced by the control store's guarded insert.
-- control_audit: append-only by trigger (UPDATE and DELETE are refused), written by the control store in the same batch as the change it records. detail is JSON and never holds a token or its hash.
-- No foreign key reaches the CRM database (CORE259 D8): organization_id, created_by and actor_id are values.

create table invitations (
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
) strict;

create index invitations_email_idx on invitations (email);

create table control_audit (
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

create index control_audit_target_idx on control_audit (target_type, target_id);

create index control_audit_at_idx on control_audit (at);

CREATE TRIGGER control_audit_no_update BEFORE UPDATE ON control_audit
BEGIN
  SELECT RAISE(ABORT, 'append_only');
END;

CREATE TRIGGER control_audit_no_delete BEFORE DELETE ON control_audit
BEGIN
  SELECT RAISE(ABORT, 'append_only');
END;
