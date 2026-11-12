---
title: Records and relationships
description: Model your customer relationships with typed CRM records, references, and associations.
---

A **resource** is a kind of information exposed by Vibase, such as contacts or tasks. A **record** is one item of that resource: a particular person, company, or follow-up.

Records have typed fields and stable IDs. For example, a contact has a name and an optional primary company; a task has a title, status, due date, and optional assignee. The API generates IDs and records the actor and timestamps.

## Core CRM resources

| Resource | Purpose |
| --- | --- |
| Companies | Organizations you do business with, including their names and domains. |
| Contacts | People you work with, linked to their addresses through identities. |
| Deals | Opportunities with an owner, stage, optional amount and currency, and expected close date. |
| Tasks | Follow-up work, with assignment, due dates, and open or done status. |
| Notes | Written context and research, with Markdown content. |
| Tags | Labels you can associate with supported records. |

Conversation resources capture the communication around those records. See [conversations and connections](/concepts/conversations/).

## Relationships

Some relationships are explicit fields. A contact's `company_id` identifies its primary company, and a task's `assignee_id` identifies who is responsible.

**Associations** connect supported records without adding a field to either one. A note can relate to a contact and a company; a deal can relate to a company, several contacts, and follow-up tasks. The current association relation is `related_to`, and allowed endpoint types depend on the resource.

References and associations serve different purposes. Use the contact's primary-company field for its primary employer and associations for additional context. Use the API's declared filters to retrieve records by their links.

## Deals, pipelines, and stages

A pipeline defines a business process. Its stages describe progress, and each stage has a kind: `open`, `won`, or `lost`. A deal belongs to one stage; its status is derived from that stage's kind.

Move a deal with the `deals.move_stage` operation. Pipeline and stage configuration lives in the workspace API, while deals live in the records API.

Amounts are integers in a currency's minor units, such as cents for USD. Supply a currency with an amount; the API reference describes the validation rules.

## Discover fields before writing

Use the [API reference](/api-reference/overview/) for request and response types. An authenticated client with `schema:read` can also inspect the running instance through `schema.get`, which describes its tables, columns, relationships, and API resources.

The current version provides built-in CRM resources. Custom objects are planned.
