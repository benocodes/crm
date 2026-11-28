---
title: Create agents and manage permissions
description: Create each agent with the scopes it needs, give it a credential (a sign-in account or an API key), change or remove its scopes, and stop an agent at once.
---

Every agent that works in your instance should have its own identity, so every write is attributed to it and an owner can limit or stop it without touching anyone else. This guide covers creating that identity and managing what it may do. How an agent then reaches the instance is in [the command line guide](/guides/cli/) and [MCP and REST](/guides/mcp-and-rest/); the model behind the scopes is in [permissions and approvals](/concepts/permissions/).

Only an owner can create agents, give them a credential or change their scopes.

## Pick an identity

| The agent | Identity | You create |
| --- | --- | --- |
| An agent that can use a browser | An **agent account**: the agent claims an invitation for it in a browser, then signs in as itself with the CLI's device login (`vibase login`), MCP or the SDK | The agent, then an invitation for it |
| A headless agent, script or service that cannot open a browser | An **API-key agent**: `vibase login --api-key` | The agent, then a key |
| A client such as Claude or Cursor connected over MCP | A **delegated agent**, created when someone consents | What the person approves when consenting, and only what their own role holds; an owner can narrow it, never widen it |

Do not hand an agent your own login. A device login by an owner holds the owner's full authority, and the CLI says so after login.

## Create an agent account

You create the agent first, with the scopes it needs, then give it a credential. A service account works the same way: the identity exists before anyone signs in as it, and with an invitation you never hold the agent's credential.

1. As an owner, create the agent with its scopes:

   ```bash
   vibase agents create --data '{"name":"sales-agent","scopes":["contacts:read"]}'
   ```

   It prints the agent's ID.

2. Create an invitation for that agent. The role is implied:

   ```bash
   vibase invitations create --agent-id <agent-id> --email sales-agent@example.com
   ```

   The link comes back once and nothing is sent. The invitation expires after 7 days, and an address can have one live invitation at a time. Creating another invitation for the same agent revokes its live one, so that is how you reissue a lost link. `vibase invitations list` shows each as pending, accepted, revoked or expired, and `vibase invitations revoke <id>` withdraws a pending one. The agent must exist, and may not be a form agent, a delegated agent, a disabled agent or one that already has an account.

3. Hand the link to the agent over any channel. The agent opens it in a browser and signs up with that email address to claim it: the new account becomes that agent, with the same ID, name and scopes. The browser then shows "Your agent account is ready": the workspace app is for people and admits no agent, so the agent signs in with `vibase login` (or connects over MCP or the SDK) instead.

4. The agent signs in as itself. Device login needs no human approval:

   ```bash
   vibase --profile agent login --server https://crm.mycompany.com
   ```

## Create an API-key agent

For a headless agent that cannot use a browser, so it never claims an invitation. Create the agent, then a key for it.

```bash
vibase agents create --data '{"name":"nightly-sync","scopes":["contacts:read"]}'
vibase api-keys create --agent-id <agent-id>
```

The key is shown once: store it in a secret manager and pass it to the agent on stdin (`printf '%s' "$KEY" | vibase login --api-key --server <url>`). `vibase api-keys revoke <key-id>` stops that key; `vibase api-keys list` shows the keys that exist.

## Grant and change scopes

An agent created without scopes has **no permissions** until you grant them; give it scopes when you create it, or later. A scope is a resource and a permission: `contacts:read`, `tasks:request_approval`, `deals:write`. `read` is separate from the others, so an agent that edits records usually needs both. `write` includes proposing for approval; `request_approval` alone lets an agent propose but never execute.

```bash
# Set the whole list
vibase agents update <agent-id> --data '{"scopes":["contacts:read","contacts:write"]}'

# Or change single grants
vibase agents update <agent-id> --add-scopes '["tasks:read"]' --remove-scopes '["contacts:write"]'
```

`--scopes` replaces the list and cannot be combined with the add and remove forms. Removing a scope the agent lacks changes nothing. Two changes to the same agent at once can answer `409 conflict`; retry.

How a change reaches the agent depends on how it signs in:

- **An API-key agent** reads its scopes on every request: a grant or a removal applies at once.
- **An agent account** (claimed from an invitation, signed in with `vibase login`) holds in its sign-in only the scopes it was granted at that moment. A plain `vibase login` asks for full access, which a person gets as their live role, but an agent account never holds it: the request is narrowed to what the agent was granted. Scopes set when you created the agent are there from the first sign-in; a login made while the agent has none holds none. A scope you grant later reaches the agent when it runs `vibase login` again (same agent account, so the same agent id); until then its requests are refused with `insufficient_scope` and a message saying so, and `agents update` prints the same advice to you. A removal still applies on its next request.
- **A connector** (an MCP client such as Claude) holds what the person approved at its latest sign-in, and a person can approve only what their role holds: the consent page shows the permissions their role lacks as off and disabled ("Your role in this workspace doesn't include this"), and the server cuts an accepted consent to the role even for a hand-made request. When the person's role is raised, reconnecting the client shows the new permissions as available. You can narrow it with `agents update`, but never widen it past what the person approved (`409 scope_not_consented`): a scope it needs beyond that comes from the person reconnecting it and approving the scope. A later sign-in that approves a different list replaces your narrowing, so it is not a lasting limit. The hard limit is an **agent account**: connect the client signed in as the agent account (for a hosted client such as Claude, in a browser signed in as that account) and its ceiling is what you granted the account. A hosted client's own tool controls (Claude can turn tools off or ask for approval per tool) are a layer outside Vibase.

`vibase agents list` and `vibase agents get <agent-id>` show each agent's scopes and whether it is disabled. For a delegated MCP agent (a connector), the instance's Agents page (`/app/agents`) lists it. You can narrow its scopes within what the person approved; a wider list comes from the person reconnecting it and approving the scopes. What a delegated agent can do is also bounded by the person who consented.

A good starting point is read access to what the agent needs and `request_approval` for what it changes, so a person reviews the first proposals. Move a resource to `write` once you trust the agent with it.

## Stop an agent

```bash
vibase agents update <agent-id> --data '{"disabled":true}'
```

This stops the agent at once. Its access tokens would otherwise live until they expire. Set `disabled` to `false` to let it work again.

On a Clerk instance the flow differs: invite the agent in your Clerk application with the public metadata `{"vibase_role":"agent"}` instead of creating the agent and an invitation here. Vibase creates the agent at its first sign-in, with no scopes, and you grant them afterwards with `vibase agents update`. The API-key route, scope changes and disabling work as described above.
