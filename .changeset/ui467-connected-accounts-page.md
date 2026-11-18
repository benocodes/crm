---
'@vibase/server-d1': minor
---

The workspace app gains the **Connected accounts** page at `/accounts`, with its sidebar row (shown to anyone who can read connections). It lists the workspace's mailboxes in two sections, Your mailboxes and Other mailboxes, with each mailbox's address and status. **Connect Gmail** starts the Google consent flow, and **Reconnect** on your own mailbox that needs it; the page also shows the outcome the Gmail callback returns (`connection_id` or `error` in the query) and then removes it from the URL. `/accounts` is served, and accepted as a sign-in return target, wherever `/home` is; the packaged `wrangler.jsonc` lists it in `run_worker_first`. `@vibase/api` exports the callback's error sentences as `CONNECT_ERROR_TEXT`.
