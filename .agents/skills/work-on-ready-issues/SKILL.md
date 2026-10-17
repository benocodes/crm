---
name: work-on-ready-issues
description: Work the delivery queue on the orivibes/crm project board for features and tasks (bug fixes have their own skill, /fix-bugs). Reads non-bug issues that are marked Ready, ranks them by Priority then Size, then claims, implements, and opens a PR for the top item (or one the user names), flagging any spec the change may have made stale. Use when the user says /work-on-ready-issues, "work the issue queue", "pick up the next issue", or "what's ready to build".
---

# Work On Ready Issues

The delivery half of the lifecycle, for **features and tasks**. Bug fixes are [[fix-bugs]]'s job, so a
Ready item labeled `bug` belongs there. Intake and triage happen upstream ([[triage-issues]]). This skill
drains the queue: pick the top *Ready*, non-bug item, read its spec, build it, open a PR. The board is
the contract; read what triage wrote and never guess at scope.

There is one code repo, **`orivibes/crm`**, and issues, branches and PRs all live in it.
Board IDs and queries: [`.agents/board.md`](../../board.md).

## The board is the contract

| Field | Type | What it means for me |
|---|---|---|
| **Status** | Backlog · Ready · In progress · In review · Done | The readiness gate. I only pick from **Ready**. I set **In progress** on claim and **In review** when the PR opens. I never set Done (merge does that). |
| **Priority** | Urgent · High · Medium · Low | Primary sort key. |
| **Size** | XS · S · M · L · XL | Tiebreak within a priority: smaller first. |
| **Spec** | text | An `[[ID]]` pointing at `knowledge/specs/*/<ID>.md`. Read it before coding. Blank means a standalone change with no spec. |

If these are missing the item isn't really Ready; flag it back instead of inventing the answer:

- The issue is on the board with **Status: Ready**, **Priority** and **Size** set, and **Spec** set when
  it implements a spec.
- The body carries **Acceptance criteria** (a checklist of done plus how to verify), **Pointers**, and
  **Blocked by** (`#refs`, if any).

## Workflow

1. **Read the queue** (query in `board.md`). Keep items with `Status == Ready`, no assignee, and **not
   labeled `bug`**. Sort by Priority (Urgent→Low) then Size (XS→XL). Present the ranked list:
   `#N title · Priority/Size · Spec`.
2. **Pick.** Default to the top item; if the user named one, use it (still require Ready unless they
   override). Announce the choice.
3. **Read context.** `gh issue view <N> -R orivibes/crm`. Parse Acceptance criteria, Pointers, Blocked
   by. **If Blocked by has an open issue, stop** and report the blocker. If **Spec** is set, read
   `knowledge/specs/*/<ID>.md` (after `git -C knowledge pull --rebase`). If the change spans more than one
   package or needs a migration and there is no spec, flag it back rather than guess.
4. **Claim.** Set the board item **Status → In progress** and add yourself as assignee, both as zooidbot
   (*Acting as zooidbot*). This stops a second pass from re-handing the item out.
5. **Worktree and branch.** Never switch branches in the main checkout; other sessions share it.
   ```bash
   git checkout main && git pull   # in the main checkout, no branch switch afterwards
   git worktree add .claude/worktrees/<N>-<slug> -b <type>/<N>-<slug> main
   cd .claude/worktrees/<N>-<slug> && pnpm install && pnpm db:test:worktree
   ```
   `<type>` matches the change and is also the `type:` of the commit and PR title: `feat` · `fix` ·
   `docs` · `chore` · `refactor` · `perf` · `test` · `build` · `ci` · `revert`. Use `fix` for bugs, never
   `bug` (that's the label, not the commit type).
6. **Implement** against the acceptance criteria, test-first. Read the relevant domain skill before
   touching its area (`db-schema-and-migrations`, `api-routes`, `hyperdrive-pg-rls`,
   `cloudflare-workflows`). Run tests, typecheck and lint from the worktree.
7. **Note the knowledge impact; don't write it yet.** You know best which specs this change implicates,
   but the write-back happens after merge ([[reconcile-knowledge]]), because `project-state.md` claims
   what the vault can do *today* and that isn't true until the code lands. Decide now, carry it into the
   PR body as a hint:
   ```
   **Knowledge impact:** <spec IDs this may have made stale, design gaps it left standing, or "none">
   ```
   Grep before you guess; the board's **Spec** field is often blank on issues that still touched a
   shipped spec:
   ```bash
   grep -rl "<feature noun from the issue>" knowledge/specs --include='*.md'
   ```
   Never edit `knowledge/` specs or `project-state.md` from this skill. A spec amendment written before
   review can describe a change review then alters.
8. **Ship.** Commit, push the branch, open the PR:
   ```bash
   git push -u origin <type>/<N>-<slug>
   gh pr create -R orivibes/crm --base main --title "<type>: …" --body "Closes orivibes/crm#<N>

   …"
   ```
   The closing keyword links the PR into the board's *Linked pull requests* and closes the issue on
   merge. Include the **Knowledge impact** line. Keep the branch `<type>`, the commit `type:` and the PR
   title `type:` consistent.
9. **Move and report.** Set the board item **Status → In review**. Print the PR URL and the Knowledge
   impact line. **Never merge**: a human merges, which moves the card to Done.

One issue per invocation unless the user asks for a batch.

## Acting as zooidbot

Issue writes (comment, label, assignee, close/reopen) and **board writes** (see `board.md` for the GraphQL edit) go
through `scripts/gh-zooidbot`; see [[triage-issues]] for why and for what to check if a write 403s. The
branch push and `gh pr create` stay on the human's own `gh` identity, since that is their work. When the
coding agent runs unattended with only the bot identity, it does everything as zooidbot, including push
and PR.

```bash
scripts/gh-zooidbot issue edit <N> -R orivibes/crm --add-assignee @me
# board field edits: GraphQL snippet in .agents/board.md
```

`main` is branch-protected (PR required, no force-push), so write access lets the bot push feature
branches, never `main`.

## Guardrails

- **A closing keyword is live text, never an example.** `Closes` / `Fixes` / `Resolves` next to an issue
  reference fires from any commit pushed to a default branch and from any PR body, whatever the
  surrounding prose. Never write one next to a real issue number unless you mean to close it. When
  *documenting* the convention, use `Closes <owner/repo>#<N>`.
- **Ready-only.** Never pull from Backlog. Don't touch items already In progress or assigned to someone
  else.
- **Bugs go to [[fix-bugs]].** If the top-ranked item is labeled `bug`, skip it.
- **Read the Spec first** when one is linked; honor **Blocked by**.
- **Don't invent scope.** Missing or ambiguous acceptance criteria: ask the user or comment on the issue.
- **PR, never merge.** The card moves to In review; the human merges to Done.
- **Note knowledge impact, never write it.** One line in the PR body; the write-back happens post-merge
  via [[reconcile-knowledge]].
- **Scopes.** Issue and board writes go through zooidbot. `gh pr create` needs `repo` on the pushing
  identity's token.
