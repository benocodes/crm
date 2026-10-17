---
name: reconcile-knowledge
description: Drain the knowledge-reconciliation queue — merged PRs that closed a GitHub issue without a spec cycle. For each, decide whether a shipped spec went stale, whether the issue left a design gap worth a discussions/ note, and whether project-state.md's capability summary is now wrong; then open a PR against zooid-ai/product. Use when the user says /reconcile-knowledge, "reconcile the knowledge", "did any specs go stale", or after a batch of issue PRs merge.
---

# Reconcile Knowledge

The closing bracket on **issue** work, the way `[[retrospect]]` is the closing bracket on **spec cycle** work.

A spec cycle ends with a `RETRO.md` because it began with a `PLAN.md` — the retro's whole value is *"what did the plan get wrong."* An issue has no plan, so it gets no retro, and a per-issue retro document would just restate the PR body into a file nobody reads. What issue work actually leaves behind is different: **a written product that quietly stopped being true.** This skill is the thing that notices.

## Why after merge, not at PR time

`project-state.md` opens with *"what Zooid can do today"*. That isn't true until the code lands. A spec amended alongside an open PR describes a change that review can still alter, and it couples a private-repo PR to a public one across two different review cadences. So `[[work-on-ready-issues]]` and `[[fix-bugs]]` only leave a **Knowledge impact** hint in the code PR body — this skill reads that hint back after the merge and does the writing.

## The queue

`zooid-ai/product` runs `.github/workflows/knowledge-reconciliation.yml` daily. It polls the two **public** code repos for merged PRs whose `closingIssuesReferences` is non-empty, and opens one issue per merged PR, labeled `reconciliation`, carrying the PR link, the closed issue(s), the changed files, and the PR body's **Knowledge impact** line.

> **Why the workflow lives in `product` and polls, rather than firing from the code repos on merge.** `product` and `marketing` are **private**; `zooid` and `clients` are **public**. A public repo's `GITHUB_TOKEN` can't write to a private sibling, so a merge-triggered workflow there would need a PAT in a *public* repo's secrets — and `pull_request: closed` from a **fork receives no secrets at all**, so external contributions (the ones `[[triage-issues]]` exists to handle) would silently no-op. `pull_request_target` gets the secrets but is the standard supply-chain footgun. Polling from the private side needs no cross-repo credential: both code repos are public, so any token can read them.

Read the queue:

```bash
gh issue list -R zooid-ai/product --label reconciliation --state open \
  --json number,title,body,createdAt
```

Work oldest first — later merges may build on earlier ones, and reconciling out of order means re-editing the same spec lines twice.

## Workflow

1. **Pick a queue item.** Default to the oldest open `reconciliation` issue, or the one the user names. Read it for the merged PR, the issue(s) it closed, and the **Knowledge impact** hint.
2. **Read what actually shipped**, not what the PR body claimed:
   ```bash
   gh pr diff <PR> -R <code-repo>
   gh pr view <PR> -R <code-repo> --json title,body,files,mergedAt
   ```
   The hint is a lead, not a verdict — the author wrote it before review. Trust the diff.
3. **Ask the three questions, in order.** **"Nothing to update" is the normal answer to all three.** Say so and move on; a spec amendment nobody needed is noise, and padding this to look thorough is the failure mode here.

   1. **Did a shipped spec's description of behavior stop being true?** Start from the hint and the board's **Spec** field, then grep independently — the specs that went stale historically had *no* `Spec` set:
      ```bash
      grep -rl "<feature noun>" /Users/ori/Code/z/knowledge/product/specs --include='*.md'
      ```
      Amend only the lines the diff contradicts, and bump the spec's `updated:` date. Keep it surgical. Don't downgrade `status: shipped` — the spec still shipped; it's the *description* that drifted. A shipped spec that lies is worse than no spec, because the next cycle reads it as the contract.
   2. **Did the issue leave a design gap standing?** Root causes outlive fixes — a wrong assumption, a missing concept, a decision deferred to keep the fix small. If one survived the merge, write it into `knowledge/product/discussions/<YYYY-MM-DD>-<slug>.md` (that folder's `README.md` is the authority on frontmatter and section order; `status: open`, and **Context** should link the issue and the PR). If the relevant epic keeps an **Issues** list or **Open questions**, add it there too.
   3. **Is `## Product capabilities` in `knowledge/product/project-state.md` now wrong?** Only when the merge *added or removed* a user-facing capability. A bug fix that restores behavior the summary already claims needs nothing. **Never append to `## Completed specs`** — that log is one line per **spec**, maintained by `[[retrospect]]`; issue lines would turn it into a changelog, which is what releases and changesets already are. If you do edit, bump the `> Last updated:` line.

4. **Open the PR.** `knowledge/product/` is **its own git repo** (`zooid-ai/product`) nested in the monorepo — not `orivibes/z`, and not the code clone. Everything in them lands through a PR a human merges; never commit to their `main`.
   ```bash
   git -C knowledge/product checkout main && git -C knowledge/product pull
   git -C knowledge/product checkout -b docs/reconcile-<repo>-<N>
   # …edits…
   git -C knowledge/product push -u origin docs/reconcile-<repo>-<N>
   gh pr create -R zooid-ai/product --base main \
     --title "docs: reconcile knowledge for <repo>#<N>" \
     --body "Follows <link to the merged code PR>. …"
   ```
   Spec amendments, discussion notes and a `project-state.md` edit all go in this one PR. Reference the merged code PR by URL, never with a closing keyword (see Guardrails).
5. **Close the queue item.** Comment on the `reconciliation` issue with what you did (the PR links, or "no knowledge impact — <one line why>") and close it. An item closed with "nothing to update" is a success, not a skip.
6. **Report.** One line per item:
   ```
   <repo>#<N> "<title>" → <spec amended [[ID]] | discussion filed | capabilities updated | no impact> · <PR URL or —>
   ```

Do one queue item per invocation unless the user asks for a batch.

## Guardrails

- **A closing keyword is live text, never an example.** `Closes` / `Fixes` /
  `Resolves` next to an issue reference fires from **any commit pushed to a
  default branch** and from any PR body — cross-repo included, regardless of
  surrounding prose, quotes, or parentheses. This skill writes prose *about*
  already-closed issues, which is exactly the situation that has bitten this repo
  twice (`zooid#12` closed by a PR body's "fixes"; `zooid#13` by a skills commit
  that quoted the keyword as an illustration). Link merged PRs and closed issues
  by **bare URL**. When documenting the convention, use an unresolvable
  placeholder — `Closes <owner/repo>#<N>`.
- **"Nothing to update" is the expected answer.** Most merges change no written
  claim. Record that and close the item. Inventing a spec edit to justify the
  invocation is worse than doing nothing.
- **Amend, don't rewrite.** Correct the lines the diff contradicts and bump
  `updated:`. A spec is a historical contract, not a live changelog — rewriting
  it to match today's code destroys the record of what was decided when.
- **Never author a new spec here.** If the gap is big enough to need one, that's
  a `discussions/` note plus a flag to product-owner — same boundary
  `[[triage-issues]]` holds.
- **Read the diff, not the PR body.** The **Knowledge impact** hint was written
  pre-review by someone who wanted to ship. Verify it.
- **Never touch code repos.** This skill only writes to `knowledge/product/`. Fixes belong to `[[fix-bugs]]`.
