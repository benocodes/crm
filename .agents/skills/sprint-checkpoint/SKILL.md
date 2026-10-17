---
name: sprint-checkpoint
description: One-phrase sprint checkpoint. When the user says "sprint-checkpoint" (or "/sprint-checkpoint") or asks "where are we in the sprint", verify knowledge/SPRINT.md against repo evidence, fix what's stale, commit it, and end with a one-sentence verdict.
---

# Sprint Checkpoint

File format and evidence rules live in `sprint-planning`; this is just the routine.

1. No `knowledge/SPRINT.md` → no sprint in flight; say so, stop.
2. If an `EPIC REPORT` is in context (a coding agent's final message — the `Completion Report`
   section every PLAN ends with), start from it: it names the commits, migration, test results,
   retro, ingested lessons and what's owed. Spot-check its claims (shas exist, RETRO exists, spec
   `status:` matches) rather than re-deriving them; a claim that doesn't check out is a finding.
   Carry its "Owed by Ori" and open questions into SPRINT.md.
3. Otherwise check the file against evidence, not memory: spec `status:`, epic folders
   (PLAN/HANDOFF/RETRO), `git log --oneline`, `git status --short`, deploy claims vs RETROs.
4. Next migration = highest in `packages/db/migrations` + 1, unless an unexecuted PLAN already claims it.
5. Fix stale lines in place and bump `Updated:`. All specs shipped → don't edit; say `/sprint-planning close` is due.
6. If changed: check the branch, `git add knowledge/SPRINT.md` only, commit `docs(sprint): …`.

End with one line on what changed (or "already current"), then one sentence:

- Current item done → `The next sprint item is <action> <ID>, with its migration at <NNN>.` (drop the migration clause if no schema change)
- Not done → `This sprint item still requires: <concrete steps from evidence>.`
