---
title: workers.dev and custom domains
description: Deploy without a domain on workers.dev, then move to a custom domain later, and what the move breaks.
---

Setup normally needs a domain on your Cloudflare account. These two recipes cover the other cases.

## No domain: use workers.dev

Without a domain of your own, give `--workers-dev` instead of `--api-host`. The instance then lives on `<worker>.<subdomain>.workers.dev` (for `--env mycompany`, the Worker is `vb-mycompany`), and setup derives that host from your Cloudflare account's workers.dev subdomain. It works with Better Auth (the default) and with `--auth none`; it is refused with `--auth clerk`, which needs a custom domain.

```bash
vibase-server setup --env mycompany --workers-dev --owner-email owner@example.com --dry-run
```

```bash
vibase-server setup --env mycompany --workers-dev --owner-email owner@example.com
```

The account needs a workers.dev subdomain. If it has none, setup refuses and tells you where to register one (Cloudflare dashboard, Workers & Pages). Registering is an account-wide, one-time step that only you take: either in the dashboard, or by passing `--register-workers-subdomain <name>` once. Setup never registers one without that flag, never on a `--dry-run`, and never renames an existing subdomain.

```bash
vibase-server setup --env mycompany --workers-dev --register-workers-subdomain mycompany --owner-email owner@example.com
```

Everything else is as in [Deploy Vibase](/deployment/self-hosting/): the same steps, the same owner invitation printed once, the same verify, now on the workers.dev host. The API token needs `Workers Scripts Read` to read the subdomain, and `Workers Scripts Edit` to register it; no zone permission is needed.

## Move to a custom domain

A workers.dev instance moves to a domain of your own with a re-run that names the new host and acknowledges what the move breaks:

```bash
vibase-server setup --env mycompany --api-host api.example.com --change-host
```

Without `--change-host`, a host that differs from the instance's record is refused. With it, setup checks that the new host is on a zone in your account, keeps `workers_dev` on, adds the custom-domain route, rewrites the recorded host and `PUBLIC_BASE_URL`, deploys and verifies on the new host. The same flag moves an instance between two custom domains (the old route is replaced; setup makes no DNS or custom-domain delete call, so detach the old custom domain in the dashboard if it stays attached).

The issuer is the base URL, so a move signs everyone out: every session and token is refused on the new host. After it, people sign in again, run `vibase login` again on each machine, reconnect MCP clients to the new URL, and, when Google sign-in is on, add the new Google redirect URI (`https://<new host>/auth/callback/google`) to the Google OAuth client. There is no grace period for the old issuer. Moving from a custom domain back to workers.dev, and `--change-host` on a Clerk instance, are not offered. A re-run after the move with `--api-host <new host>` alone is a plain re-run.
