---
'@vibase/server-d1': minor
---

Accepting an agent invitation links the new sign-in account to the agent it names: the account becomes that agent (same id, name and scopes, its API keys keep working), and no invitation creates an agent any more. An agent that is disabled, delegated, unknown or already linked refuses the sign-up and leaves the invitation pending.
