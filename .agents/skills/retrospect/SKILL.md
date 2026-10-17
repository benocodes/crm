---
name: retrospect
description: Write a RETRO.md retrospective summary into a cycle folder after completing a PLAN.md. Captures what was done, what changed vs the plan, and lessons learned.
---

# Retrospect

Write a retrospective summary after completing a cycle's PLAN.md. Creates `RETRO.md` next to the plan.

**Usage:** `/retrospect <path-to-cycle-folder-or-PLAN.md>`

---

## Workflow

### Step 1: Locate the Cycle

Resolve `$1` to the cycle folder:
- If a directory path, use it directly
- If a path to `PLAN.md`, use its parent directory
- Verify `PLAN.md` exists in the directory

Read the `PLAN.md` to extract the goal, scope, phases, and completion checklist.

### Step 2: Gather Evidence

**Important — nested git roots:** This monorepo may contain sub-projects with their own `.git` directory (e.g., `zooid/` has its own git root separate from the top-level repo). When running git commands to gather evidence, first determine the correct git root for the files touched by the cycle. Use `git -C <sub-project-dir> ...` to target the right repo. Check for a `.git` directory in the cycle's target package path and its ancestors. If the changed files live under a nested git root, all `git log`, `git diff`, and `git status` commands must be run from that nested root.

Collect what actually happened by examining:

1. **Git history** — Run `git log --oneline` scoped to the files touched by this cycle (from the correct git root). Identify commits made during the implementation.
2. **Files changed** — Run `git diff` and `git status` (from the correct git root) to see all files created/modified/deleted. For uncommitted work, use `git status --short` and `git diff` (staged + unstaged).
3. **Current conversation context** — Review what was done in this session (test results, errors hit, deviations from plan).
4. **Test results** — Note final test counts and any tests that were added beyond what the plan specified.
5. **The handoff trail** — When the cycle was built by agents, read the PR itself: `gh pr view <N> -R <repo> --comments` for the body (the implementer's **Plan feedback** and **Not verified** lines), the review comments, and how many review rounds it took. If you can, read the Matrix thread where the work was handed off: the brief, the questions the implementer had to ask back, and UX Tester rounds. That trail shows where the plan or the agent setup cost time.

### Step 3: Generate RETRO.md

Write `RETRO.md` in the cycle folder with this structure:

```markdown
---
id: {cycle ID — the <ID> segment of the folder name}
type: retro
order: {the folder's <seq> prefix}
title: "{Cycle Title} — Retrospective"
spec: "[[{spec-ID}]]"   # backlink to the spec this cycle targeted: own ID for a spec-introducing cycle, else the implemented spec's ID
---

# {Cycle Title} — Retrospective

**Cycle:** {path to cycle folder}
**Plan:** PLAN.md
**Status:** Complete
**Date:** {today's date, YYYY-MM-DD}

---

## Summary

{2-3 sentences: what was the goal, what was delivered}

## What Was Done

{Bulleted list of concrete deliverables — files created, interfaces defined, refactors made. Group by category (e.g., "New files", "Modified files", "Tests added"). Include file paths.}

## Deviations from Plan

{What changed vs the original PLAN.md? Steps added, removed, or modified. If the plan was followed exactly, say so. Be specific — e.g., "Step 3.10 was unnecessary because auth.ts didn't directly call getTrustedKey" or "Added serverStorage middleware at app level (not just api level) because well-known routes needed it too."}

## Decisions Made

{Key decisions during implementation and why. E.g., "Set serverStorage at app root level instead of api level to cover well-known routes" or "Kept isStrictTypes/getRetentionDays as direct imports since they're pure functions on row data, not control plane queries."}

## Test Results

{Final test counts. E.g.:
- Unit tests: 17 passed (server-storage.test.ts)
- Server tests: 342 passed (22 files)
- Monorepo tests: 257 passed (20 files)
- Type check: clean}

## Lessons Learned

{What would make the next cycle smoother? E.g., "The plan didn't account for routes mounted outside the api middleware — always check the full middleware chain" or "The plan was thorough and required no iteration."}

## Handoff & Process

{How the *work* went, as opposed to the code. Skip this section only when a human built the cycle alone.}

**Plan & brief quality.** Where the plan or handoff brief was wrong, silent, or over-specified, in the implementer's words where they gave them (quote the PR's Plan feedback line). Note the round trips it caused: questions back to the planner, review rounds, UX Tester rounds.

**Agent setup.** Friction that came from how the team is set up rather than from this cycle's problem. Tag each item with its kind and the agent, and name the file if you know it:
- `[role]` work fell between two agents, or two did the same thing
- `[prompt]` an agent misread its job (e.g. "Coding opened the PR before UX Tester reported")
- `[tool]` a missing script or skill, or a workaround for one
- `[permission]` a sandbox denial or missing token scope that blocked real work

E.g. `[permission] coding: sandbox blocks the Tuwunel socket, so the e2e criterion shipped unverified (local-workstation/agents/coding/.claude/settings.json)`. Write "None" when there was none. Lead reads this section across retros to fix recurring problems, so each item has to stand alone.
```

### Step 4: Update project-state.md

After writing `RETRO.md`, record the completed cycle in the running log at `knowledge/product/project-state.md`, in the same `zooid-ai/product` repo and PR as the `RETRO.md`:

1. **Append one line** to the end of the `## Completed specs` list:
   `- [{ID}] {Title} — {one sentence on what shipped}.`
   One sentence, evidence-based (draw it from the RETRO's Summary). Don't restate the whole retro.
2. **Refresh the capability summary only if warranted.** If the cycle added or changed a *user-facing product capability*, update the `## Product capabilities` summary at the top to reflect it. Skip this for internal-only work (refactors, migrations, renames, tooling).
3. **Bump** the `> Last updated:` line to today's date.

Keep both edits terse — `project-state.md` is a capabilities summary plus an append-only spec log, not a narrative.

### Step 5: Confirm

After writing `RETRO.md` and updating `project-state.md`, report:
- The output path
- A one-line summary of the retrospective
- The line appended to `project-state.md`

---

## Quality Rules

1. **Evidence-based** — Every claim in the retro should be backed by git history, test output, or file diffs. Don't speculate.
2. **Concise** — This is a reference document, not a narrative. Use bullets and short sentences.
3. **Honest about deviations** — The value of a retro is capturing what the plan got wrong or missed. Don't paper over differences.
4. **File paths from repo root** — Use paths relative to the repo root for all file references.
5. **No fluff** — Skip "this went well" platitudes. Focus on facts and actionable lessons.
6. **Code lessons vs. team lessons** — A lesson about the codebase goes in *Lessons Learned*. A lesson about how the plan was written, handed off, or executed by the agents goes in *Handoff & Process*. Keep them apart so they can be read separately.
