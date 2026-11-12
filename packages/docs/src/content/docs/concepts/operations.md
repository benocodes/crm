---
title: Operations and discovery
description: Learn how MCP, CLI, and REST expose the same registered CRM operations.
---

An **operation** is a named action, such as `contacts.create`, `tasks.update`, or `deals.move_stage`. It defines accepted inputs, returned data, validation, and required authority.

Vibase exposes registered operations through REST, MCP, and the CLI. Clients can discover what the instance supports instead of maintaining their own catalog of CRM actions.

## Two API surfaces

| Surface | Purpose | Examples |
| --- | --- | --- |
| `/api/v1` | Business records and CRM actions | Contacts, deals, tasks, messages, action requests |
| `/meta/v1` | Workspace configuration and access | Agents, API keys, pipelines, schema discovery |

The [API reference](/api-reference/overview/) is generated from both surfaces' current OpenAPI documents. A running instance publishes its own documents, which describe that deployment's version.

## Discover an instance

`/.well-known/vibase` identifies the API, MCP endpoint, OpenAPI documents, and authentication configuration. The CLI reads this document to discover commands and login settings.

Clients with `schema:read` can also call `schema.get` to inspect the workspace's data model. This is useful when building a custom interface or asking an agent to work with unfamiliar resources.

## Changes and execution

Resource writes record events alongside the change, retaining actor attribution and before/after information. This event history is separate from the messages captured from a provider.

Operations that support approval can be submitted as action requests using the same operation name and arguments. Authorized asynchronous work creates an action execution for retries and final outcomes.

See [MCP and REST](/guides/mcp-and-rest/) to connect a client, and [permissions and approvals](/concepts/permissions/) to understand when an operation can run.
