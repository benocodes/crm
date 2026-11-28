---
'@vibase/cli': minor
'@vibase/server-d1': minor
---

An agent invitation names an existing agent: `vibase invitations create --agent-id <id> --email <agent-email>` (the role is implied; `--role agent` without `--agent-id` is refused with `agent_id_required`). The agent must exist and may not be a form agent, a delegated agent, a disabled agent or one that already has an account. Creating another invitation for the same agent revokes its live ones, and the invitation records carry `agent_id`. After `vibase agents create`, the CLI prints both routes to a credential (`api-keys create --agent-id`, `invitations create --agent-id`) on stderr, and the owner-login warning names them too. The control database's genesis gains `invitations.agent_id`, so an instance must be reinstalled from this build.
