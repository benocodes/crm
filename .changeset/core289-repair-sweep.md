---
"@vibase/server-d1": patch
---

Control-plane repair sweep. On a `better-auth` instance the one-minute rail cron now revokes the sessions, OAuth tokens and device codes of any linked account that has lost its authority (a removed member, a disabled agent), and deletes accounts older than 24 hours that no CRM user or agent names and no invitation admitted. `vibase-server status` and `db:status:remote` print, after the control database's migration diff, how many subjects and orphan accounts the next sweep would act on (`[control] sweep: ...`); the counts never change the exit code. No migration.
