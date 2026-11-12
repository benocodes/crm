---
title: Workspaces, users, and agents
description: Understand who owns the data, who can sign in, and how agent identities are attributed.
---

A **workspace** is one organization's Vibase deployment. It has its own API URL, D1 database, storage, and authentication configuration. All clients connecting to that instance work within the same organization.

Clerk handles sign-in and user roles in the current version. A workspace uses its own Clerk application; it does not require Clerk Organizations. Support for other authentication providers is coming soon.

## Users

Users are people admitted by your authentication provider. The `vibase_role` claim identifies an `owner`, `member`, or `agent` account.

Owners administer access and have the workspace's full authority. Members receive the permissions defined for the member role. An account with the `agent` role becomes an agent principal and needs explicit resource grants.

## Agents

An agent is software with its own identity and permissions. Each agent's stored scopes define what it may do. Two common ways to connect are:

| Agent type | How it authenticates | Who authorizes access |
| --- | --- | --- |
| Agent account | Its own Clerk account, including CLI device login | An owner grants its scopes. |
| Delegated agent | An OAuth client authorized by a person, such as an MCP client | Consent and stored grants are bounded by the delegating user's authority. |

Agents may also authenticate with their own Vibase API keys. The key identifies an agent; it does not turn the caller into a human owner.

The CLI's first-party device login lets a person perform administration as themselves. A remote MCP client acts as a delegated agent with its own grants.

## Attribution

A **principal** is an actor Vibase can attribute work to: a user, an agent, or the system. CRM operations record the caller's identity, so an agent's work remains distinguishable from a person's work.

Use a separate identity for each automation you want to grant, audit, or disable independently.

## Grant and revoke authority

An owner can update an agent's scopes or disable it. OAuth authentication establishes identity; Vibase still checks its stored grants when each operation runs.

See [permissions and approvals](/concepts/permissions/) for the authority model and the [CLI guide](/guides/cli/) for commands.
