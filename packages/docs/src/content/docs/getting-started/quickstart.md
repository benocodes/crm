---
title: Quickstart
description: Deploy a Vibase workspace with Clerk, sign in through OAuth device login, and connect your first agent.
---

Set up a Vibase instance in your Cloudflare account, use Clerk for authentication, and create your first CRM record through the CLI. This gives you browser sign-in, OAuth consent for MCP clients, and device login for the CLI.

Clerk is the supported authentication provider in the current version. **Support for other authentication providers is coming soon.**

## 1. Prepare your accounts and tools

You need:

- Node.js 22.12 or later, pnpm 10.7, and Git.
- A Cloudflare account and an API hostname on a zone in that account, such as `api.example.com`.
- A Clerk application dedicated to this workspace. A development instance works for an evaluation; use a production instance for your deployed business workspace.
- An email address for the workspace's first owner.

```bash
git clone https://github.com/benocodes/crm.git
cd crm
pnpm install
```

The examples use `mycompany` as the environment name. Replace the hostname, environment, and owner email consistently.

## 2. Add deployment credentials

Create a gitignored `.env` at the repository root for Cloudflare access:

```dotenv
CLOUDFLARE_ACCOUNT_ID=your_cloudflare_account_id
CLOUDFLARE_API_TOKEN=your_cloudflare_api_token
```

The token needs these permissions:

| Scope | Permissions |
| --- | --- |
| Account | Workers Scripts Edit, D1 Edit, Workers R2 Storage Edit, Workers Tail Read, Account Settings Read |
| The API hostname's zone | Zone Read, Workers Routes Edit |

Create a separate gitignored `.env.mycompany` for the Clerk application's keys:

```dotenv
CLERK_SECRET_KEY=your_clerk_secret_key
CLERK_PUBLISHABLE_KEY=your_clerk_publishable_key
```

Copy both keys from the same Clerk instance. Setup derives the issuer and JWT verification key. Keep these files out of Git; the Clerk setup refuses to read keys from the root `.env`.

## 3. Configure Clerk sign-in and roles

In your Clerk dashboard:

1. Set **Sign-up mode** to **Restricted** so access is invitation based.
2. Enable the sign-in methods your team will use, such as email codes or Google. Production social sign-in requires your own provider credentials.
3. Leave **Organizations** off for a dedicated Vibase application. The Vibase deployment is the workspace; roles come from user metadata.
4. Under **Sessions → Customize session token**, add this claim while preserving any existing claims:

```json
{
  "vibase_role": "{{user.public_metadata.vibase_role}}"
}
```

Setup invites your first owner with the required public metadata. The role determines access:

| `vibase_role` | Access |
| --- | --- |
| Missing or unknown | No workspace access; Vibase returns `403 organization_forbidden`. |
| `member` | Broad workspace-wide CRM read/write access, including contacts, companies, deals, tasks, and notes. |
| `owner` | Full workspace access, including agent administration. |
| `agent` | Only explicitly granted scopes; a new agent account starts with none. |

**Why restrict sign-up?** This Clerk application controls entry to your organization's CRM. Restricted sign-up keeps account creation invitation based. Public sign-up alone does not grant Vibase access: a new account without a recognized role is refused. However, if you configure Clerk or an automation to assign `member` to every signup, anyone who signs up gains broad access to your workspace's CRM records.

Member permissions apply across the workspace, including records created by other people or agents. They are not limited to the member's own records; individual operations may still enforce additional ownership checks. Assign `member` only to people who should have that access, and use scoped agent identities for automations. See [workspaces, users, and agents](/concepts/workspaces-and-agents/) and [permissions and approvals](/concepts/permissions/) for details.

See Clerk's [session-token customization guide](https://clerk.com/docs/guides/sessions/customize-session-tokens) for the claims editor.

## 4. Review OAuth and device-login setup

Clerk also acts as the OAuth provider for Vibase clients. This is what allows the CLI to show a browser verification code and an MCP client to request consent.

Run the read-only setup plan:

```bash
pnpm -C packages/server-d1 setup:remote -- \
  --env mycompany \
  --auth clerk \
  --api-host api.example.com \
  --owner-email owner@example.com \
  --dry-run
```

**For production Clerk keys, add `--clerk-production` to every setup command, including dry runs.** Finish Clerk's Frontend API and Account Portal domain configuration before proceeding. The device verification page must be reachable on the Account Portal domain.

Setup prints a Clerk checklist. Review these settings:

| Setting | How it is configured |
| --- | --- |
| Restricted sign-up and sign-in methods | Set in the Clerk dashboard. |
| `vibase_role` session claim | Set in the dashboard; verified by your first successful owner sign-in. |
| Custom OAuth scopes | Add missing entries under **OAuth applications → Scopes**, using the exact keys and descriptions printed by setup. Keys include `contacts:read` and `contacts:write`. |
| JWT OAuth access tokens | Setup enables these; Vibase verifies JWT access tokens. |
| Dynamic client registration | Setup enables it for compatible MCP clients. |
| `Vibase CLI` OAuth application | Setup creates or updates a public client with consent, device authorization, the declared Vibase scopes, and `offline_access` for refresh tokens. |
| First owner | Setup invites the owner email or sets the owner role on an existing user that has no role. It refuses to overwrite an existing role. |

Rows marked `manual` still need your attention. A dry run can report a scope catalog as unverified; a real run checks whether Clerk accepts the declared scopes. If that check fails, add the scope entries printed in the report and rerun.

The CLI client ID is written to `AUTH_CLI_CLIENT_ID` in the environment configuration. You do not need to copy a client secret into the CLI. See Clerk's [device authorization guide](https://clerk.com/docs/guides/configure/auth-strategies/oauth/device-authorization-grant) for provider-side prerequisites.

## 5. Provision and deploy

After addressing the checklist, run:

```bash
CONFIRM_REMOTE=1 pnpm -C packages/server-d1 setup:remote -- \
  --env mycompany \
  --auth clerk \
  --api-host api.example.com \
  --owner-email owner@example.com
```

This creates the Cloudflare resources, configures Clerk, and writes the environment to `packages/server-d1/wrangler.jsonc`. **The first run stops after writing that file.** Review and commit the configuration before continuing:

```bash
git add packages/server-d1/wrangler.jsonc
git commit -m "chore: configure mycompany Vibase instance"
```

Keep the working tree clean for deployment, then run the same setup command again, including `--clerk-production` if using production keys. Setup resumes with migrations, bootstrap, deployment, secrets, and verification. It is safe to rerun after correcting a reported problem; existing matching configuration is retained.

Check the deployment:

```bash
curl https://api.example.com/health
curl https://api.example.com/.well-known/vibase
```

Health should report an initialized instance with current migrations. Discovery should report Clerk authentication and a non-null `auth.cli_client_id`.

## 6. Sign in with device login

Accept the invitation Clerk emails to the owner, then run:

```bash
pnpm vibase login --server https://api.example.com
```

Open the URL the CLI prints, enter the code if prompted, and authorize the `Vibase CLI` application as the owner. The CLI stores the OAuth profile and refreshes access tokens automatically.

```bash
pnpm vibase me get
```

Confirm the result shows `kind: user` and `role: owner`. If the role is missing, check the user's public metadata and the session-token claim, then obtain a fresh session.

Create your first record:

```bash
pnpm vibase contacts create --name "Ada Lovelace"
pnpm vibase contacts list --limit 5
```

## 7. Connect an agent

Add `https://api.example.com/mcp` to a remote MCP client with OAuth support. Complete the browser consent flow, then use the instance's `/connect` portal or the [CLI](/guides/cli/) to inspect and grant the connected agent's permissions. OAuth consent is bounded by Vibase's stored agent grants.

For a standalone automation with its own account, follow the [agent-account device login guide](/guides/cli/#give-an-agent-its-own-identity). Give each agent the scopes it needs; [read, proposal, and write permissions](/concepts/permissions/) are separate choices.

## Troubleshooting

| Symptom | What to check |
| --- | --- |
| Setup stops after configuration is written | Review and commit `wrangler.jsonc`, then rerun with a clean working tree. |
| Clerk refuses a custom scope | Add every scope named by the setup report to Clerk's OAuth scope catalog. |
| Device authorization is unavailable | Enable device authorization for `Vibase CLI` and ensure the Account Portal verification page is reachable. |
| Discovery reports `auth: null` or no CLI client ID | Complete the Clerk setup, configuration, secrets, and deploy steps. |
| Owner login has no access | Check the accepted invitation, `public_metadata.vibase_role`, and the session-token claim. |

For later upgrades, see [self-hosting and maintenance](/deployment/self-hosting/). Gmail connection requires additional Google configuration and can be added after sign-in works.
