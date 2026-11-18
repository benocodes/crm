---
name: sprint-checkpoint
description: One-phrase sprint checkpoint. When the user says "sprint-checkpoint" (or "/sprint-checkpoint") or asks "where are we in the sprint", verify knowledge/SPRINT.md and the active milestone's note against repo evidence, fix what's stale, commit it, and end with a one-sentence verdict.
---

# Sprint Checkpoint

File format and evidence rules live in `sprint-planning`; this is just the routine.

1. No `knowledge/SPRINT.md` → no sprint in flight; say so, stop (`/sprint-planning open` starts the next
   milestone). Otherwise its header names the milestone; its note is
   `knowledge/milestones/*-<letter>-*/milestone-<letter>.md`.
2. If a `CYCLE REPORT` is in context (a coding agent's final message, defined in `execute-cycle`),
   start from it: it names the commits, migration, gate results, decisions and what's owed. Spot-check its claims (shas exist, RETRO exists, spec
   `status:` matches) rather than re-deriving them; a claim that doesn't check out is a finding.
   Carry its "Owed by the user" into SPRINT.md. Its Decisions are not copied: the agent that made them
   recorded them in the decisions log (`scripts/decisions.mjs`).
3. Otherwise check the file against evidence, not memory: spec `status:`, cycle folders
   (PLAN/HANDOFF/RETRO), `git log --oneline`, `git status --short`, deploy claims vs RETROs.
4. Next migration = highest in `packages/db/migrations` + 1, unless a branch in flight already adds it.
5. Fix stale lines in place and bump `Updated:` (and the note's `updated`). Update in this order: the State
   cells of the note's Needed table and its Left section, then `SPRINT.md`'s Now / Next, then **Status at a
   glance** (three lines, from the note). Every row but the demo run ✅ → don't edit; say
   `/sprint-wrap-up close` is due.
6. **Keep it short** (budget and rules in `sprint-planning`, "The file"): Position at most 5 lines, only
   open questions, no decisions (they live in the decisions log), the file under 150 lines. Move overflow
   verbatim to `knowledge/sprint-archive.md`, then run `node scripts/decisions.mjs status`: if it reports
   `SPRINT.md` as `OVER`, the checkpoint is not finished. Check that every spec the sprint is working on is a
   row of the note's table, and that `SPRINT.md` repeats none of it.
7. Glance test: read only "Status at a glance" and "Now / Next". Could a newcomer say where the sprint is and
   what comes next? If not, rewrite them.
8. If changed: `SPRINT.md` lives in the nested knowledge repo, so check its branch
   (`git -C knowledge rev-parse --abbrev-ref HEAD`), `git -C knowledge add SPRINT.md sprint-archive.md decisions milestones`
   only (explicit paths; `decisions` picks up rows the coder recorded), commit `docs(sprint): …`.

End with one line on what changed (or "already current"), then one sentence:

- Current item done → `The next sprint item is <action> <ID>, with its migration at <NNN>.` (drop the migration clause if no schema change)
- Not done → `This sprint item still requires: <concrete steps from evidence>.`
- Milestone built → `Milestone <letter> is built; /sprint-wrap-up close is due.`
