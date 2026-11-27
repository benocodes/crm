---
'@vibase/server-d1': minor
---

The Gmail sync Workflow is `GmailSyncWorkflow` on the `GMAIL_SYNC` binding (it was `MailSyncWorkflow` on `MAIL_SYNC`), its instance ids start `gmail-sync-`, and a new instance's Workflow is named `vb-gmail-sync-<env>`, so the longest accepted `--env` for `vibase-server setup` is 49 characters. An instance that records a Workflow name keeps it. A deployment config that binds `MAIL_SYNC` must bind `GMAIL_SYNC` with class `GmailSyncWorkflow`; there is no alias for the old binding or class, and the team's `smoked1` and `hq` are reinstalled rather than upgraded.
