---
title: Invite agents and manage permissions
description: Give each agent its own identity, grant it the scopes it needs, change or remove them, and stop an agent at once.
---

Every agent that works in your instance should have its own identity, so every write is attributed to it and an owner can limit or stop it without touching anyone else. This guide covers creating that identity and managing what it may do. How an agent then reaches the instance is in [the command line guide](/guides/cli/) and [MCP and REST](/guides/mcp-and-rest/); the model behind the scopes is in [permissions and approvals](/concepts/permissions/).

Only an owner can invite agents, create them or change their scopes.

## Pick an identity

| The agent | Identity | You create |
| --- | --- | --- |
| An automation or assistant with a shell | An **agent account**: it claims an invitation and signs in with the CLI's device login | An agent invitation |
| A script or service that cannot open a browser | An **API-key agent** | The agent and a key |
| A client such as Claude or Cursor connected over MCP | A **delegated agent**, created when someone consents | Nothing: grant its scopes after it connects |

Do not hand an agent your own login. A device login by an owner holds the owner's full authority, and the CLI says so after login.

## Invite an agent account

1. As an owner, create an invitation with the `agent` role:

   ```bash
   vibase invitations create --data '{"email":"sales-agent@example.com","role":"agent","delivery":"link"}'
   ```

   `delivery` is `link` (the link comes back once and nothing is sent) or `email` (Vibase emails it, when the instance has email configured). The invitation expires after 7 days, and an address can have one live invitation at a time. `vibase invitations list` shows each as pending, accepted, revoked or expired, and `vibase invitations revoke <id>` withdraws a pending one.

2. Hand the link to the agent over any channel. The agent opens it in a browser and signs up with that email address to claim it.

3. The agent signs in as itself. Device login needs no human approval:

   ```bash
   vibase --profile agent login --server https://crm.mycompany.com
   ```

   It prints the agent's ID. Use it in the next step.

## Create an API-key agent

```bash
vibase agents create --data '{"name":"nightly-sync","scopes":["contacts:read"]}'
vibase api-keys create --agent-id <agent-id>
```

The key is shown once: store it in a secret manager and pass it to the agent on stdin (`printf '%s' "$KEY" | vibase login --api-key --server <url>`). `vibase api-keys revoke <key-id>` stops that key; `vibase api-keys list` shows the keys that exist.

## Grant and change scopes

A new agent has **no permissions** until you grant them. A scope is a resource and a permission: `contacts:read`, `tasks:request_approval`, `deals:write`. `read` is separate from the others, so an agent that edits records usually needs both. `write` includes proposing for approval; `request_approval` alone lets an agent propose but never execute.

```bash
# Set the whole list
vibase agents update <agent-id> --data '{"scopes":["contacts:read","contacts:write"]}'

# Or change single grants
vibase agents update <agent-id> --add-scopes '["tasks:read"]' --remove-scopes '["contacts:write"]'
```

`--scopes` replaces the list and cannot be combined with the add and remove forms. Removing a scope the agent lacks changes nothing. Two changes to the same agent at once can answer `409 conflict`; retry.

Changes apply on the agent's next request: it does not need to sign in again. `vibase agents list` and `vibase agents get <agent-id>` show each agent's scopes and whether it is disabled. For a delegated MCP agent, the instance's Agents page (`/app/agents`) lists it and shows the command to grant its scopes. What a delegated agent can do is also bounded by the person who consented.

A good starting point is read access to what the agent needs and `request_approval` for what it changes, so a person reviews the first proposals. Move a resource to `write` once you trust the agent with it.

## Stop an agent

```bash
vibase agents update <agent-id> --data '{"disabled":true}'
```

This stops the agent at once. Its access tokens would otherwise live until they expire. Set `disabled` to `false` to let it work again.

On a Clerk instance, invite the agent in your Clerk application with the public metadata `{"vibase_role":"agent"}` instead of creating an invitation here; everything else in this guide is the same.
