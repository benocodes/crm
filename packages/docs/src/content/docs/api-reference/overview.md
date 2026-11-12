---
title: API reference
description: Browse the current Vibase REST contract, generated from its operation registry.
---

This reference is generated from the **current code's OpenAPI 3.1 documents** on every documentation build. It uses the same router and operation registry that publish the API contract on a running Vibase instance.

| Reference | Covers | Download |
| --- | --- | --- |
| [Records API](/api-reference/records/) | CRM records, conversations, and action requests/executions | [OpenAPI JSON](/openapi/api.json) |
| [Workspace API](/api-reference/workspace/) | Connections, agents, access administration, pipelines, and schema discovery | [OpenAPI JSON](/openapi/meta.json) |

Each operation page describes its method, path, parameters, request body, and responses. Use your own instance's origin when making requests.

## Authentication

Pass an appropriate access token or agent API key as a Bearer credential:

```bash
curl https://api.example.com/api/v1/contacts \
  -H "Authorization: Bearer $VIBASE_ACCESS_TOKEN"
```

Follow the [Clerk quickstart](/getting-started/quickstart/) to configure OAuth and device login. Authentication identifies the caller; [permissions](/concepts/permissions/) determine which operations it can perform.

## Match your deployment's version

An instance can run an older version than this site. Its own documents describe what it accepts:

```text
https://api.example.com/api/v1/openapi.json
https://api.example.com/meta/v1/openapi.json
```

Use `https://api.example.com/.well-known/vibase` to discover those URLs. The published JSON downloads are unmodified exports of the router's documents. Use real record IDs and your own credentials when making requests.
