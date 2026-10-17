---
name: reconcile-knowledge
description: Drain the knowledge-reconciliation queue — merged PRs that closed a GitHub issue without a spec cycle. For each, decide whether a shipped spec went stale, whether the issue left a design gap worth a discussions/ note, and whether project-state.md's capability summary is now wrong; then open a PR against orivibes/crm-knowledge. Use when the user says /reconcile-knowledge, "reconcile the knowledge", "did any specs go stale", or after a batch of issue PRs merge.
---

# Reconcile Knowledge

The closing bracket on **issue** work, the way [[retrospect]] is the closing bracket on **cycle** work.

A cycle ends with a `RETRO.md` because it began with a `PLAN.md`: the retro's whole value is *what did the
plan get wrong*. An issue has no plan, so it gets no retro, and a per-issue retro would just restate the
PR body into a file nobody reads. What issue work actually leaves behind is different: **a written
product that quietly stopped being true.** This skill notices.

## Why after merge, not at PR time

`project-state.md` says what the vault can do *today*. That isn't true until the code lands. A spec
amended alongside an open PR describes a change review can still alter, and it couples a private-repo PR
to a public one across two review cadences. So [[work-on-ready-issues]] and [[fix-bugs]] only leave a
**Knowledge impact** hint in the code PR body; this skill reads the hint back after the merge and does
the writing.

## The queue

`orivibes/crm-knowledge` runs `.github/workflows/knowledge-reconciliation.yml` daily. It polls
`orivibes/crm` for merged PRs whose `closingIssuesReferences` is non-empty and opens one issue per merged
PR in `orivibes/crm-knowledge`, labeled `reconciliation`, carrying the PR link, the closed issue(s), the
changed files and the PR body's **Knowledge impact** line.

> **Why the workflow lives in the knowledge repo and polls, rather than firing from the code repo on
> merge.** The code repo is public and the knowledge repo is private. A public repo's `GITHUB_TOKEN`
> can't write to a private sibling, so a merge-triggered workflow there would need a PAT in a *public*
> repo's secrets, and `pull_request: closed` from a fork receives no secrets at all, so external
> contributions would silently no-op. Polling from the private side needs no cross-repo credential: the
> code repo is public, so any token can read it.

Read the queue:

```bash
gh issue list -R orivibes/crm-knowledge --label reconciliation --state open \
  --json number,title,body,createdAt
```

Work oldest first; later merges may build on earlier ones, and reconciling out of order means re-editing
the same spec lines twice.

## Workflow

1. **Pick a queue item.** The oldest open `reconciliation` issue, or the one the user names. Read it for
   the merged PR, the closed issue(s) and the **Knowledge impact** hint.
2. **Read what actually shipped**, not what the PR body claimed:
   ```bash
   gh pr diff <PR> -R orivibes/crm
   gh pr view <PR> -R orivibes/crm --json title,body,files,mergedAt
   ```
   The hint is a lead, not a verdict; its author wrote it before review. Trust the diff.
3. **Ask the three questions, in order.** **"Nothing to update" is the normal answer to all three.** Say
   so and move on; a spec amendment nobody needed is noise.

   1. **Did a shipped spec's description of behavior stop being true?** Start from the hint and the
      board's **Spec** field, then grep independently; the specs that go stale usually had no `Spec` set:
      ```bash
      grep -rl "<feature noun>" knowledge/specs --include='*.md'
      ```
      Amend only the lines the diff contradicts and bump the spec's `updated:` date. Don't downgrade
      `status: shipped`; the spec still shipped, its *description* drifted. A shipped spec that lies is
      worse than none, because the next cycle reads it as the contract.
   2. **Did the issue leave a design gap standing?** Root causes outlive fixes: a wrong assumption, a
      missing concept, a decision deferred to keep the fix small. If one survived the merge, write
      `knowledge/discussions/<YYYY-MM-DD>-<slug>.md` (its `README.md` is the authority on frontmatter and
      section order; `status: open`; **Context** links the issue and the PR).
   3. **Is `## Product capabilities` in `knowledge/project-state.md` now wrong?** Only when the merge
      *added or removed* a user-facing capability. A bug fix that restores behavior the summary already
      claims needs nothing. **Never append to `## Completed specs`**: that log is one line per **spec**,
      maintained by [[retrospect]]. If you edit, bump the `> Last updated:` line.

4. **Open the PR** in the knowledge repo, which is its own git repo at `knowledge/`. Everything lands
   through a PR a human merges; never commit to its `main` from this skill.
   ```bash
   git -C knowledge checkout main && git -C knowledge pull
   git -C knowledge checkout -b docs/reconcile-<N>
   # …edits…
   git -C knowledge push -u origin docs/reconcile-<N>
   gh pr create -R orivibes/crm-knowledge --base main \
     --title "docs: reconcile knowledge for crm#<N>" \
     --body "Follows <link to the merged code PR>. …"
   ```
   Spec amendments, discussion notes and a `project-state.md` edit all go in this one PR. Reference the
   merged code PR by URL, never with a closing keyword.
5. **Close the queue item.** Comment on the `reconciliation` issue with what you did (the PR links, or "no
   knowledge impact — <one line why>") and close it. Closing with "nothing to update" is a success.
6. **Report.** One line per item:
   ```
   crm#<N> "<title>" → <spec amended [[ID]] | discussion filed | capabilities updated | no impact> · <PR URL or —>
   ```

One queue item per invocation unless the user asks for a batch.

## Guardrails

- **A closing keyword is live text, never an example.** This skill writes prose *about* already-closed
  issues, which is exactly where a stray keyword closes the wrong thing. Link merged PRs and closed issues
  by **bare URL**. When documenting the convention, use `Closes <owner/repo>#<N>`.
- **"Nothing to update" is the expected answer.** Inventing a spec edit to justify the invocation is worse
  than doing nothing.
- **Amend, don't rewrite.** Correct the lines the diff contradicts and bump `updated:`. A spec is a
  historical contract, not a live changelog.
- **Never author a new spec here.** If the gap needs one, write a `discussions/` note and flag it; same
  boundary as [[triage-issues]].
- **Read the diff, not the PR body.** The hint was written pre-review by someone who wanted to ship.
- **Never touch the code repo.** This skill only writes to `knowledge/`. Fixes belong to [[fix-bugs]].
