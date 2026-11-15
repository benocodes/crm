---
"@vibase/server-d1": minor
---

Owner recovery. `vibase-server owner-reset --env <name> [--email <owner>] [--dry-run]` (and, from a source checkout, `CONFIRM_REMOTE=1 pnpm -C packages/server-d1 bootstrap -- --remote --env <name> --owner-reset`) prints a one-time Better Auth reset link for an owner who lost their password, once and stored nowhere, with an audit row that never holds the link; it needs the instance's Cloudflare credentials and the `AUTH_SECRET` in the secrets file. With no owner at all it issues an owner invitation for `--email` instead. Owner invitations are now replaced in one set-based control batch with no read first (bootstrap's re-run uses it too), and a refused replace writes nothing. The no-email statement setup prints gains its owner sentence, and setup's "owner invitation pending" line names the command that issues a new link.
