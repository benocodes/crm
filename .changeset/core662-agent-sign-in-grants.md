---
'@vibase/server-d1': minor
'@vibase/cli': minor
---

An agent account's sign-in now holds only what its record grants at that moment: when it approves a login (the device page, or a connector's consent page) the requested scopes are narrowed to its record, so a scope granted later needs `vibase login` as the agent again (same agent id; removals still apply at once). To say so, a `403 insufficient_scope` for a scope the caller's role or record holds but its sign-in lacks now ends with how to fix it (`vibase login`, or reconnect the connector), MCP lists such a tool with that hint, `agents.update` answers with a `sign_in_notice` when it adds scopes to an agent that signs in, and the CLI prints that notice and tells an agent with no scopes to sign in again once granted.
