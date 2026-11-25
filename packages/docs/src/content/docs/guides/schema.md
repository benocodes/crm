---
title: Custom objects and fields
description: Declare your own objects and add fields to contacts, companies, deals and tasks in one JSON file, deploy it with redeploy, and know where the file's path is recorded.
---

An instance can carry more than the built-in tables. One JSON file, the **schema file**, declares your own **custom objects** (their own tables, such as `projects__c`) and **extension fields** (your own columns on contacts, companies, deals and tasks). The Worker serves them on create, update, get, list (as filters), the MCP tools and the OpenAPI document, like any built-in field.

The file is plain data: nothing in it is executed, and it is checked against a JSON Schema before anything is read or written. The package ships that schema as `worker/vibase.schema.schema.json`; point your editor at it with `"$schema"` to get completion and validation while you write.

## The file

```json
{
  "version": 1,
  "define": {
    "projects__c": {
      "label": "Projects",
      "description": "Client projects, each linked to a company and a primary contact.",
      "fields": {
        "name": { "kind": "text", "required": true },
        "status": { "kind": "enum", "values": ["planned", "active", "done"], "default": "planned" },
        "budget": { "kind": "integer" },
        "starts_at": { "kind": "timestamp" },
        "company": { "kind": "reference", "target": "companies" },
        "contact": { "kind": "reference", "target": "contacts" }
      }
    }
  },
  "extend": {
    "contacts": {
      "fields": {
        "tier__c": { "kind": "enum", "values": ["standard", "gold"], "default": "standard" }
      }
    },
    "companies": {
      "fields": {
        "customer_number__c": { "kind": "text", "unique": true },
        "renewal_at__c": { "kind": "timestamp" }
      }
    },
    "deals": {
      "fields": {
        "source__c": { "kind": "enum", "values": ["inbound", "outbound", "referral"] }
      }
    }
  }
}
```

- **`define`** declares new custom objects, keyed by `<key>__c`. Each object has `fields`, and optionally a `label` and a `description`.
- **`extend`** adds fields to `contacts`, `companies`, `deals` or `tasks`, keyed `extend.<object>.fields.<name>__c`. No other built-in can be extended.
- **Field kinds:** `text`, `integer`, `boolean`, `timestamp`, `enum` (with `values`) and `reference` (with `target`: a contact, company, deal, task, principal, or a custom object of the same file). A field can also take `label`, `description`, `required`, `default` and `unique`.
- **Limits:** at most 256 KiB.

Rules the validation enforces, among others:

- `extend.contacts` cannot reference contacts (`reference_contacts_self`); use an association.
- A unique field on a built-in cannot also have a `default` (`unique_with_default`), because every row the vault creates itself would take the default and a second one would collide. Use `unique` for business keys such as a customer number.
- Merging two contacts re-points references to the merged contact at the survivor.

### What does not belong here

A channel identifier is an **identity**, not an extension field. A phone number or a direct-message handle goes in `identities`, so lookups, resolve and merge work on it. A LinkedIn profile URL is the same kind of fact, but identities only know the kinds `email` and `phone` today, so there is nowhere to put it yet. Until a new kind exists, keep it in a text extension field of your own and expect to move it.

## Deploy it

A schema change always ships through a redeploy. Review the plan first:

```bash
vibase-server redeploy --env mycompany --schema ./vibase.schema.json --dry-run
vibase-server redeploy --env mycompany --schema ./vibase.schema.json
```

The plan lists what would be created, added (`add: contacts.tier__c`), indexed (`index:`) and archived, with the statements. A refusal (a changed kind or target, a field made required, a unique field that live rows already violate) exits 2 with nothing changed. A real run applies the file's tables to the database after the core migrations, uploads the Worker with the file attached and verifies it. If the apply fails the run exits 3 at the step `apply`, and a rerun plans what is left.

Use `redeploy`, not `upgrade`, when the version number has not changed. `upgrade` has no `--schema` flag.

A field removed from the file **archives** its column: the column stays, the field is no longer served, and nothing is dropped.

## Where the file's path is remembered

The command line does not look for the file in the current directory. You pass `--schema <path>` once.

- **On a real run** (not a dry run), the CLI records the file's **absolute path** in the instance's settings file, `~/.config/vibase/instances/<env>.json`, under `schema`.
- **Later `redeploy` and `upgrade` runs** with no flag read that path and attach the same file again.
- **You can edit the settings file by hand.** The `schema` value must be an absolute path (no `./` and no `~`), or the CLI refuses the settings file. A path written by hand is read but not rewritten.
- **A run with no file** is refused (exit 2) while the live Worker carries one, so a redeploy never drops your objects by accident. Pass `--schema <path>`, or a file with an empty `define` and no `extend` (`{"version":1,"define":{}}`) to drop them on purpose; the tables are kept and reported as archived, never deleted.

If you forget where the file is:

- `vibase-server status --env <env>` prints the live file's SHA-256 digest and its object names, but **not** its path.
- The path is in the settings file under `schema`.
- The live Worker does not hand the file back, so keep it in version control with the rest of your instance's configuration.

The settings file lives in your home folder, not in your project. A second machine or a CI job has no recorded path, so pass `--schema` there.

`/health.schema` reports the attached file's digest and object names, and the extension fields as `fields` (sorted `<object>.<name>__c`). A Worker that cannot load its file answers every route but `/health` with `503 schema_invalid`.

## Not available yet

- **A typed notation.** The file is JSON by design: there are no `defineObject` or `extendObject` calls, and nothing is executed. A helper that emits this same JSON is a possible addition.
- **Finding the file in the project folder.** The CLI does not look for `vibase.schema.json` in your project folder; it takes the file only through `--schema` or the recorded path.
- **More identity kinds** such as a social profile URL.
