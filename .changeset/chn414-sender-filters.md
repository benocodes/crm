---
'@vibase/server-d1': minor
---

Email capture now applies sender filters per mailbox, going forward: a message is skipped before anything of it is stored when any other party matches the blocklist (an address, or a domain with its subdomains), and, when the mailbox opted in, when the sender is a group address (`support@`, `noreply@`) or a personal-mail domain (gmail.com). Mail already captured stays.
