# @vibase/cli

## 0.4.0

### Minor Changes

- 8396747: An agent invitation names an existing agent: `vibase invitations create --agent-id <id> --email <agent-email>` (the role is implied; `--role agent` without `--agent-id` is refused with `agent_id_required`). The agent must exist and may not be a form agent, a delegated agent, a disabled agent or one that already has an account. Creating another invitation for the same agent revokes its live ones, and the invitation records carry `agent_id`. After `vibase agents create`, the CLI prints both routes to a credential (`api-keys create --agent-id`, `invitations create --agent-id`) on stderr, and the owner-login warning names them too. The control database's genesis gains `invitations.agent_id`, so an instance must be reinstalled from this build.
- 8bbd20e: `vibase gen types --out <dir>` writes the typed SDK map of the instance you are signed in to: `operations.ts` and `types.ts` with its custom objects and `__c` fields, for `createClient({ operations })`. It needs `openapi-typescript` 7 (with `typescript` 5) in the project it runs in.

### Patch Changes

- a6c1380: An agent account that claims its invitation now sees "Your agent account is ready" with how to sign in (`vibase login`, MCP or the SDK) instead of "No access to this workspace". The CLI's owner-login warning names both routes for an agent identity: an invitation for an agent that can use a browser, and `agents create` with `api-keys create` for a headless one.

## 0.3.0

### Minor Changes

- e09f55c: A custom object declared as plain data is now served by the generic layer on D1: full CRUD with soft delete, events, scopes, proposals and associations, under its one `<key>__c` name. Nothing in the Worker passes a declaration yet (the schema file arrives in a later release), so a deployment behaves as before. The CLI spells a custom object's command and a `__c` flag with the same kebab rule as a built-in's, keeping the `__c` suffix (`session-recordings__c`, `--referral-source__c`).
- 58d43a5: Every custom object now carries the `additional_props` bag too (a new `__c` table gets the column, and `vibase-server redeploy` adds it to an existing one, once). Lists of contacts, companies, deals, tasks and custom objects, and `deals aggregate`, take `additional_props=<key>.<condition>` (`eq`, `neq`, `in`, `is.null`, `not.is.null`; a string matches by its text, a number or boolean by its JSON literal; no index serves it). A new read, `<resource>.property_keys` (`GET /api/v1/<resource>/property-keys`, MCP `<resource>_property_keys`, CLI `<resource> property-keys`), lists the bag keys in use with record counts and JSON types, never a value. `schema.get` describes the bag column's rules.
- 5ffe344: A column filter flag can be repeated to send a range: `vibase deals list --expected-close-date gte.2026-11-01 --expected-close-date lt.2026-12-01` sends two conditions, which AND together (up to 4 per field; the server refuses a fifth). `--help` marks the flags that may repeat. The filter parameter descriptions in the OpenAPI documents, the MCP tools and `schema.get` no longer say "once per field": they say the parameter may repeat and give a range example for text, integer and timestamp fields.
- 9991cf3: A person's default `vibase login` on the built-in provider now asks for the wildcard `all_permissions` (named in discovery as `auth.full_access_scope`) instead of a snapshot of every scope, so the person holds their live role, including permissions declared after they signed in, on the same token (their role is read on every request, so a demotion applies at once). A login made before this version keeps its list, so run `vibase login` once to get full access. A `--scope` login stays limited to its list, `--scope all_permissions` is refused, an agent account that approves the wildcard gets its record at that moment and never the wildcard, a connector cannot ask for it, and the device page states full access in words. `agents.create` and `agents.update` now accept any custom scope the registry declares, whatever scopes the caller's own sign-in lists.
- 0b344a0: An agent account's sign-in now holds only what its record grants at that moment: when it approves a login (the device page, or a connector's consent page) the requested scopes are narrowed to its record, so a scope granted later needs `vibase login` as the agent again (same agent id; removals still apply at once). To say so, a `403 insufficient_scope` for a scope the caller's role or record holds but its sign-in lacks now ends with how to fix it (`vibase login`, or reconnect the connector), MCP lists such a tool with that hint, `agents.update` answers with a `sign_in_notice` when it adds scopes to an agent that signs in, and the CLI prints that notice and tells an agent with no scopes to sign in again once granted.
- 371360d: A task's free text is now `description` instead of `notes`, on every surface: the `tasks` table and its full-text index, the REST, MCP and CLI task commands and filters, `tasks aggregate --group-by`, the schema document, task events and webhook payloads. There is no `notes` alias: sending `notes` on a task is refused like any other unknown field. The notes resource is unchanged. There is no upgrade path: the change edits the genesis migration in place, so an existing instance is reinstalled, as for the genesis squash.
- 7f56ed3: A custom object's name now follows each surface's case convention and keeps its `__c` suffix: a multi-word object `session_recordings__c` is served at `/api/v1/session-recordings__c` (its `schema.get` `path` says so), its CLI command is `vibase session-recordings__c <action>`, and a flag for a multi-word `__c` field is `--referral-source__c` (the request still carries `referral_source__c`). The old spellings are gone, with no alias: `/api/v1/session_recordings__c` is a 404 and `--referral_source__c` an unknown flag. Stored names, schema file keys, operation ids, MCP tool names, scopes, event types and every JSON or query field name keep the snake_case `__c` name; one-word objects such as `projects__c` and every built-in are unchanged. The generated SDK map (`@vibase/sdk`) names the namespace `sessionRecordings__c`. No migration.

### Patch Changes

- 4a65cad: `vibase login` (device login) now warns on stderr when the signed-in person is an owner holding a write scope, and points to giving an agent its own identity. stdout and the exit code are unchanged.

## 0.2.1

### Patch Changes

- 0dfefd6: The published README is now the repository's root README: what Vibase is, install, a short quickstart and a link to https://docs.vibase.ai. The `@vibase/server-d1` README links to the documentation too.

## 0.2.0

### Minor Changes

- 0f29f3c: `connections.update` (`PATCH /meta/v1/connections/{id}`, MCP tool `connections_update`, CLI `vibase connections update <id>`): the owner of a connection, signed in, changes its capture settings (labels, blocked senders, group-address and personal-domain exclusion, contact creation) in one call. A list replaces the whole list; every accepted call emits one `connection.updated`. The `connections:write` scope now reads "Connect and disconnect mailboxes, and change their capture settings".
- 8cb1cea: The workspace blocklist, `blocked_senders` (REST `/meta/v1/blocked-senders`, MCP tools `blocked_senders_*`, CLI `vibase blocked-senders list|get|create|delete`): an owner, signed in, blocks addresses and domains for every mailbox of the workspace and lifts them again; anyone holding the new `blocked_senders:read` scope reads the list. `blocked_senders:write` is owner-only and not agent-grantable; the list is not proposable. Every change emits `blocked_sender.created` or `blocked_sender.deleted`. Capture does not apply the list yet.

### Patch Changes

- c2747c0: Read the control-plane audit log. `audit.list` (`GET /meta/v1/audit`, MCP tool `audit_list`, `vibase audit list`) browses `control_audit` (invitations created, revoked and accepted, sessions revoked on removal, reset links issued) oldest first, filtered by exact `action`, `target_type` and `target_id`, paged by `limit` (1 to 200, default 50) and `after`/`next_cursor`. New scope `audit:read`: held by every owner, never by a member, and an owner may grant it to an agent; it is not in any default grant (the bootstrap agent, Clerk's default scopes, the registration default list). A deployment without a control-plane database answers `501 provider_not_configured`. Reading writes nothing. Clerk instances gain the scope in their catalog when `setup:remote` is next run.
