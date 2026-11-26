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

## Record extra facts without a deploy

Contacts, companies, deals, tasks and custom objects have an `additional_props` field: a property bag where an agent records a fact that has no field yet, such as `linkedin_title`, with no schema change. The record always has it (`{}` when empty), and it follows the record's own permissions: reading it needs the resource's `read`, writing it needs `write` (or `request_approval` to propose).

- **Values** are a string (up to 1,000 characters), a number or a boolean. No nesting, arrays or `null`. At most 50 keys and 8 KiB per record.
- **Keys** are lowercase snake_case, up to 64 characters, with at most one `:` separating an optional prefix (`linkedin_title`, `scorer:lead_grade`). A convention: a plain key for a fact about the thing, so agents reuse it, and the agent's prefix for its own judgment.
- **Writes** are a merge patch. A key with a value sets it, a key set to `null` removes it, and keys you do not name stay. The field itself cannot be `null`.
- **Discover** the keys in use with `property_keys` (`GET /api/v1/contacts/property-keys`, or the `contacts_property_keys` MCP tool). It returns each key with the number of records that hold it and the value types seen, most used first, up to 200 keys, and no values. Reuse a key before inventing a near-duplicate.
- **Filter** with `additional_props=<key>.<condition>`, for example `additional_props=employees.eq.40`. It takes `eq` (also a bare value), `neq`, `in` and `is`, one condition per request, and reads every record, so narrow the list with other filters too. The bag is not searchable with `q`, sortable or aggregatable.
- **Merging contacts** keeps the survivor's keys and adds the keys it lacks from the merged contact.

When a key proves useful, declare it as a typed field in [your schema file](/guides/schema/) and move the values with ordinary updates.

## Filter lists

A list filters on a field with `field=<operator>.<value>`; a bare value means `eq`. The operators depend on the field's kind: `eq`, `neq`, `gt`, `gte`, `lt`, `lte`, `in`, `like`, `ilike` and `is`, and `not.` in front of any of them. Pass the same field up to four times and the conditions combine, which makes a range:

```text
GET /api/v1/deals?expected_close_date=gte.2026-10-01&expected_close_date=lt.2026-11-01
```

```bash
vibase deals list --expected-close-date gte.2026-10-01 --expected-close-date lt.2026-11-01
```

Over MCP, give the field an array of up to four conditions. Each field also lists its operators in the OpenAPI document and in `schema.get`.

## Count and sum

Contacts, companies, deals, tasks and every custom object have an `aggregate` operation beside `list` (`GET /api/v1/deals/aggregate`, the `deals_aggregate` MCP tool, `vibase deals aggregate`). It takes the same filters as the list, including ranges, and answers without paging through records. The answer always includes `count`, the number of matching records. Add:

| Parameter | Meaning |
| --- | --- |
| `sum`, `avg` | Over one or more integer fields. |
| `min`, `max` | Over one or more integer, timestamp or text fields. |
| `group_by` | One or two fields: references, enums, text, integers and booleans (not `id` or timestamps). One row per value. |

```text
GET /api/v1/tasks/aggregate?status=eq.open&group_by=assignee_id
GET /api/v1/deals/aggregate?group_by=stage_id,currency&sum=amount_minor
GET /api/v1/invoice__c/aggregate?group_by=status&sum=total_minor
```

Without `group_by` the answer is `{ count, sum, ... }`. With it, the answer is `{ count, groups: [{ key, count, sum, ... }] }`, where `count` is the total over all groups. More than 200 groups is a `400`, not a truncated answer. A list offers a function only if it has a field that function accepts: contacts have no integer field, so `sum` appears there only once you add an integer `__c` field.

A deal amount is in one currency's minor units, so summing across currencies is refused with a `400` that tells you to add `currency` to `group_by` or to filter on one currency. A sum over a custom integer field is a plain sum. `schema.get` lists each list's aggregate fields. Every aggregate reads all matching records, so narrow it with filters.
