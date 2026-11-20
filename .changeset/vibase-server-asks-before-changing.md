---
'@vibase/server-d1': minor
---

`vibase-server setup`, `upgrade`, `redeploy` and `owner-reset` no longer need `CONFIRM_REMOTE=1` (a set value is ignored). A real run prints its plan and asks `proceed? [Y/n]` once, before its first change: Enter or `y` goes on, `n` stops with nothing changed (exit 0). `--yes` (`-y`), or a run with no terminal on stdin, skips the question; `--dry-run` never asks. `setup` also prints a `steps:` line listing the steps it will run.
