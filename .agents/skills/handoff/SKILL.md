---
name: handoff
description: Write a checkpoint file (HANDOFF.md) into a cycle folder mid-implementation of its charter (PLAN), so a second agent — or the same one after a context reset — can pick up implementation without reconstructing progress from git diffs. Use when an agent implementing a cycle is running low on context, hits a natural pause, or the user asks to hand off; delete it once retrospect writes the RETRO.
---

# Handoff

Capture the live state of an in-progress cycle so a fresh agent can continue it. PLAN.md is written prospectively (before work starts) and RETRO.md retrospectively (after it's done); nothing today captures state **mid-cycle** — a session that runs out of context or gets interrupted leaves the next agent to reconstruct progress from half-checked boxes and git history. This skill fills that gap.

**Usage:** `/handoff <path-to-cycle-folder-or-PLAN-file>`

## Design note — one file, overwritten

There is exactly one handoff per plan: `HANDOFF.md`, written next to the PLAN and RETRO. Each run of this skill **overwrites** it — prior handoffs aren't independently useful once a newer one exists, and git history on the file covers anyone who needs to see how the state evolved across a chain of agents. Don't append or version it.

The file lives in the cycle's folder beside `PLAN.md` and `RETRO.md` ([[spec-author]]). It is not wiki-linked; reference the cycle by ID (`[[CORE12]]`).

---

## Workflow

### Step 1: Locate the Cycle

Resolve `$1` to the cycle directory, same rule as `retrospect`:
- If a directory path, use it directly.
- If a path to the plan file (`PLAN.md`, or a plan-only `<ID>.md`), use its parent directory.
- Verify the plan file exists.

Derive the cycle ID `<ID>` from the plan filename. Read the plan in full — its phase/step structure is the spine the handoff reports progress against, so don't invent a different taxonomy.

### Step 2: Determine Current State

Gather, in order:

1. **Git state** — `git status --short` and `git diff` (staged + unstaged) on the current branch. `git log --oneline` since the branch point (`git merge-base main HEAD`) to see what's already committed.
2. **Position against the charter** — walk the charter's "In this cycle" items and "Must be tested" obligations against what git state and the conversation show actually exists: which are delivered, which obligations have a test with evidence (red run, mutation), which are untouched. Then the `execute-cycle` stage reached (survey, red, green, mutations, gate).
3. **Test status** — the most recent real test run relevant to this cycle (rerun it now if the current state is unclear rather than guessing from stale memory).
4. **Approach** — the design you worked out in the survey: files touched or to touch, helpers reused, the seam tested at, the migration number. The charter doesn't carry this, so without it the next agent redoes the survey.
5. **Deviations and decisions made so far** — anything already diverging from the charter, and the design calls made where spec and charter are silent (mirrors the categories `retrospect` collects at the end, but this is a snapshot, not a final account).
6. **Open blockers** — anything currently stuck: a failing test not yet diagnosed, a missing prerequisite, an ambiguous spec point.

### Step 3: Write the HANDOFF

Write `HANDOFF.md` in the cycle directory, overwriting any existing one:

```markdown
# {Cycle Title} — Handoff

**Cycle:** {<ID>}
**Plan:** [[{PLAN}]]
**Branch:** {git branch name}
**Date:** {today's date, YYYY-MM-DD}

---

## Current Position

{The `execute-cycle` stage and the charter item in progress, e.g. "Green — claim route; scope items 1–2 delivered, obligations 1–4 red-committed, 5–6 not started."}

## Done

{Charter items and obligations done, each with the evidence — file path, test name, commit hash. Not "I think this works" — what was actually verified.}

## Approach

{The design worked out so far: files and modules, helpers reused, the test seam, the migration number, and why. Short bullets.}

## Pending

{Remaining charter items and obligations, referenced by their wording in the charter — don't re-explain them.}

## Deviations & Decisions So Far

{Anything already diverging from the charter, and each design decision made (they go into RESULT.md too). Empty section ("None yet") is fine and expected early in execution.}

## Test Status

{Last real command run and its result. E.g. "pnpm -C packages/api test — 4 failing in claim.test.ts, see Blockers."}

## Blockers

{Concrete open problems, or "None."}

## Next Action

{The single next concrete thing to do — a command to run, a file to open and what to change in it. Specific enough that a fresh agent doesn't have to re-derive it.}
```

### Step 4: Confirm

Report the HANDOFF path and a one-line summary of current position. Remind the user this file gets superseded the next time `/handoff` runs on this cycle, and gets **deleted** by `/retrospect` once the cycle actually finishes  — it's a live checkpoint, not a permanent record.

---

## Quality Rules

1. **Evidence-based, like a retro.** Every "done" claim is backed by something checkable — a file, a test result, a commit — not intention or memory of having started it.
2. **Point at the charter, don't duplicate it.** Pending references the charter's items; it doesn't re-explain them. The next agent reads the charter for scope and obligations, and the HANDOFF for position and approach.
3. **File paths from repo root.** Same exception as PLAN/RETRO: reference the cycle itself by ID (`[[CORE12]]`), never by its seq-prefixed path.
4. **Concise.** This is a checkpoint, not a narrative — bullets and short sentences, like a RETRO.
5. **Overwrite, don't accumulate.** One HANDOFF file per cycle, always current. If the state changed enough to want a second version, that's what `git log` on the file is for.

---

## Interaction with `retrospect`

When `/retrospect` runs on this cycle, it should:
- Read `HANDOFF.md` first if one exists — it's the freshest account of deviations/decisions mid-flight and saves re-deriving them from scratch.
- Fold anything still relevant into the RETRO's own Deviations/Decisions/Lessons sections.
- Delete the HANDOFF file once the RETRO is written — a finished cycle has a RETRO; a HANDOFF lingering past that point is stale, competing state.

## Not this skill: handing off the architect's seat

This skill is scoped to an agent **executing** one PLAN. An agent **writing** specs and generating
PLANs across a sequence of them has a different unit of work — a band of specs, not one cycle — with
no cycle folder to live in and no charter to report position against. That's `sprint-planning`,
which maintains `knowledge/SPRINT.md`. The two coexist: a sprint can have a live `SPRINT.md` while
one of its cycles is mid-execution with its own `HANDOFF.md`.
