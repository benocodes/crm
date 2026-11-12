---
title: MCP and REST
description: Discover your instance and connect agents or custom API clients.
---

## Discover an instance

Every instance publishes its interface locations:

```bash
curl https://api.example.com/.well-known/vibase
```

The response includes `api`, `mcp`, `openapi`, and `auth`. Use the URLs returned by your instance so clients follow its configuration.

## Connect through MCP

Add your instance's MCP URL to a client that supports remote HTTP MCP servers:

```text
https://api.example.com/mcp
```

For a Clerk-backed instance, use a client that supports the server's OAuth discovery and authorization flow. Complete consent in the browser, then have an owner grant the connected agent the scopes it needs. Connecting a client does not grant it CRM access automatically.

MCP connections act as agents. The backend checks their grants when tools run, just as it does for CLI and REST calls.

## Call REST directly

CRM records live under `/api/v1`. Workspace configuration and access administration live under `/meta/v1`.

```bash
curl https://api.example.com/api/v1/contacts \
  -H "Authorization: Bearer $VIBASE_API_KEY"
```

Supply an API key or an appropriate access token in the `Authorization` header. Permissions still apply to the authenticated principal.

## Inspect the API contract

Browse the generated [API reference](/api-reference/overview/) for the current code's endpoints, request bodies, and responses.

The instance serves two OpenAPI documents:

```text
https://api.example.com/api/v1/openapi.json
https://api.example.com/meta/v1/openapi.json
```

Use them to inspect request fields, response types, and available operations, or to generate a client for your own application. They describe the running instance's version.
