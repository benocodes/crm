---
title: Recover the owner
description: Issue a password reset link for an owner, or a new owner invitation, when you hold the instance's Cloudflare credentials.
---

An owner who forgets their password has no self-service reset while email is off. Anyone holding the instance's Cloudflare credentials can issue one with `vibase-server owner-reset --env <name>`:

```bash
vibase-server owner-reset --env mycompany --dry-run
vibase-server owner-reset --env mycompany
vibase-server owner-reset --env mycompany --email owner@example.com
```

With one Better Auth owner, it prints a one-time reset link for them. With several, pass `--email` to name one; without it the command refuses and lists them. The link is a Better Auth reset link on your own host (`https://<your host>/app/reset-password#token=...`), valid for one hour; opening it sets a new password and signs that owner out everywhere. It is printed once and stored nowhere, and the audit log records that a link was issued (when, by the system, never the link). A second run prints a new link. `--dry-run` reads only: it names the owner (or the invitation) it would use and prints no link.

If the instance has no owner at all, `owner-reset --email <address>` issues an owner invitation for that address instead and replaces any live owner invitation, printed once the same way. An instance whose owners sign in through another provider is refused: recover those through that provider.

The command composes Better Auth on your machine with the instance's `AUTH_SECRET`, so keep the secrets file that setup wrote (`<env>.env`, mode 600): without `AUTH_SECRET` in it the command refuses, and a new value would sign everyone out. If the Worker has one and your file does not, copy it in.
