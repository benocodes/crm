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

## Keep workflow policy in your workflow

Your automation can send high-confidence work directly and route uncertain work for review, within its grants. Vibase enforces authority and carries out authorized operations using the credentials it holds.

Access administration and credential management remain human-only. Generic approval requests do not bypass that boundary.

## Limit and revoke access

Give each agent its own identity and the scopes required for its work. Owners can change scopes or disable an agent through the [CLI](/guides/cli/). Authorization checks use the stored grants, so changes take effect without waiting for the agent to log in again.
