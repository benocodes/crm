---
"@vibase/server-d1": minor
---

`vibase-server setup` (and the source `setup:remote`) now defaults a new instance to Better Auth (`--auth better-auth|clerk|none`). It writes `AUTH_PROVIDER` and `PUBLIC_BASE_URL` (no Clerk variable), generates `AUTH_SECRET` once into the instance's secrets file and puts it on the Worker (never rotated by setup), puts an optional `AUTH_GOOGLE_CLIENT_ID`/`AUTH_GOOGLE_CLIENT_SECRET` pair from the same file, bootstraps the instance (marker `better-auth:<env>`, control marker, the `vibase-cli` client, the owner invitation) and prints the owner invitation link once. A re-run never re-issues the link: an existing owner or a pending invitation is reported, nothing is issued. An instance that already has a record keeps its recorded provider (an absent `AUTH_PROVIDER` means `none`), and an `--auth` that differs from the record is refused before any step. Pass `--auth clerk` to keep a Clerk install.
