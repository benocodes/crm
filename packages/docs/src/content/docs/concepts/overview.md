---
title: Concepts
description: Understand the data and authority model behind Vibase's headless, agentic CRM.
---

Vibase gives people and agents a common CRM to work in. The same contact, deal, or task is available through MCP, CLI, and REST, and every action runs under the caller's authority.

Consider a sales workflow: an agent researches a company, creates contacts, attaches a note, opens a deal, and prepares an email. A person or another authorized agent can review the email. Incoming replies become conversations, and tasks track the next follow-up.

These are the building blocks:

| Concept | What it represents | Example |
| --- | --- | --- |
| [Workspace](/concepts/workspaces-and-agents/) | One organization's CRM and access boundary | Your company's Vibase deployment |
| [Record](/concepts/records/) | A typed business entity | A contact, company, task, or deal |
| [Identity](/concepts/contacts-and-identities/) | An address belonging to a contact or your organization | A contact's work email |
| [Relationship](/concepts/records/#relationships) | A reference or association between records | A research note linked to a company |
| [Conversation](/concepts/conversations/) | Messages and the interactions they create | An email thread with a prospect |
| [Agent](/concepts/workspaces-and-agents/#agents) | Software with an attributed identity and explicit grants | A sales research assistant |
| [Permission](/concepts/permissions/) | Authority to read, propose, or write a resource | `contacts:read` |
| [Operation](/concepts/operations/) | A discoverable action exposed through the interfaces | `contacts.create` |

## From records to action

Start with [records and relationships](/concepts/records/) to understand how CRM data fits together. Then read about [workspaces, users, and agents](/concepts/workspaces-and-agents/) and [permissions and approvals](/concepts/permissions/) before connecting an automation.

The [API reference](/api-reference/overview/) describes the actual fields and operations for each resource.
