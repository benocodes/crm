---
title: Use Clerk instead of Better Auth
description: Set up an instance whose sign-in, OAuth consent and device login come from your own Clerk application.
---

Clerk is an optional alternative to the built-in sign-in. Every setup command on this page carries `--auth clerk`; without it a new instance uses Better Auth. An instance keeps the provider it was set up with: changing it later is a migration, not a setup rerun.

Clerk does its sign-in work outside your Worker, so it runs on the Cloudflare Workers Free plan; Better Auth is designed for Workers Paid.

You also need a Clerk application dedicated to this workspace. A development instance works for an evaluation; use a production instance for your deployed business workspace. Create the secrets file with the Clerk application's keys as well:

```dotenv
CLERK_SECRET_KEY=your_clerk_secret_key
CLERK_PUBLISHABLE_KEY=your_clerk_publishable_key
```

Copy both keys from the same Clerk instance; setup derives the issuer and the JWT verification key. Clerk's setup uses Clerk, not Better Auth, for sign-in, OAuth consent and CLI device login.

## Configure Clerk sign-in and roles

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

## Review OAuth, device login and the Clerk setup plan

Clerk also acts as the OAuth provider for Vibase clients. This is what allows the CLI to show a browser verification code and an MCP client to request consent.

Run the read-only setup plan, then read what it prints. The dry run reads configuration and the Clerk keys, and changes nothing:

```bash
vibase-server setup --env mycompany --auth clerk --api-host crm.mycompany.com --owner-email owner@example.com --dry-run
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

The CLI client ID is written to `AUTH_CLI_CLIENT_ID` in the instance configuration. You do not need to copy a client secret into the CLI. See Clerk's [device authorization guide](https://clerk.com/docs/guides/configure/auth-strategies/oauth/device-authorization-grant) for provider-side prerequisites.

## Apply Clerk setup

After addressing the checklist, run the same command without `--dry-run`:

```bash
vibase-server setup --env mycompany --auth clerk --api-host crm.mycompany.com --owner-email owner@example.com
```

Setup creates or adopts the Cloudflare resources, configures Clerk, writes the settings file, migrates the database, bootstraps the owner, deploys the Worker, sets its secrets and verifies it. It stops at the first failed step and names it; rerun the same command after correcting the problem. Existing matching configuration is retained.

A new instance's resources are named `vb-<env>` (Worker), `vb-crm-<env>` (D1), `vb-control-<env>` (the control-plane D1 database) and `vb-bodies-<env>` (R2). Setup creates the control database for every instance, migrates it before the CRM database, and pairs the two with a marker written after the CRM deployment row. A rerun takes the names recorded in the settings file and refuses a name flag that differs from them; an instance recorded without a control database gets one added on its next run. To adopt resources created under other names, such as an older `vault-<env>` instance with no settings file, pass `--worker-name`, `--d1-name`, `--control-d1-name` and `--r2-name` on the first run.

Check the deployment:

```bash
curl https://crm.mycompany.com/health
curl https://crm.mycompany.com/.well-known/vibase
```

Health should report an initialized instance with current migrations. Discovery should report Clerk authentication and a non-null `auth.cli_client_id`. Then tell the owner to accept the Clerk invitation and [sign in with the CLI](/getting-started/quickstart/).
