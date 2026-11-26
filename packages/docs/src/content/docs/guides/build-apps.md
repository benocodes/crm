---
title: Build apps and workflows
description: How people operate the same CRM your agents use, through apps you build and deploy, and how your own workflows react to what happens in it.
---

Vibase has no app of its own. Your agents work in the CRM through MCP, the CLI and REST; the **people** on your team work in it through apps you build and deploy: a deals board, a note taker, a reporting dashboard, a form on your website. Every app talks to the same instance, so what a person does in an app and what an agent does through MCP land in the same records, with the same history and the same permissions.

## The parts

| You want | Use |
| --- | --- |
| A typed way to call the API from TypeScript | The [TypeScript SDK](/guides/sdk/) |
| People to sign in to your app and act as themselves | A [first-party OAuth client](/guides/oauth-clients/), one per app |
| Your workflow engine to react when something happens | [Webhooks](/guides/webhooks/) |
| A form on your website to create a contact | [Website forms](/guides/forms/) |

## How an app works

1. **The app** is an ordinary web app on an origin you control: a static site, a Worker, a Pages project, or anywhere else. Vibase does not host it.
2. **An owner registers it** as a first-party OAuth client with its redirect URI, and adds its origin to the instance's allowed origins. The app can then sign people in with authorization code and PKCE ([how, step by step](/guides/browser-apps/)). It never holds a secret.
3. **A person signs in** and the app receives a bearer token. The person acts as themselves, limited to the scopes you gave that client, and every write is attributed to them.
4. **The app calls the API**, usually through the SDK, which takes the token and gives you typed methods, typed filters, pagination and aggregation. A dashboard needs no raw queries: pipeline value per stage is one `aggregate` call.
5. **Agents and people share the work.** An agent can propose a change and a person approves it in an app. The repository's approvals app is an example that does exactly that.

Build with a coding agent: the instance's own OpenAPI documents and `schema.get` describe its objects and fields, including your custom ones, and the SDK can generate types for them.

## Workflows

Webhooks and forms are the other direction. A webhook calls your workflow engine when a record changes or a message arrives; a form posts from your own site into the CRM. Neither needs an app or a sign-in.
