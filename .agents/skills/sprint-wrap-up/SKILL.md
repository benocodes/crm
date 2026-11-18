---
name: sprint-wrap-up
description: Pause or close the milestone in flight, the two ways a sprint ends. `pause` when a hard stop blocks it, `close` when it is built (verify specs and retros, reconcile its issues, set the note's status, remove SPRINT.md, open the next milestone). Use when decisions status says every row but the demo is shipped, when nothing in the milestone can move without the user, or when sprint-checkpoint says close is due.
---

# Sprint wrap-up

Ends the sprint that `sprint-planning` opened; milestone notes, statuses and SPRINT.md are defined there.

## Reconcile the issues (pause and close)

List every issue the milestone's table, its specs and its cycles name (`gh issue list --state all`, the specs'
`issue` frontmatter, the cycle PRs). Each delivered one must be closed (as `zooidbot`, with a comment naming the
merged PR); each still open that is not delivered must be said to be, in the note's Left section, with why.
Report the count closed and any left open to the user.

## `pause` — a hard stop blocks the milestone

Run when no row of the active milestone can move without something only the user can supply (a hard stop
from `AGENTS.md`, an account, a ruling). While any row is unblocked, work that row instead.

1. Set the note's `status: paused` and say in Left what it waits for.
1b. Reconcile the issues (above): close every delivered one before the factory waits.
2. Update `SPRINT.md` (Status at a glance, Position, Owed by the user, Open questions), commit, and **stop**:
   tell the user what is owed.

**The factory waits** (user ruling, 2026-11-16): the orchestrator does not open the next milestone while one
is paused. When the user supplies what was owed, set `status: active` and carry on. Only the user may say to
set a paused milestone aside and open another (`rank`).

## `close` — the milestone is built

Run when every row of Needed but the demo run is ✅, and only between cycles (no agent running, no open cycle
PR), so one cycle's decisions never straddle two files.

1. Verify it: every spec's `status:` is `shipped` and every cycle has a RETRO. If `retrospect` was skipped
   somewhere, say so rather than fixing it silently here.
2. Check the open questions are closed, not merely stale. One that still stands moves to the note's Left
   section; an unanswered question at close is a finding to report.
3. Reconcile the issues (above).
4. Set the note's `status: built` and write Left: the demo run and anything else the user owes for it. If the
   demo has already run, set `done` instead, `git mv` the folder to `milestones/done/<letter>-<slug>/` and
   close the repo milestone.
5. Remove `knowledge/SPRINT.md` (the next `open` writes a new one). Keep `sprint-archive.md` and `decisions/`.
6. Commit (`docs(sprint): close Milestone G`) and tell the user: the milestone that closed, the demo it now
   waits for, and the path of its decisions file (`decisions/milestone-G.jsonl`).
7. Run `open`. It stops by itself if the backlog is empty or the next rank is only proposed.

When the user reports a demo run later, set that milestone `done` as in step 4; that needs no sprint.
