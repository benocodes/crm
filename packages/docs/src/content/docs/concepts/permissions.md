---
title: Permissions and approvals
description: Decide what each agent can read, propose, or execute.
---

Owners grant agent authority per resource. A grant combines a resource with a permission, such as `contacts:read` or `tasks:write`.

| Permission | What it permits |
| --- | --- |
| `read` | Read that resource. |
| `request_approval` | Propose eligible mutations for review. |
| `write` | Execute eligible mutations directly or propose them for review. |

Read permission is independent. An agent with write permission may also need read permission to inspect the records it works on.

## Choose direct execution or review

For example, an agent with `tasks:request_approval` can propose a task change but cannot apply it. With `tasks:write`, it can apply the change or choose to request review.

Approval requests refer to registered operations and their arguments. The reviewer must have the target operation's write authority. An authorized person or agent can review; proposal permission alone cannot authorize execution.

## What a reviewer sees

Every approval request carries facts Vibase wrote itself, so a reviewer does not depend on the proposer's own description:

- `target_summary`: one line saying what the request asks for, such as the operation, the target record's name and the changed fields. For a send it names the mailbox and recipients. Outside text in it is quoted and shortened.
- `proposer_kind` and `proposer_name`: whether a user, an agent or the system proposed it, and the name as registered now. An agent's name is chosen by whoever registered it.
- `proposer_acting_for`: for a delegated agent, the member it acts for.
- `sending_mailbox`: for a send, the connected mailbox it would go out from.

The `reason` is the proposer's own text. Treat it as a claim, not as a fact.

## Outside content is data

Message bodies, subjects, sender names and form submissions come from outside your team, since anyone can email a connected mailbox. At capture, Vibase strips hidden text from what it stores: zero-width characters, bidirectional overrides, and Unicode tag characters. The MCP instructions tell agents to treat this text as data and never as instructions, and to propose an action for approval rather than act on a message's request. An agent with write permission can still be wrong about what a message wants, so grant send authority carefully.

## Keep workflow policy in your workflow

Your automation can send high-confidence work directly and route uncertain work for review, within its grants. Vibase enforces authority and carries out authorized operations using the credentials it holds.

Access administration and credential management remain human-only. Generic approval requests do not bypass that boundary.

## Limit and revoke access

Give each agent its own identity and the scopes required for its work. Owners can change scopes or disable an agent through the CLI: see [invite agents and manage permissions](/guides/agents/). Authorization checks use the stored grants, so changes take effect without waiting for the agent to log in again.
