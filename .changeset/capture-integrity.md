---
'@vibase/server-d1': minor
---

Captured mail is told apart more carefully. A message is recorded as outbound only when the connection sent it (Gmail's SENT label) or the caller says so: a From header that names one of your own addresses no longer makes an incoming mail outbound. A mail that reuses the `Message-ID` of a message already captured, with a different subject, sender or body, is now captured as a message of its own (under the id `gmail:<connection id>:<provider message id>`) instead of being merged into the first. Migration `0028_content_sha256` adds a nullable `messages.content_sha256` fingerprint, never exposed through the API, events or schema; run `vibase-server upgrade` to apply it. Messages captured before this release keep their stored direction and have no fingerprint, so they match any later copy of the same Message-ID.
