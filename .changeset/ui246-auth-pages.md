---
"@vibase/server-d1": patch
---

Auth pages on the built-in provider. The Worker serves `/sign-in`, `/invite` and `/reset-password` (one Preact bundle under `/ui/`, from the release's `assets/ui/`) with a strict content security policy, before the migration gate; on `clerk` and unset these paths are `404 not_found`. `/invite` turns the `/invite#token=` link into an account (the token is read from the fragment and removed from the address); `/sign-in` signs in and out and is the OAuth provider's login page (`loginPage` moved from `/auth/sign-in`); `/reset-password` sets a new password from a `/reset-password#token=` link, and a reset now ends every session of that user. The release's server package ships `assets/ui/` and its layout check requires it. `pnpm build` builds both assets.
