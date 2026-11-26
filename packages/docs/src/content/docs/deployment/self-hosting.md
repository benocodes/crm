---
title: Deploy Vibase
description: "Deploy your own Vibase instance to Cloudflare with an interactive setup: install, answer a few questions, and claim the instance."
---

Each Vibase workspace runs in its owner's Cloudflare account: a Worker, two D1 databases (one for your CRM data, one for sign-in and access data) and an R2 bucket for message bodies and files. Sign-in, OAuth consent and CLI device login are built in, so you need no account beyond Cloudflare. This page is the shortest path from nothing to a running instance. Other situations (no domain, upgrades, Google sign-in, recovering the owner, Clerk) have their own pages, linked at the end.

If an instance already exists and you only want to use it, see [using Vibase](/getting-started/quickstart/).

## Before you start

- **Node.js 22.12 or later.**
- **A Cloudflare account** on the Workers Paid plan (password hashing can exceed the Free plan's 10 ms CPU limit on a cold start; this has not been measured on Cloudflare).
- **A domain on that Cloudflare account** for your instance, such as `crm.mycompany.com`. Cloudflare creates the DNS record itself. No domain? See [domains and workers.dev](/deployment/domains/).
- **An email address** for the first owner.
- **A Cloudflare API token** with these permissions (Cloudflare dashboard, My Profile, API Tokens), and your account ID:

The Cloudflare token needs these permissions:

| Scope | Permissions |
| --- | --- |
| Account | Workers Scripts Edit, D1 Edit, Workers R2 Storage Edit, Workers Tail Read, Account Settings Read |
| The domain's zone | Zone Read, Workers Routes Edit |

## 1. Install

```bash
npm install -g @vibase/server-d1
vibase-server --help
```

## 2. Answer a few questions

```bash
vibase-server init
```

Init asks for:

| Question | Answer |
| --- | --- |
| Instance name | Lower-case letters, digits and dashes, such as `mycompany`. It names the resources and the config files. |
| Domain | The domain Vibase is served from, on your Cloudflare account, such as `crm.mycompany.com`. |
| Owner email | The first owner. |
| Auth provider | Press Enter for Better Auth, the built-in sign-in. |
| Email providers | `gmail` (the default) or `none`. |

It shows what it will write and asks `proceed? [Y/n]`. Then it writes two files outside the package, so upgrades never touch them: the settings file (`~/.config/vibase/instances/<name>.json`) and the secrets file (`<name>.env`, mode 600) with the secrets it generated. It prints both paths.

Open the secrets file and fill in the two values only you can supply:

```dotenv
CLOUDFLARE_ACCOUNT_ID=your_cloudflare_account_id
CLOUDFLARE_API_TOKEN=your_cloudflare_api_token
```

Keep this file: later commands read the secrets from it, and a regenerated `AUTH_SECRET` would sign everyone out. If you chose Gmail, back up `CREDENTIALS_KEY` too: losing it makes connected mailboxes unreadable.

## 3. Set up

```bash
vibase-server setup --env mycompany
```

Setup prints its plan and asks `proceed? [Y/n]`. Then it creates the Cloudflare resources, migrates both databases, bootstraps the workspace, deploys the Worker, sets its secrets and verifies the result. Add `--dry-run` to read the plan without changing anything. If a step fails, setup names it and stops: fix the problem and run the same command again. Existing matching configuration is kept.

A new instance gets these resources: the Worker `vb-<name>`, the D1 databases `vb-crm-<name>` and `vb-control-<name>`, and the R2 bucket `vb-bodies-<name>`.

## 4. Claim the instance

The last lines of setup's output are the **owner invitation link**. It is shown once and stored nowhere, so copy it now. Open it in a browser and create the owner account. Then check the instance:

```bash
vibase-server status --env mycompany
curl https://crm.mycompany.com/health
```

Health reports an initialized instance with current migrations. A new custom domain can take a few minutes to resolve; if setup says `not reachable yet`, wait and run `status` again.

Now [sign in with the CLI](/getting-started/quickstart/), then [invite your agents](/guides/agents/).

## If something goes wrong

| Symptom | What to check |
| --- | --- |
| Setup stops at a named step | Fix the reported problem and run the same command again. |
| `status` says `cannot resolve <host> from this machine (DNS)`, or verify says `not reachable yet` | The host has no DNS answer on this machine yet. Wait a few minutes or flush the DNS cache, then run `status`. |
| Verify fails with `500` on `/.well-known/vibase` | The Worker has no `AUTH_SECRET` yet or it has not reached every edge: run the same command again. |
| The program refuses the secrets file | Make it readable by you only: `chmod 600 <file>`. |
| You lost the owner invitation link | See [recover the owner](/deployment/recover-owner/). |

## More

- [Upgrade, redeploy and roll back](/deployment/upgrade/)
- [workers.dev and custom domains](/deployment/domains/)
- [Google sign-in and email](/deployment/sign-in-and-email/)
- [Recover the owner](/deployment/recover-owner/)
- [Custom objects and fields](/guides/schema/), deployed with `vibase-server redeploy --schema`
- [Set up without init, or in CI](/deployment/manual-setup/)
- [Install from a release tarball](/deployment/release-tarball/)
- [Use Clerk instead of Better Auth](/deployment/clerk/)
- [Deploy from source](/deployment/from-source/)
- Gmail needs a Google OAuth client and Pub/Sub; see the server package's README for the checklist. Once it is set up, connect the mailbox from **Connected accounts** in the app.
