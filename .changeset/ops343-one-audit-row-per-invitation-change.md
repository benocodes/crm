---
"@vibase/server-d1": patch
---

An invitation acceptance or revoke now writes exactly one audit row, even when two requests for the same invitation arrive at the same moment (before, both could write one). No migration.
