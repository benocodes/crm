---
name: sprint-checkpoint
description: One-phrase sprint checkpoint. When the user says "sprint-checkpoint" (or "/sprint-checkpoint") or asks "where are we in the sprint", verify knowledge/SPRINT.md against repo evidence, fix what's stale, commit it, and end with a one-sentence verdict.
---

# Sprint Checkpoint

File format and evidence rules live in `sprint-planning`; this is just the routine.

1. No `knowledge/SPRINT.md` → no sprint in flight; say so, stop.
2. If a `CYCLE REPORT` is in context (a coding agent's final message, defined in `execute-cycle`),
   start from it: it names the commits, migration, gate results, decisions and what's owed. Spot-check its claims (shas exist, RETRO exists, spec
   `status:` matches) rather than re-deriving them; a claim that doesn't check out is a finding.
   Carry its "Owed by the user" and Decisions into SPRINT.md.
3. Otherwise check the file against evidence, not memory: spec `status:`, cycle folders
   (PLAN/HANDOFF/RETRO), `git log --oneline`, `git status --short`, deploy claims vs RETROs.
4. Next migration = highest in `packages/db/migrations` + 1, unless a branch in flight already adds it.
5. Fix stale lines in place and bump `Updated:`. All specs shipped → don't edit; say `/sprint-planning close` is due.
6. If changed: `SPRINT.md` lives in the nested knowledge repo, so check its branch
   (`git -C knowledge rev-parse --abbrev-ref HEAD`), `git -C knowledge add SPRINT.md` only, commit
   `docs(sprint): …`.

End with one line on what changed (or "already current"), then one sentence:

- Current item done → `The next sprint item is <action> <ID>, with its migration at <NNN>.` (drop the migration clause if no schema change)
- Not done → `This sprint item still requires: <concrete steps from evidence>.`
