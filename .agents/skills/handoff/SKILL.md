---
name: handoff
description: Write a checkpoint file (<AREA>-<id>-e<NN>-HANDOFF.md) into an epic folder mid-execution of its PLAN, so a second agent — or the same one after a context reset — can pick up implementation without reconstructing progress from git diffs. Use when an agent executing a PLAN is running low on context, hits a natural pause, or the user asks to hand off; delete it once epic-retrospect writes the RETRO.
---

# Handoff

Capture the live state of an in-progress epic so a fresh agent can continue it. PLAN.md is written prospectively (before work starts) and RETRO.md retrospectively (after it's done); nothing today captures state **mid-cycle** — a session that runs out of context or gets interrupted leaves the next agent to reconstruct progress from half-checked boxes and git history. This skill fills that gap.

**Usage:** `/handoff <path-to-epic-folder-or-PLAN-file>`

## Design note — one file, overwritten

There is exactly one handoff per plan: `<AREA>-<id>-e<NN>-HANDOFF.md`, written next to the PLAN and RETRO. Each run of this skill **overwrites** it — prior handoffs aren't independently useful once a newer one exists, and git history on the file covers anyone who needs to see how the state evolved across a chain of agents. Don't append or version it.

The ID-carrying filename (`CORE-023-e01-HANDOFF.md`) makes it wiki-linkable — `[[CORE-023-e01-HANDOFF]]` — same rationale as PLAN and RETRO ([[spec-author]]).

---

## Workflow

### Step 1: Locate the Epic

Resolve `$1` to the epic directory, same rule as `epic-retrospect`:
- If a directory path, use it directly.
- If a path to the plan file (`<AREA>-<id>-e<NN>-PLAN.md`), use its parent directory.
- Verify the plan file exists.

Derive the epic ID `<AREA>-<id>-e<NN>` from the plan filename. Read the plan in full — its phase/step structure is the spine the handoff reports progress against, so don't invent a different taxonomy.

### Step 2: Determine Current State

Gather, in order:

1. **Git state** — `git status --short` and `git diff` (staged + unstaged) on the current branch. `git log --oneline` since the branch point (`git merge-base main HEAD`) to see what's already committed.
2. **Phase/step position** — walk the PLAN's phases top to bottom against what git state and the conversation show actually exists; find the last step with real evidence of completion (a file exists, a test file was written, a command was run) and the first one that doesn't yet.
3. **Test status** — the most recent real test run relevant to this epic (rerun it now if the current state is unclear rather than guessing from stale memory).
4. **Completion checklist** — go through the PLAN's own checklist and mark each item done / not done based on evidence, not intention.
5. **Deviations and decisions made so far** — anything already diverging from the PLAN, and why (mirrors the categories `epic-retrospect` collects at the end, but this is a snapshot, not a final account).
6. **Open blockers** — anything currently stuck: a failing test not yet diagnosed, a missing prerequisite, an ambiguous spec point.

### Step 3: Write the HANDOFF

Write `<AREA>-<id>-e<NN>-HANDOFF.md` in the epic directory, overwriting any existing one:

```markdown
# {Epic Title} — Handoff

**Epic:** {<AREA>-<id>-e<NN>}
**Plan:** [[{<AREA>-<id>-e<NN>-PLAN}]]
**Branch:** {git branch name}
**Date:** {today's date, YYYY-MM-DD}

---

## Current Position

{Which PLAN phase/step is in progress or was just completed, e.g. "Phase 3, Step 3.4 — implementing the claim route; Steps 3.1–3.3 done."}

## Done

{Checklist of completed PLAN items, each with the evidence — file path, test name, commit hash. Not "I think this works" — what was actually verified.}

## Pending

{Remaining PLAN steps in order, as written in the PLAN — don't re-summarize them, reference the step numbers so the next agent re-reads the PLAN itself for detail.}

## Deviations & Decisions So Far

{Anything already diverging from the PLAN and why. Empty section ("None yet") is fine and expected early in execution.}

## Test Status

{Last real command run and its result. E.g. "pnpm -C packages/api test — 4 failing in claim.test.ts, see Blockers."}

## Blockers

{Concrete open problems, or "None."}

## Next Action

{The single next concrete thing to do — a command to run, a file to open and what to change in it. Specific enough that a fresh agent doesn't have to re-derive it from the PLAN.}
```

### Step 4: Confirm

Report the HANDOFF path and a one-line summary of current position. Remind the user this file gets superseded the next time `/handoff` runs on this epic, and gets **deleted** by `/epic-retrospect` once the epic actually finishes (Step 4 below) — it's a live checkpoint, not a permanent record.

---

## Quality Rules

1. **Evidence-based, like a retro.** Every "done" claim is backed by something checkable — a file, a test result, a commit — not intention or memory of having started it.
2. **Point at the PLAN, don't duplicate it.** The Pending section references PLAN step numbers; it doesn't re-explain what those steps say. The next agent reads the PLAN for detail and the HANDOFF for position.
3. **File paths from repo root.** Same exception as PLAN/RETRO: reference the epic itself by ID (`[[CORE-023-e01-PLAN]]`), never by its seq-prefixed path.
4. **Concise.** This is a checkpoint, not a narrative — bullets and short sentences, like a RETRO.
5. **Overwrite, don't accumulate.** One HANDOFF file per epic, always current. If the state changed enough to want a second version, that's what `git log` on the file is for.

---

## Interaction with `epic-retrospect`

When `/epic-retrospect` runs on this epic, it should:
- Read `<AREA>-<id>-e<NN>-HANDOFF.md` first if one exists — it's the freshest account of deviations/decisions mid-flight and saves re-deriving them from scratch.
- Fold anything still relevant into the RETRO's own Deviations/Decisions/Lessons sections.
- Delete the HANDOFF file once the RETRO is written — a finished epic has a RETRO; a HANDOFF lingering past that point is stale, competing state.

## Not this skill: handing off the architect's seat

This skill is scoped to an agent **executing** one PLAN. An agent **writing** specs and generating
PLANs across a sequence of them has a different unit of work — a band of specs, not one epic — with
no epic folder to live in and no PLAN phases to report position against. That's `sprint-planning`,
which maintains `knowledge/SPRINT.md`. The two coexist: a sprint can have a live `SPRINT.md` while
one of its epics is mid-execution with its own `-HANDOFF.md`.
