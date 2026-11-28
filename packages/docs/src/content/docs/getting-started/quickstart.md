---
title: Quickstart
description: Install the Vibase client, sign in to an existing instance, read and write records, and connect an agent.
---

Use a Vibase instance that someone has already set up: install the command line client, sign in, make your first records, and connect an agent. 
:::note[Don't have an instance yet?]
Start by [deploying one to your Cloudflare account](/deployment/self-hosting/). It takes a few minutes with the interactive CLI, then come back here.
:::

You need Node.js 22.12 or later, the URL of your instance (for example `https://crm.mycompany.com`), and an invitation from the instance's owner.

## 1. Install the client

```bash
npm i -g @vibase/cli@<version>
vibase --version
```

Versions are listed on the repository's Releases page. Until the packages are on npm, install the release's tarball by file, after checking it against the `SHA256SUMS` file of the same release:

```bash
npm i -g ./vibase-cli-<version>.tgz
```

## 2. Sign in

Accept the invitation your instance's owner sends you (on a Clerk instance, the invitation Clerk emails you), then run:

```bash
vibase login --server https://crm.mycompany.com
```

Open the URL the CLI prints, enter the code if prompted, and approve the device login. The CLI stores the OAuth profile and refreshes access tokens automatically.

```bash
vibase me get
```

The result shows who you are and your role. If the role is missing, ask the owner to check your invitation and role (on a Clerk instance, your account's `vibase_role`), then sign in again to obtain a fresh session.

## 3. First reads and writes

```bash
vibase contacts create --name "Ada Lovelace"
vibase contacts list --limit 5
```

`vibase --help` lists every resource the instance offers, and `vibase <resource> --help` its actions. The [command line guide](/guides/cli/) covers profiles and sign-in; [create agents and manage permissions](/guides/agents/) covers agent accounts and API keys.

## 4. Connect an agent

Add `https://crm.mycompany.com/mcp` to a remote MCP client with OAuth support. Complete the browser consent flow, then see the connected agent on the instance's Agents page (`https://crm.mycompany.com/app/agents`) and narrow its permissions with the [CLI](/guides/cli/) if you want it to hold less than the person approved (the page does not edit permissions). OAuth consent is bounded by the person's role and what they approve.

For a standalone automation with its own account, follow [create agents and manage permissions](/guides/agents/). Give each agent the scopes it needs; [read, proposal, and write permissions](/concepts/permissions/) are separate choices.

## Troubleshooting

| Symptom | What to check |
| --- | --- |
| Device authorization is unavailable | The instance's owner must enable device login; see [deploying Vibase](/deployment/self-hosting/). |
| `403 organization_forbidden` | Your account has no recognized role: ask the owner to check the invitation (on Clerk, its `vibase_role`). |
| `vibase: command not found` | The npm global bin directory is not on your `PATH`. |
