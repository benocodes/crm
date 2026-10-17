---
name: fix-bugs
description: Fix the shared delivery queue's Ready bugs on GitHub Project #1 (zooid-ai). Reads issues labeled `bug` across zooid-ai/zooid and zooid-ai/clients that are Status Ready, ranks them by Priority then Size, then claims, reproduces, fixes, and opens a PR for the top item (or one the user names), flagging any spec the fix may have made stale. Use when the user says /fix-bugs, "fix the next bug", "work the bug queue", or "what bugs are ready".
---

# Fix Bugs

The bug-fixing half of delivery — same board, same repos, same claim → branch → PR shape as [[work-on-ready-issues]], but scoped to items **labeled `bug`**. That skill explicitly skips bugs; this one explicitly skips everything else. Intake/triage (label the type, demand repro steps, gate Ready) happens upstream — either the **product-owner** agent or the local [[triage-issues]] skill.

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
| **Spec** | text | An `[[ID]]` pointing at `knowledge/product/specs/.../<ID>.md`, if the bug touches specced behavior. Usually blank for bugs. |
| **Repository** | text | Where the issue was **filed** — not necessarily the clone to work in. See above. |

What I rely on triage to have set — if these are missing, or the issue has no clear **Steps to reproduce**, it isn't really Ready (flag it back, don't invent a repro):

- The issue is **on the board** and labeled `bug`.
- **Status: Ready** (not Backlog).
- **Priority** and **Size** set.
- Issue **body** carries reproduction steps and expected behavior — either from the bug-report issue form or written in by triage.

## Workflow

1. **Read the queue.** Run the read query (below, same as [[work-on-ready-issues]]). Keep items with `Status == Ready`, no assignee, and **labeled `bug`**. Sort by Priority (Urgent→Low) then Size (XS→XL). Present the ranked list: `repo #N — title  ·  Priority/Size`.
2. **Pick.** Default to the top item. If the user named a specific issue, use that (still require it to be Ready and labeled `bug` unless they override). Announce the choice.
3. **Read context.** `gh issue view <N> -R <repo> --comments` for the body and any follow-up. Extract **Steps to reproduce**, **Expected behavior**, **Environment**, and any logs. **If there's no usable repro, stop** — comment asking for it (see [[triage-issues]] for the identity/wording convention) and report back rather than guessing at the cause.
4. **Reproduce first.** Before touching code, confirm you can trigger the bug locally (run the relevant dev command, hit the reported flow). If you can't reproduce it after a genuine attempt, say so explicitly in the report — don't ship a speculative fix for a bug you never saw.
5. **Claim.** Set the board item **Status → In progress** (claim command below) and `gh issue edit <N> -R <repo> --add-assignee @me`.
6. **Branch.** In the clone that owns the code (not necessarily the issue's repo): `git -C <dir> checkout main && git -C <dir> pull`, then `git -C <dir> checkout -b fix/<N>-<slug>`. Always `fix/` — these are bugs by definition.
7. **Fix + verify.** Make the minimal change that addresses the root cause (not just the symptom). Add or extend a test that fails before the fix and passes after, when the bug is testable that way. Test/lint **within that clone only** — `pnpm -C zooid …` / `pnpm -C zooid-clients …`. NEVER `pnpm install` at the `z` root.
8. **Note the knowledge impact — don't write it yet.** You know better than anyone which specs this change implicates; the actual reconciliation happens after merge (see [[reconcile-knowledge]]), because `project-state.md` claims "what Zooid can do today" and that isn't true until the code lands. So decide it now and carry it into the PR body you write in the next step — a hint, not an edit:

   ```
   **Knowledge impact:** <spec IDs this may have made stale, design gaps it left standing, or "none">
   ```

   Grep before you guess — the board's **Spec** field is often blank on issues that still touched a shipped spec:

   ```bash
   grep -rl "<feature noun from the issue>" \
     /Users/ori/Code/z/knowledge/product/specs --include='*.md'
   ```

   Never edit `knowledge/product/` (specs and `project-state.md`) from this skill. It's a separate private repo on its own PR cadence, and a spec amendment written before review can describe a change review then alters.
9. **Ship.** Commit, `git -C <dir> push -u origin fix/<N>-<slug>`, then `gh pr create -R <code-repo> --base main --title "fix: …" --body "Closes <owner/repo>#<N>\n\n<repro summary>\n\n<what was wrong, what changed>"` — `-R` is the repo that owns the **code**. Write the closing keyword fully qualified (`Closes zooid-ai/zooid#13`) whenever the issue lives in the other repo; bare `Closes #<N>` is only right when issue and PR share a repo. Either form auto-links the PR into the board's *Linked pull requests* and closes the issue on merge. Include the **Knowledge impact** line from the previous step in the body.
10. **Move + report.** Set the board item **Status → In review** (command below). Print the PR URL and the Knowledge impact line you wrote into it, and state plainly whether you reproduced the bug and how you verified the fix. **Never merge.**

Do one issue per invocation unless the user asks for a batch.

## Commands & IDs

Project: `zooid-ai` / number **1** · `PROJECT_ID = PVT_kwDOD6BOCM4BZZ-x`

```
Status   PVTSSF_lADOD6BOCM4BZZ-xzhUY1TM   Backlog=f75ad846 Ready=e18bf179 "In progress"=47fc9ee4 "In review"=aba860b9 Done=98236657
Priority PVTSSF_lADOD6BOCM4BZZ-xzhV51dg   Urgent=832694c9 High=fe16f01c Medium=24362f8f Low=319abe03
Size     PVTSSF_lADOD6BOCM4BZZ-xzhUY1gc   XS=911790be S=b277fb01 M=86db8eb3 L=853c8207 XL=2d0801e2
Spec     PVTF_lADOD6BOCM4BZZ-xzhUY1_o     (text)
```

**Read the queue** (Ready items with all fields, including labels to filter on `bug`):

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

## Acting as zooidbot, not you

Issue comments/labels/assignee go through the **`zooidbot`** bot account, not your personal GitHub login — full rationale in [[triage-issues]]. Token is `GH_ACCESS_TOKEN` in `/Users/ori/Code/z/hq/.env` (gitignored — never print or commit it):

```bash
set -a && source /Users/ori/Code/z/hq/.env && set +a
GH_TOKEN="$GH_ACCESS_TOKEN" gh issue comment <N> -R <repo> --body "..."
```

Board writes (`gh project item-edit`) go through zooidbot too — prefix them the same way. Branch pushes and `gh pr create` stay on your own `gh` identity when you run this interactively; the Coding agent does everything as zooidbot (see [[work-on-ready-issues]]).

> **Verified working 2026-08-30 on both repos.** Issue writes as `zooidbot`
> (comment, label, assign, close) succeed on `zooid-ai/zooid` **and**
> `zooid-ai/clients`. `GH_ACCESS_TOKEN` is a fine-grained PAT created while signed
> in **as zooidbot** with **resource owner `zooid-ai`** (the org). Since
> 2026-09-25 zooidbot holds the **Write** role on both repos (`main` is
> branch-protected, so it can't push there) and the PAT also has org Projects
> read/write.
>
> **If a bot write ever 403s again**, a fine-grained PAT has four independent gates
> — check them in this order: **resource owner** (must be the `zooid-ai` org, not
> the bot's own account; "All repositories" on a personal-owner token means only
> repos the bot itself owns, which is how this broke the first time) → **repository
> selection** → **token permissions** (Issues: Read and write) → **the account's
> repo role**, which caps everything above it. Two traps: the
> `X-Accepted-Github-Permissions` header on a 403 names what the *endpoint*
> requires, not what the token lacks; and working *reads* prove nothing, since both
> repos are public and any PAT can read a public repo. On a 403, fall back to your
> own `gh` identity rather than retrying, and say so in the report.


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
- **Ready + `bug`-labeled only.** Not Backlog, not unlabeled, not already claimed by someone else.
- **Reproduce before fixing.** A bug fix with no confirmed repro is a guess — say so if you couldn't reproduce it, don't ship one anyway.
- **Fix the cause, not the symptom.** If the real fix is bigger than the reported bug (e.g. a design flaw), say so and propose scope rather than papering over it.
- **Route by code, not by issue repo.** Users file in `zooid-ai/zooid` whatever the fix touches. Work in the clone that owns the code, leave the issue where it is, and close it cross-repo (`Closes zooid-ai/zooid#13`).
- **Per-child workspace.** Test/lint inside `zooid/` or `zooid-clients/`; never `pnpm install` at the `z` root.
- **PR, never merge.** Card moves to In review; the human merges to Done.
- **Note knowledge impact, never write it.** One line in the PR body naming the
  specs this may have staled. The write-back happens post-merge via
  [[reconcile-knowledge]] — writing it here documents a change review can still
  change, and couples a private-repo PR to a public one.
- **Non-bugs go to [[work-on-ready-issues]].** If the top-ranked bug-labeled item is actually a feature request mislabeled `bug`, flag it back to triage rather than "fixing" it here.
