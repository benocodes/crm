---
name: work-on-ready-issues
description: Work the shared delivery queue on GitHub Project #1 (zooid-ai) for features and tasks (bug fixes have their own skill, /fix-bugs). Reads non-bug issues across zooid-ai/zooid and zooid-ai/clients that are marked Ready, ranks them by Priority then Size, then claims, implements, and opens a PR for the top item (or one the user names), flagging any spec the change may have made stale. Use when the user says /work-on-ready-issues, "work the issue queue", "pick up the next issue", or "what's ready to build".
---

# Work On Ready Issues

The delivery half of the SDLC, for **features and tasks** — bug fixes are [[fix-bugs]]'s job, not this one, so a Ready item labeled `bug` belongs there instead. Intake/triage happens upstream, either the **product-owner** agent (talked to in zooid chat) or the local [[triage-issues]] skill: both turn ideas/reports into issues on **[Project #1](https://github.com/orgs/zooid-ai/projects/1)** and set their metadata. This skill is **me** draining that queue: pick the top *Ready*, non-bug item, read its spec, build it, open a PR. The board is the contract — I read what triage wrote, never guess at scope.

Two code repos feed the board — and **where an issue is filed is not where the fix goes**:

| Code area | Local clone | PRs go to |
|---|---|---|
| Agent daemon, CLI, transports, runtimes | `zooid/` | `zooid-ai/zooid` |
| Web client — composer, timeline, rooms, spaces UI | `zooid-clients/` | `zooid-ai/clients` |

Both are **independent git repos nested inside the `z` monorepo** (their own `.git`, remote = the PR target). The monorepo root (`orivibes/z`) is *not* where this work lands.

Issues are filed by **users**, and users file them in `zooid-ai/zooid` — the main/bridge repo, the one they know — regardless of which half the fix actually touches. A web-client request sitting on `zooid-ai/zooid` is the normal case, **not** a mis-filing to correct. So:

- **Pick the clone from where the code lives**, never from the issue's own repo. The issue's Pointers usually name the package; grep for the symptom before assuming.
- **Leave the issue where the user filed it.** Don't transfer it out from under them.
- When the two differ, the PR goes to the **code's** repo and closes the issue with a fully-qualified cross-repo keyword — `Closes zooid-ai/zooid#13`. That auto-closes on merge (verified 2026-08-30: zooid#13 closed by zooid-ai/clients#24). Say in the PR body which repo the issue lives in, so a reviewer isn't surprised by the mismatch.

## The board is the contract

| Field | Type | What it means for me |
|---|---|---|
| **Status** | Backlog · Ready · In progress · In review · Done | The readiness gate. I only pick from **Ready**. I set **In progress** on claim, **In review** when the PR opens. I never set Done (merge does that). |
| **Priority** | Urgent · High · Medium · Low | Primary sort key. Urgent → Low. |
| **Size** | XS · S · M · L · XL | Tiebreak within a priority — smaller first (flush quick wins). |
| **Spec** | text | An `[[ID]]` (e.g. `[[ZNC011]]`) pointing at `knowledge/product/specs/.../<ID>.md`. Read it before coding. Blank = standalone fix, no spec. |
| **Repository** | text | Where the issue was **filed** — not necessarily the clone to work in. See above. |

What I rely on triage to have set — if these are missing, the item isn't really Ready (flag it back, don't invent the answer):

- The issue is **on the board**.
- **Status: Ready** (not Backlog — Backlog means still being refined).
- **Priority** and **Size** set.
- **Spec** set to `[[ID]]` when the issue implements a spec.
- Issue **body** carries: **Acceptance criteria** (a checklist of done + how to verify), **Pointers** (likely packages/files), **Blocked by** (`#refs`, if any).

## Workflow

1. **Read the queue.** Run the read query (below). Keep items with `Status == Ready`, no assignee, and **not labeled `bug`** (those are [[fix-bugs]]'s). Sort by Priority (Urgent→Low) then Size (XS→XL). Present the ranked list: `repo #N — title  ·  Priority/Size  ·  Spec`.
2. **Pick.** Default to the top item. If the user named a specific issue, use that (still require it to be Ready unless they override). Announce the choice.
3. **Read context.** `gh issue view <N> -R <repo>` for the body. Parse Acceptance criteria, Pointers, Blocked by. **If Blocked by has an open issue, stop** and report the blocker. If **Spec** is set, read `knowledge/product/specs/*<ID>*/<ID>.md` for the design. If the change is non-trivial/multi-package and there's no spec, flag it back (chat, or a comment on the issue) rather than guess.
4. **Claim.** Set the board item **Status → In progress** (claim command below) and `gh issue edit <N> -R <repo> --add-assignee @me`, both as zooidbot (see *Acting as zooidbot*). This is what stops a second pass (or triage) from re-handing it out.
5. **Branch.** In the clone that owns the code (not necessarily the issue's repo): `git -C <dir> checkout main && git -C <dir> pull`, then `git -C <dir> checkout -b <type>/<N>-<slug>`. Pick `<type>` to match the change (it should also be the `type:` of the commit and PR title): `feat` · `fix` · `docs` · `chore` (and where they fit, the rest of the [Conventional Commits](https://www.conventionalcommits.org/) set — `refactor` · `perf` · `test` · `build` · `ci` · `revert`). Use `fix` for bug fixes — *not* `bug` (that's GitHub's label name, not the commit type). E.g. a new feature → `feat/12-avatar-stack`; a docs tweak → `docs/12-readme-prereqs`.
6. **Implement** against the acceptance criteria. Test/lint **within that clone only** — `pnpm -C zooid …` / `pnpm -C zooid-clients …`. NEVER `pnpm install` at the `z` root: each child is its own workspace + lockfile and a root install breaks them.
7. **Note the knowledge impact — don't write it yet.** You know better than anyone which specs this change implicates; the actual reconciliation happens after merge (see [[reconcile-knowledge]]), because `project-state.md` claims "what Zooid can do today" and that isn't true until the code lands. So decide it now and carry it into the PR body you write in the next step — a hint, not an edit:

   ```
   **Knowledge impact:** <spec IDs this may have made stale, design gaps it left standing, or "none">
   ```

   Grep before you guess — the board's **Spec** field is often blank on issues that still touched a shipped spec:

   ```bash
   grep -rl "<feature noun from the issue>" \
     /Users/ori/Code/z/knowledge/product/specs --include='*.md'
   ```

   Never edit `knowledge/product/` (specs and `project-state.md`) from this skill. It's a separate private repo on its own PR cadence, and a spec amendment written before review can describe a change review then alters.
8. **Ship.** Commit, `git -C <dir> push -u origin <type>/<N>-<slug>`, then `gh pr create -R <code-repo> --base main --title "…" --body "Closes <owner/repo>#<N>\n\n…"` — `-R` is the repo that owns the **code**. Write the closing keyword fully qualified (`Closes zooid-ai/zooid#13`) whenever the issue lives in the other repo; bare `Closes #<N>` is only right when issue and PR share a repo. Either form auto-links the PR into the board's *Linked pull requests* and closes the issue on merge. Include the **Knowledge impact** line from the previous step in the body. Keep the branch `<type>`, the commit `type:`, and the PR title `type:` consistent.
9. **Move + report.** Set the board item **Status → In review** (command below). Print the PR URL and the Knowledge impact line you wrote into it. **Never merge** — a human merges, which moves the card to Done.

Do one issue per invocation unless the user asks for a batch.

## Commands & IDs

Project: `zooid-ai` / number **1** · `PROJECT_ID = PVT_kwDOD6BOCM4BZZ-x`

Field + option IDs (re-derive with the schema query below if they ever drift):

```
Status   PVTSSF_lADOD6BOCM4BZZ-xzhUY1TM   Backlog=f75ad846 Ready=e18bf179 "In progress"=47fc9ee4 "In review"=aba860b9 Done=98236657
Priority PVTSSF_lADOD6BOCM4BZZ-xzhV51dg   Urgent=832694c9 High=fe16f01c Medium=24362f8f Low=319abe03
Size     PVTSSF_lADOD6BOCM4BZZ-xzhUY1gc   XS=911790be S=b277fb01 M=86db8eb3 L=853c8207 XL=2d0801e2
Spec     PVTF_lADOD6BOCM4BZZ-xzhUY1_o     (text)
```

**Read the queue** (Ready items with all fields):

```bash
gh api graphql -f query='
{ organization(login:"zooid-ai"){ projectV2(number:1){
  items(first:50){ nodes{
    id
    content{ ... on Issue { number title url repository{nameWithOwner} assignees(first:5){nodes{login}} state labels(first:10){nodes{name}} } }
    fieldValues(first:20){ nodes{
      ... on ProjectV2ItemFieldSingleSelectValue { name field{ ... on ProjectV2FieldCommon{name} } }
      ... on ProjectV2ItemFieldTextValue { text field{ ... on ProjectV2FieldCommon{name} } }
    }}
  }}
}}}'
```

Each item has a project-item id (`PVTI_…`) — that's `--id` for edits, distinct from the issue number.

**Claim (Status → In progress)** / **Move (Status → In review):**

```bash
# replace OPTION_ID: In progress = 47fc9ee4, In review = aba860b9
gh project item-edit --id <PVTI_ITEM_ID> --project-id PVT_kwDOD6BOCM4BZZ-x \
  --field-id PVTSSF_lADOD6BOCM4BZZ-xzhUY1TM --single-select-option-id <OPTION_ID>
```

**Re-derive IDs** if the board schema changes:

```bash
gh api graphql -f query='{ organization(login:"zooid-ai"){ projectV2(number:1){ id
  fields(first:30){ nodes{
    ... on ProjectV2FieldCommon{ id name }
    ... on ProjectV2SingleSelectField{ id name options{ id name } } }}}}}'
```

## Acting as zooidbot, not you

Issue writes (comment, label, assignee, close/reopen) and **board writes** (`gh project item-edit`) show up under the **`zooidbot`** bot account, not a personal GitHub login — see [[triage-issues]] for why.

- **Running as the Coding agent** (`local-workstation/agents/coding`): `GH_TOKEN` is already zooidbot, and git borrows it. Every GitHub call — issue, board, push, PR — goes out as zooidbot with no prefix. Work in a worktree off your own base clone, as your CLAUDE.md says, in place of step 5's `checkout` in the main clone.
- **Running interactively** (Claude Code in the `z` repo): the token is `GH_ACCESS_TOKEN` in `/Users/ori/Code/z/hq/.env` (gitignored — never print or commit it). Prefix issue and board writes with it; the branch push and `gh pr create` stay on your own identity, since that's your work:

```bash
set -a && source /Users/ori/Code/z/hq/.env && set +a
GH_TOKEN="$GH_ACCESS_TOKEN" gh issue edit <N> -R <repo> --add-assignee @me
GH_TOKEN="$GH_ACCESS_TOKEN" gh project item-edit --id <PVTI_ITEM_ID> ...
```

`zooidbot` holds the **Write** role on `zooid-ai/zooid` and `zooid-ai/clients` (since 2026-09-25), and its fine-grained PAT has Contents, Issues, Pull requests and org Projects read/write. `main` on both repos is branch-protected — PR required, no force-push — so Write lets it push feature branches, never `main`.

> **If a bot write ever 403s**, a fine-grained PAT has four independent gates
> — check them in this order: **resource owner** (must be the `zooid-ai` org, not
> the bot's own account; "All repositories" on a personal-owner token means only
> repos the bot itself owns, which is how this broke the first time) → **repository
> selection** → **token permissions** (Issues / Contents / Pull requests / org
> Projects: Read and write) → **the account's repo role**, which caps everything
> above it. Two traps: the `X-Accepted-Github-Permissions` header on a 403 names
> what the *endpoint* requires, not what the token lacks; and working *reads* prove
> nothing, since both repos are public and any PAT can read a public repo. On a
> 403, report it rather than retrying. Interactively you may fall back to your own
> `gh` identity and say so; the Coding agent has no other identity to fall back to.

## Guardrails

- **A closing keyword is live text, never an example.** `Closes` / `Fixes` /
  `Resolves` next to an issue reference fires from **any commit pushed to a default
  branch** and from any PR body — cross-repo included, and regardless of
  surrounding prose, quotes, or parentheses. So never write one next to a real
  issue number unless you mean to close that issue. When *documenting* the
  convention (in a commit message, a PR body, an issue comment), use a placeholder
  the parser can't resolve — `Closes <owner/repo>#<N>` — or describe it without the
  reference. This has bitten this repo twice: `zooid#12` was closed by a PR body's
  "fixes", and `zooid#13` by a skills commit that quoted the keyword as an
  illustration.
- **Ready-only.** Never pull from Backlog — it isn't refined. Don't touch items already In progress / assigned to someone else.
- **Bugs go to [[fix-bugs]].** If the top-ranked item is labeled `bug`, skip it — that skill owns Ready bugs.
- **Read the Spec first** when one is linked; honor **Blocked by**.
- **Don't invent scope.** Missing/ambiguous acceptance criteria → ask the user or comment on the issue rather than guessing.
- **Route by code, not by issue repo.** Users file in `zooid-ai/zooid` whatever the fix touches. Work in the clone that owns the code, leave the issue where it is, and close it cross-repo (`Closes zooid-ai/zooid#13`).
- **Per-child workspace.** Test/lint inside `zooid/` or `zooid-clients/`; never `pnpm install` at the `z` root.
- **PR, never merge.** Card moves to In review; the human merges to Done.
- **Note knowledge impact, never write it.** One line in the PR body naming the
  specs this may have staled. The write-back happens post-merge via
  [[reconcile-knowledge]] — writing it here documents a change review can still
  change, and couples a private-repo PR to a public one.
- **Scopes.** Issue and board writes go through zooidbot (see above). Interactively, `gh pr create` needs `repo` on your own gh token.
