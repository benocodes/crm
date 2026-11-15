---
"@vibase/server-d1": patch
---

Re-admit a removed member on the built-in provider. After an owner removes a member, inviting the same address again now works: the person signs in (password, with the invitation token in the `vibase-invitation` header, or Google, through the existing sign-in button) and gets a new membership with the invitation's role; the removed membership stays as history. A token that does not re-admit (unknown, expired, revoked, another address, an agent invitation, or a person who is already a member) is ignored and the sign-in kept. The `/invite` page gains an "Already have an account? Sign in to accept" mode. No migration.
