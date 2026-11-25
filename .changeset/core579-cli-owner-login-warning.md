---
'@vibase/cli': patch
---

`vibase login` (device login) now warns on stderr when the signed-in person is an owner holding a write scope, and points to giving an agent its own identity. stdout and the exit code are unchanged.
