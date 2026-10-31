---
name: retrospect
description: Write a RETRO.md retrospective into a cycle folder after completing its plan, then ingest its lessons into the places future work reads — area skills, AGENTS.md invariants, knowledge/architecture.md, the spec's status and changelog, and project-state.md. Use after finishing any cycle; the retro is the raw source, the ingest step is what keeps the rest of the knowledge layer current.
---

# Retrospect

Write a retrospective after completing a cycle's plan, then propagate what it taught into the places
future work actually reads. Creates `RETRO.md` next to the plan and updates the knowledge around it.

**Usage:** `/retrospect <path-to-cycle-folder-or-PLAN.md>`

## Why the ingest step exists

Retro files are the **raw knowledge layer**: immutable once written, evidence-dense, the ground truth for
what shipped. But a lesson that stays in a retro is write-only; nobody re-reads old retros before
starting new work. The tedious part of maintaining a knowledge layer is the bookkeeping, and that
bookkeeping is Steps 4–6. Skipping them is how `AGENTS.md`, the specs and the skills rot. (The predecessor's
`tdd-epic-generator` once carried a hand-maintained lessons list that went stale within weeks.)

---

## Workflow

### Step 1: Locate the cycle

Resolve `$1` to the cycle folder (`knowledge/specs/<seq>-<ID>-<slug>/`): a directory is used directly, a
path to `PLAN.md` (or a plan-only `<ID>.md`) uses its parent. Verify the plan exists and read it for the
goal, scope (in this cycle and deferred) and test obligations. Read the cycle's `RESULT.md` too, if any:
it holds the coder's decisions, deviations and evidence. Read the spec the cycle implements (its own `<ID>.md`, or
the one named by `implements:`), since Step 5 updates it.

If a `HANDOFF.md` exists in the folder ([[handoff]]), read it now: it is the freshest account of
deviations, decisions and blockers, likely written by a different agent.

### Step 2: Gather evidence

1. **Git history.** `git log --oneline` scoped to the files the cycle touched, in the worktree or on the
   merged branch. Code is in `benocodes/crm`; the plan and spec are in the nested `knowledge/` repo, so
   run `git -C knowledge ...` for those.
2. **Files changed.** `git diff` / `git status`; for uncommitted work `git status --short` and `git diff`.
3. **Conversation context.** What happened in this session: test results, errors hit, deviations,
   anything found after deploy.
4. **Test results.** Final counts and tests added beyond the plan.
5. **The PR trail.** When agents built the cycle, read the PR: `gh pr view <N> -R benocodes/crm --comments`
   for the body (the implementer's **Plan feedback** and **Not verified** lines), review comments and the
   number of review rounds. That trail shows where the plan or the agent setup cost time.
6. **The HANDOFF**, if read in Step 1. Fold what is still relevant into the sections below; it is a
   snapshot, the retro is the final account.

### Step 3: Generate `RETRO.md`

```markdown
---
id: {the cycle's own ID — the <ID> segment of the folder name}
type: retro
order: {the folder's <seq> prefix}
title: "{Cycle Title} — Retrospective"
spec: "[[{spec-ID}]]"   # the spec this cycle targeted: own ID for a spec-introducing cycle, else the implemented spec
---

# {Cycle Title} — Retrospective

**Cycle:** [[{ID}]]
**Plan:** PLAN.md
**Status:** Complete
**Date:** {today, YYYY-MM-DD}

---

## Summary
{2-3 sentences: the goal and what was delivered}

## What Was Done
{Concrete deliverables grouped by category (new files, modified files, tests added), with paths from the repo root.}

## Deviations from Plan
{What changed against the charter: scope moved in or out, obligations proven differently or not at all, decisions the coder made that the spec didn't. If followed exactly, say so. Be specific.}

## Decisions Made
{Key decisions during implementation and why.}

## Test Results
{Final counts per suite, plus typecheck. E.g. "api: 212 passed (31 files); db: 40 passed; tsc clean".}

## Lessons Learned
{What would make the next cycle smoother. State each so a stranger can apply it: the mechanism, not the anecdote.}

## Handoff & Process
{How the *work* went, as opposed to the code. Skip only when a human built the cycle alone.}

**Plan & brief quality.** Where the plan or handoff brief was wrong, silent or over-specified, in the
implementer's words where they gave them (quote the PR's Plan feedback line). Note the round trips it
caused: questions back to the planner, review rounds.

**Agent setup.** Friction from how the agents are set up rather than from this cycle's problem. Tag each
item and name the file if you know it:
- `[role]` work fell between two agents, or two did the same thing
- `[prompt]` an agent misread its job
- `[tool]` a missing script or skill, or a workaround for one
- `[permission]` a sandbox denial or missing token scope that blocked real work

Write "None" when there was none. Each item must stand alone, because the lead reads this section across
retros to fix recurring problems.

## Follow-ups
{Optional. Deferred work and known caveats, with the spec ID that owns each.}
```

### Step 4: Ingest — route each lesson to its durable home

Go through **Lessons Learned**, **Deviations** and **Decisions** and decide where each finding lives
permanently:

| The finding… | Its durable home |
|---|---|
| is a repo-wide invariant any future cycle could trip on | `AGENTS.md` (Load-bearing invariants) |
| is area-scoped engineering knowledge | the owning skill in `.agents/skills/`: `db-schema-and-migrations`, `api-routes`, `hyperdrive-pg-rls`, `cloudflare-workflows`, … |
| changes a stated principle, data shape or architecture | `knowledge/architecture.md` (and the spec, Step 5) |
| is a workflow lesson about how cycles run | the lifecycle skill concerned (`tdd-cycle-generator`, `spec-author`, …) |
| is a one-off detail of this cycle | stays only in the retro |

Rules for propagating:

- **Rewrite for the destination, link back to the evidence.** The home gets the distilled rule in its own
  voice; cite the cycle ID (`[[CORE12]]` in knowledge files, the repo-relative path in skills) so a reader
  can trace it.
- **Update, don't duplicate.** Check whether the destination already covers the point; sharpen the
  existing text. Delete anything the lesson proves wrong.
- **Prefer the area skill over `AGENTS.md` when unsure.** `AGENTS.md` is for invariants that bite across
  areas; it must stay short to stay read.

### Step 5: Update the spec

1. **`status`.** If the cycle completes the spec's implemented scope, `shipped`; if more cycles remain,
   `shipping`. For a follow-on cycle, set its entry in the spec's **Implementation cycles** block.
2. **Changelog.** Append `- YYYY-MM-DD: cycle <ID> (<name>) completed — <one line>` and bump `updated`. If
   implementation diverged from the design, say so and correct the spec body if the divergence is
   material.
3. **Supersession.** If the cycle showed a spec is (partly) superseded, follow `spec-author`'s procedure
   (both ends).

### Step 6: Update `project-state.md`

In `knowledge/project-state.md`:

1. **Append one line** to the end of `## Completed specs`: `- [{ID}] {Title} — {one sentence on what
   shipped}.` Evidence-based, drawn from the retro's Summary.
2. **Refresh `## Product capabilities`** only if the cycle added or changed a *user-facing capability*
   (what an agent, consultant or end user can now do). Skip it for internal work.
3. **Bump** the `> Last updated:` line.

### Step 7: Delete the HANDOFF

If `HANDOFF.md` exists in the cycle folder, delete it. The retro is the permanent record; a handoff
lingering past that point is stale, competing state.

### Step 8: Confirm

Report: the retro path and a one-line summary; the **ingest ledger** (each propagated finding → its
destination file, plus the spec status and changelog changes; if nothing was propagated, justify it, since
a cycle that taught nothing wiki-worthy is rare); the line appended to `project-state.md`; and whether a
HANDOFF was found and deleted. The retro and spec edits live in the `knowledge/` repo, so they commit
there (`git -C knowledge`), separately from any skill or `AGENTS.md` edits in the code repo.

---

## Quality rules

1. **Evidence-based.** Every claim is backed by git history, test output or a diff. Don't speculate.
2. **Concise.** A reference document, not a narrative.
3. **Honest about deviations.** The value of a retro is capturing what the plan got wrong or missed.
4. **Paths from the repo root.** Exception: specs and cycles are referenced by stable ID (`[[CORE12]]`),
   never by seq-prefixed folder path, which dies silently when folders are renumbered.
5. **No fluff.** Skip "this went well" platitudes.
6. **Code lessons vs. team lessons.** A lesson about the codebase goes in *Lessons Learned*. A lesson
   about how the plan was written, handed off or executed goes in *Handoff & Process*. Keep them apart.
7. **Ingest is part of the job.** The skill isn't done when the retro exists. A lesson that never left the
   cycle folder is write-only knowledge, and the next plan will re-make the mistake.
