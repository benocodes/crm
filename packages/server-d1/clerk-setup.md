# Configuring Clerk for a vault deployment

One Clerk application per vault deployment (each organisation runs its own Worker and its own Clerk app). Clerk handles sign-in and
roles; the vault keeps principals, agents and scopes. Spec: OPS65 (the `--auth clerk` side), CORE64 (what the vault expects).

`setup:remote --auth clerk` checks all of this and configures what Clerk's API allows. Three settings are dashboard-only: do them first.

## Organizations: off

Yes, **Organizations must be disabled** (Dashboard → Configure → Organizations). A D1 deployment is one workspace, so there is nothing for
Organizations to do: membership and roles come from the `vibase_role` claim, not from Clerk orgs. If Organizations are on, the vault ignores
the `o` claim in tokens, so nothing breaks, but setup warns (row C2) because it is a sign of a misconfigured app. Turn it off for clarity.

## Do by hand in the Clerk dashboard

1. **Sign-up mode: Restricted** (Configure → Restrictions → Sign-up mode). Nobody signs up on their own; people join by invitation.
   `Waitlist` is also accepted. Do not use the allowlist instead: listed addresses can still sign up unasked. Setup reads this from
   the Frontend API (`/v1/environment`, `user_settings.sign_up.mode`) and fails on `public` (row C1).
2. **Session token claim** (Configure → Sessions → Customize session token). Add, keeping any claims already there:

   ```json
   { "vibase_role": "{{user.public_metadata.vibase_role}}" }
   ```

   Setup cannot read this; it is confirmed at the owner's first sign-in (`GET /meta/v1/me` shows `role: owner`). Row C3 is always `manual`.
3. **Sign-in methods** (Google, email code, ...): your choice. Google needs your own OAuth client on a production instance. Setup only reports it.
4. On a **production** instance, the Frontend API custom domain needs DNS records. Also reported only.

## Done by `setup:remote --auth clerk` (Backend API)

- Allowed origins: the API host, plus `--web-origin` / `--extra-origin` (added to what is there, never wildcards).
- Dynamic client registration on (unless `--no-dcr`), with the agent-grantable read scopes as the default scopes for registered clients.
- JWT access tokens (instance-wide).
- The `Vibase CLI` OAuth application: public client, device authorization grant, consent screen on, every vault scope plus `offline_access`.
  Its creation also proves the custom scope catalog (Clerk refuses unknown scope keys).
- The first owner: an invitation with `public_metadata.vibase_role = owner` to `--owner-email` (Clerk emails the link).

## Keys

Put the instance's keys in a gitignored `.env.<env>` (`--clerk-env-file`): `CLERK_SECRET_KEY`, `CLERK_PUBLISHABLE_KEY` and `CLERK_JWT_KEY`
(the instance's PEM public key; escape newlines as `\n`). Never use the root `.env` or the process environment; the keys must all come from
one instance. `sk_live_` keys need `--clerk-production`; `sk_test_` keys must not use it.

## Order

1. Create the Clerk application. Organizations off, sign-up Restricted, session-token claim (above).
2. `CONFIRM_REMOTE=1 pnpm -C packages/server-d1 setup:remote -- --env <name> --api-host <host> --auth clerk --owner-email <you> --dry-run`
   and fix every `fail` row (it prints the full checklist in one run).
3. Run it again without `--dry-run`, review and commit `wrangler.jsonc`, run once more to migrate, deploy and verify.
4. Accept the invitation, `vibase login --server https://<api-host>`, and check that `GET /meta/v1/me` shows `role: owner`.
