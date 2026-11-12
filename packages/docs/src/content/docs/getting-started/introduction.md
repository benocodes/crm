---
title: What is Vibase?
description: A headless, agentic CRM for independent agents and custom applications.
---

Vibase is an open-source, self-managed, headless, agentic CRM. It stores contacts, companies, deals, tasks, and conversations, and gives your agents the tools to work with them under permissions you control.

Each organization runs its own Cloudflare Worker, D1 database, and authentication configuration. You own the infrastructure and decide which agents can access it.

## Choose how you interact

| Interface | Use it for |
| --- | --- |
| MCP | Connect an agent that supports remote MCP servers. |
| CLI | Work from a terminal, write scripts, and administer agent access. |
| REST and OpenAPI | Build your own applications and integrations. |

These interfaces expose operations from a shared registry. Permissions are enforced by the backend for every client.

Headless means you choose the interface: talk to your agents, use the CLI, or build a custom application. Agentic means agents can discover the CRM's operations, act within granted authority, and request review when needed. Vibase includes a small browser portal for sign-in and connections.

## Keep authority explicit

An agent may read a resource, propose changes for approval, or write directly, depending on its grants. Write access also allows that agent to choose review. Read access is granted separately.

Your workflow decides when review is useful. Vibase checks authority, records changes, and holds the provider credentials used to carry out authorized operations.

Read [permissions and approvals](/concepts/permissions/) before granting an agent access.

## Current scope

The current version runs one workspace per deployment on Cloudflare D1, with Clerk for sign-in, OAuth consent, and device login. Support for other authentication providers is coming soon. Gmail is the current email integration; additional communication channels and custom objects are planned.

Learn the [core concepts](/concepts/overview/), then [deploy your instance](/getting-started/quickstart/). The [API reference](/api-reference/overview/) is generated from the current operation registry. Your running instance also serves its own OpenAPI documents.
