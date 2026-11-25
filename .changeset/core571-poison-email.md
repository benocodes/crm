---
'@vibase/server-d1': patch
---

One malformed or deeply nested email can no longer stop a mailbox's capture. Deep HTML is parsed under a depth bound that keeps its text, MIME parts nested past 32 multipart levels are ignored, and a message that still cannot be mapped is skipped as `unreadable` (counted, with one warning log line carrying only its ids and the error name) so the page and its cursor move on.
