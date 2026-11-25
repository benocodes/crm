---
'@vibase/server-d1': minor
---

On a Better Auth instance, connecting a Gmail mailbox now completes only in a browser signed in as the person who started it. The connect callback refuses a browser with no session, another member's session or a signed-out session with `session_mismatch` (403, or the return redirect), before it contacts Google and with nothing written, so a forwarded authorize link can no longer connect someone else's mailbox under the sender. On Clerk and no-provider instances the callback stays bound by its signed state alone. A person who sees this error signs in to the workspace in that browser and starts the connection again.
