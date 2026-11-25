---
'@vibase/server-d1': patch
---

Only an owner can create, read, update, delete or rotate OAuth clients through the sign-in server's client endpoints, and a registration that carries a member's session is refused (an unauthenticated registration works as before). The hourly repair sweep also deletes device codes past their expiry and dynamically registered clients that were never used (no token or consent, no owner, older than 7 days), at most 500 of each per run. Google's signing keys are cached for 5 minutes per Worker and shared by Gmail push and the connect callback, with at most one fetch a minute; a push answers 503 while Google's keys are unavailable.
