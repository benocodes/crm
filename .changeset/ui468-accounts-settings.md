---
'@vibase/server-d1': minor
---

The workspace app's Connected accounts page (`/accounts`) gains a mailbox settings view (`/accounts?connection=<id>`): the owner edits the mailbox's capture labels, blocked senders, group-address and personal-domain filters and contact creation and saves them in one step; everyone else reads them. Every mailbox row offers Settings, Disconnect (after a confirmation that says captured mail stays) and, on connected mailboxes, Sync now.
