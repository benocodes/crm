---
"@vibase/server-d1": patch
---

The `/connect` page works on `better-auth`: it signs the person in through the instance's own `/sign-in`, shows them and their agents (OAuth-delegated ones included), signs out, and is served under a `'self'`-only Content Security Policy with no third-party host. On `clerk` the page and policy are unchanged; two shared lines of copy no longer name Clerk.
