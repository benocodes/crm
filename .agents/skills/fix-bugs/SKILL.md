---
name: fix-bugs
description: Fix the Ready bugs on the orivibes/crm project board. Reads issues labeled `bug` that are Status Ready, ranks them by Priority then Size, then claims, reproduces, fixes, and opens a PR for the top item (or one the user names), flagging any spec the fix may have made stale. Use when the user says /fix-bugs, "fix the next bug", "work the bug queue", or "what bugs are ready".
---

# Fix Bugs

The bug-fixing half of delivery: same board, same repo, same claim → branch → PR shape as
[[work-on-ready-issues]], scoped to items **labeled `bug`**. That skill skips bugs; this one skips
everything else. Intake and triage (label the type, demand repro steps, gate Ready) happen upstream in
[[triage-issues]].

One code repo, **`orivibes/crm`**. Board IDs and queries: the [`board`](../board/SKILL.md) skill. The
board fields (Status, Priority, Size, Spec) mean the same as in [[work-on-ready-issues]]; **Spec** is
usually blank for bugs.

If an item has no clear **Steps to reproduce** it isn't really Ready; flag it back and don't invent a
repro. What I rely on triage to have set:

- On the board, labeled `bug`, **Status: Ready**, **Priority** and **Size** set.
- A body with reproduction steps and expected behavior.

## Workflow

1. **Read the queue** (query in the `board` skill). Keep `Status == Ready`, no assignee, labeled `bug`. Sort by
   Priority then Size. Present `#N title · Priority/Size`.
2. **Pick.** Default to the top item, or the one the user named. Announce it.
3. **Read context.** `gh issue view <N> -R orivibes/crm --comments`. Extract steps, expected behavior,
   environment and logs. **If there is no usable repro, stop**: comment asking for it (wording in
   [[triage-issues]]) and report back rather than guess at the cause.
4. **Reproduce first.** Before touching code, trigger the bug locally (a failing request, a failing
   test). If you can't reproduce after a genuine attempt, say so in the report; don't ship a speculative
   fix for a bug you never saw.
5. **Claim.** Set **Status → In progress** and assign yourself, as zooidbot (see
   [[work-on-ready-issues]] *Acting as zooidbot*).
6. **Worktree and branch.** Same as [[work-on-ready-issues]] step 5, with the branch `fix/<N>-<slug>`.
7. **Fix and verify.** Make the minimal change that addresses the root cause, not just the symptom. Add
   or extend a test that fails before the fix and passes after. If the bug is a tenancy leak, the test
   must run on the production-like pool (no preset `app.organization_id`), or it proves nothing.
8. **Note the knowledge impact; don't write it yet** (same rule as [[work-on-ready-issues]] step 7):
   ```
   **Knowledge impact:** <spec IDs this may have made stale, design gaps it left standing, or "none">
   ```
9. **Ship.** Commit, `git push -u origin fix/<N>-<slug>`, then
   `gh pr create -R orivibes/crm --base main --title "fix: …" --body "Closes orivibes/crm#<N>

   <repro summary>

   <what was wrong, what changed>

   **Knowledge impact:** …"`.
10. **Move and report.** Set **Status → In review**. Print the PR URL and the Knowledge impact line, and
    state plainly whether you reproduced the bug and how you verified the fix. **Never merge.**

One issue per invocation unless the user asks for a batch.

## Guardrails

- **A closing keyword is live text, never an example.** Never write `Closes` / `Fixes` / `Resolves` next
  to a real issue number unless you mean to close it; when documenting, use `Closes <owner/repo>#<N>`.
- **Ready + `bug`-labeled only.** Not Backlog, not unlabeled, not claimed by someone else.
- **Reproduce before fixing.** A fix with no confirmed repro is a guess.
- **Fix the cause, not the symptom.** If the real fix is bigger than the reported bug (a design flaw),
  say so and propose scope rather than papering over it.
- **PR, never merge.** The human merges to Done.
- **Note knowledge impact, never write it.** The write-back happens post-merge via
  [[reconcile-knowledge]].
- **Non-bugs go to [[work-on-ready-issues]].** If the top bug-labeled item is really a feature request,
  flag it back to triage rather than "fixing" it here.
