---
name: sprint-planning
description: Run the milestone backlog and the sprint that delivers one milestone at a time. Owns knowledge/milestones/ (one ranked folder per milestone, the seq prefix is the rank, the letter is the identifier) and knowledge/SPRINT.md (the live position of the one milestone in flight). Operations - open a sprint on the top-ranked milestone, checkpoint it, admit new work, rank, cut a milestone that is too big, pause on a hard stop, close. Use when a design conversation produces a milestone or more than one spec, when resuming sprint work in a fresh session, when new work asks to join, or when the architect is running low on context.
---

# Sprint Planning

**A sprint is one milestone** (user ruling, 2026-11-16, #372). A **milestone** is one outcome a person can
watch being demonstrated, small enough to be built in one sprint. The **backlog** is the ranked list of
milestones; the **sprint** is the run that delivers the milestone at the top of it. There is nothing else to
plan: no band of several milestones, no "next sprint" list. What comes next is the next milestone folder.

Two artifacts, with different lifetimes:

| | Milestone | Sprint |
|---|---|---|
| Lives at | `knowledge/milestones/<seq>-<letter>-<slug>/milestone-<letter>.md` | `knowledge/SPRINT.md` |
| Holds | what the milestone proves, the capabilities it needs and each one's state, what is left | where the run is right now: in flight, next, blockers, what the user owes |
| Lifetime | from the day it is named until its demo has run, and kept after | one sprint; rewritten when the next milestone opens |
| Order | the seq prefix (the rank, set by the user) | none: there is one |

Inside a cycle, `handoff` holds the mid-implementation state; this skill never replaces it.

**A sprint is not time-boxed.** It ends when its milestone's agent-buildable rows have shipped, not when a
clock runs out. Its size is measured in decisions (below).

---

## Milestones

### Folder and identifier

```
knowledge/milestones/
  010-G-built-in-auth/milestone-G.md     ← ranked: still has work, or its demo has not run
  020-H-hq-on-built-in-auth/milestone-H.md
  done/A-shared-crm/milestone-A.md       ← demo run; no rank any more
```

| Field | Example | Rule |
|---|---|---|
| `<seq>` | `010` | Three digits: the **rank**. Lower runs first. **Renamed on re-rank.** Leave gaps of 10 so one move is one rename. |
| `<letter>` | `G` | The **identifier**. The next unused letter (after `Z`: `AA`, `AB`, ...). **Never changes, never reused.** |
| `<slug>` | `built-in-auth` | Short kebab-case description. |

This is the spec convention (`spec-author` §1) applied to milestones: the seq can drift, the identifier
cannot. So the note inside is named by the identifier, and everything refers to a milestone as
`[[milestone-G]]` or "Milestone G", **never** by its seq-prefixed folder.

**The rank is the user's.** Agents never rename a seq on their own. A rank the agents had to guess is
written as `rank: proposed` in the frontmatter and listed under Open questions until the user rules; the
ruling is a decision row (`--by user --stage ruling`).

### The note

```markdown
---
id: G
type: milestone
status: queued            # queued | active | paused | built | done
rank: user, 2026-11-16    # who set the seq and when, or `proposed`
title: built-in auth
github_milestone: 7       # the repo milestone's number (see "GitHub milestones")
created: 2026-11-13
updated: 2026-11-16
---

# Milestone G — built-in auth

**Why it ranks here:** {one line, a product reason from `vision.md` or `business-model.md`, not a dependency}

## Pass

{Up to four lines: what a person sees when the demo runs. This is the definition of done.}

## Needed

| Needed | Spec | State |
|---|---|---|
| {one capability per row, in dependency order} | [[ID]] (#issue) | {state} |
| **The demo run** | — | not run |

## Left

{What remains, in plain words: agent work, then what the user owes (the demo run, an account).}
```

State is one of: ✅ shipped · ⏭ next · in flight (cycle, branch) · approved / draft (not started) ·
❌ gap (no spec) · not run. The last row is always the demo run. **Row state lives here and nowhere else**:
`SPRINT.md` does not repeat the table.

| `status` | Meaning |
|---|---|
| `queued` | in the backlog, not started |
| `active` | the sprint's milestone. At most one milestone is `active` or `paused` |
| `paused` | started, and blocked on a hard stop or something only the user can supply |
| `built` | every row but the demo run is ✅; the sprint is closed; the demo is the user's |
| `done` | the demo has run. The folder moves to `milestones/done/<letter>-<slug>/` (no seq) |

A `built` milestone keeps its seq: among built milestones the rank tells the user which demo to run first.

### How big a milestone may be

A milestone has to fit one sprint, and a sprint's size is its decisions log. `node scripts/decisions.mjs
status` reports the sprint as `DUE` when the milestone is at its budget (it takes on no new scope and is
finished as it stands) and `OVERDUE` when it is too big (the user cuts it, see `cut`). The limits live in the
script and nowhere else; never state them, or how full a sprint is, in a brief, a spec or a charter. The
agents that record decisions must have no reason to record fewer.

Size it **before** it opens, because a cut mid-sprint costs a stop. As a guide: a milestone that needs more
than about three specs or ten cycles is two milestones (Milestone G took more than twice the budget and had
to be narrowed mid-sprint). Split along what can be demonstrated: each half needs its own Pass.

### GitHub milestones

Each milestone has a repo milestone in `benocodes/crm`, titled `<letter>: <title>`, whose number is the
note's `github_milestone`. **Every spec issue and cycle issue of a milestone carries it**, and so does a user
task its demo needs, so "what is left in G" is `gh issue list -R benocodes/crm --milestone "G: built-in auth"`.
Commands are in the `board` skill. Create the repo milestone when the milestone is ranked by the user (not
while it is `proposed`), and close it when the milestone is `done`.

### Work that belongs to no milestone

A bug, a follow-up, a chore or a small task that no milestone's Pass needs is **not** attached to the nearest
milestone. It is an issue on the board, delivered by `fix-bugs` or `work-on-ready-issues` outside any sprint.
If it is too big for that, it is a milestone of its own and is admitted like one.

---

## The sprint file and the decisions log

There is exactly **one** live sprint: `knowledge/SPRINT.md`, plus its append-only overflow
`knowledge/sprint-archive.md`. Checkpointing rewrites the live file in place. Don't version it and don't keep
two; `git log -- knowledge/SPRINT.md` serves anyone who wants the history.

**Decisions are not in either file.** They live in the decisions log, one file per milestone:
`knowledge/decisions/milestone-<letter>.jsonl`, append-only, one row per decision, keyed by issue, written by
the agent that decided (`node scripts/decisions.mjs add`) and read back per issue
(`node scripts/decisions.mjs find <issue>`, which also lists the parent spec, sibling cycles and specs the
cycle's header names). Nobody reads a file whole, so it costs no context.

**A row is filed by what it concerns, not by when it was written.** `add` puts it in the file of the milestone
whose Needed table names its issue, its spec or a spec it implements, so a late fix to a built milestone lands
in that milestone's file and does not count against the one in flight. A row no table names goes to the
active milestone (a cycle its note does not list yet: add the row at the next checkpoint), or to
`decisions/board.jsonl` when no milestone is active. There is no file to switch when a sprint opens or closes.
A milestone's file is the user's batch of decisions to review when it closes. The `sprint-NNN.jsonl` files are
the log from before #383: `find` reads them, nothing writes them.

---

## Operations

Dispatched on the argument. Bare `/sprint-planning` means **checkpoint**, by far the most common.

### `open` — start the sprint on the next milestone

Run when no milestone is `active` or `paused`. Not a stop: the orchestrator does this itself after `close`.

1. **Pick the milestone:** the lowest seq whose status is `queued`. Skip `built` ones (they wait for the
   user's demo). If the lowest `queued` milestone has `rank: proposed`, **stop**: the rank is the user's. If
   none is `queued`, the backlog is empty: say so and stop.
2. **Check its size** against "How big a milestone may be". If it is plainly two milestones, propose the
   split to the user before any spec is written (`cut`, steps 2 to 4) rather than opening it.
3. **Fix its specs.** For each row of Needed without a spec, assign an `<ID>` per `spec-author` (area code plus
   the number of the issue that spawns it; open the issue with `--label self-triaged` if none exists) and a
   `<seq>` that places the specs in execution order. Stub each one: frontmatter (`status: draft`, a `drafted`
   changelog entry) and a Context of a few sentences saying what problem it owns and why it sits where it
   sits. Stub, don't draft: write the problem and leave the solution empty, or the next agent reads a
   speculation as a decision. Set the repo milestone on every spec issue.
4. Set the note's `status: active` and fill the Spec column.
5. **Write `knowledge/SPRINT.md`** from the template below, with the ordering rationale per edge in Now / Next.
   "B needs A" is not enough: name the mechanism.
6. Commit `milestones`, `specs`, `SPRINT.md` and `decisions` together (`docs(sprint): open Milestone G`) and
   tell the user in two lines which milestone opened and what its first item is.

### (bare) — checkpoint

Bring the milestone note and `SPRINT.md` up to date with the repo. Run when a plan is generated, a cycle
ships, a decision lands, context is running low, or the user asks.

Gather, in order, **evidence, not memory**:

1. **Per-spec status.** For each spec in the milestone's Needed table: its `status:` frontmatter, which cycle
   folders implement it (its **Implementation cycles** block), and for each cycle whether a `PLAN.md`,
   `HANDOFF.md` or `RETRO.md` exists. `ls` and `head` the files; don't recall.
2. **What actually shipped.** `git log --oneline` for the commits behind each plan and each cycle. A plan is
   "generated" when it is committed; a cycle is "executed" when its code is committed. Don't conflate them.
3. **Repo hazards in force right now:** the current branch, whether the working tree is clean, whether another
   session is active in this checkout. See Quality Rules.
4. **Facts established by investigation** that cost real time and are written nowhere else: record each as a
   row in the decisions log (`--stage finding`), not in either file.
5. **Open questions** put to the user and not yet answered, carried forward until they are.

Then rewrite, in this order:

1. **The milestone note.** Update each row's State and the Left section; bump `updated`. A spec the sprint is
   working on that is no row of the table is a finding: it is either a row that was missed or an admission
   that never happened (`admit`).
2. **`SPRINT.md`.** Now / Next first (name the single next item and its first action), then Status at a
   glance, last, from the note.
3. **Archive overflow.** Position beyond five lines and answered Open questions go verbatim to
   `sprint-archive.md`. A decision that turns up in `SPRINT.md` goes to the decisions log, not the archive.
4. **Budget check.** `node scripts/decisions.mjs status` must report `SPRINT.md` as `ok`.
5. **What the status asks for.** Every row but the demo run ✅: run `close`. `DUE`: the milestone takes no new
   scope. `OVERDUE` with rows unfinished: run `cut`. Nothing unblocked is left: run `pause`.
6. **Glance test** (Quality Rule 10).

### `admit` — new work arrives

Nothing slips into a running sprint, and nothing enters the backlog unranked. An **admission** is either of:

- a **new milestone**: a new outcome to demonstrate;
- a **new row** in the active milestone: a capability its table does not list yet, whoever asks for it (the
  user in a design conversation, a planner that found a gap, an issue from triage).

Not admissions: a cycle the planner splits off an existing row at plan time, a bug fix, a follow-up issue a
cycle defers inside its own spec. Those belong to work already admitted. Work no milestone needs is not an
admission either: it goes to the board ("Work that belongs to no milestone").

The new work waits for the user; the sprint does not. An unattended orchestrator writes the question under
Open questions, tells the user, and carries on with work already admitted. An agent working directly with the
user asks on the spot.

**A new milestone** never joins the running sprint. Create its folder and note (`status: queued`,
`rank: proposed`, Pass and Needed filled as far as they are known, sized per "How big a milestone may be"),
with a seq where you think it belongs, and ask the user one question: **where does it rank?** On the answer,
rename the seq, set `rank: user, <date>`, create the repo milestone and record the ruling.

**A new row** in the active milestone is scope growth. Run `node scripts/decisions.mjs status` and
`node scripts/decisions.mjs size` (the milestone's decisions by spec), then ask the user one question with the result: **does the milestone still
demonstrate its Pass without it?** If yes, it is not this milestone's: it becomes a row of another milestone,
or a new one. If no, it joins, unless the status is `DUE` or `OVERDUE`: then the milestone is already at its
budget and the question becomes a `cut`.

Record the answer (`node scripts/decisions.mjs add --issue <n> --by user --stage ruling "<what was admitted,
where, and at what rank>"`) and update the notes to match. Until the ruling, the new work gets no spec, plan
or cycle. The user may answer in advance ("add X as a milestone after G"): then there is nothing to ask, only
the ruling to record.

### `rank` — the user changes the order

Only on the user's word. Rename the folders' seq prefixes to the new order (one `git mv` per moved milestone;
renumber neighbours only when no gap is left), set `rank: user, <date>` on the moved notes, and record the
ruling. The `active` milestone is not interrupted by a re-rank: a milestone that now ranks above it opens
after it closes, unless the user says to pause the active one.

### `cut` — the milestone is bigger than a sprint

Run when the status is `OVERDUE` and the milestone has unfinished rows, or when `open` finds a milestone too
big to start. This is a **stop**, and the cut is the user's decision, never the agents':

1. List the unfinished rows in dependency order, each with its state (in review, planned, spec only, no
   spec), and print `node scripts/decisions.mjs size`.
2. Propose a cut: the smallest set of rows that still demonstrates something stays; the rest moves to a
   **new milestone** (next unused letter). Write that milestone's Pass, say what the slimmed one can no
   longer demonstrate, and rewrite the slimmed one's Pass to match.
3. Write the proposal under Open questions, update Status at a glance and Position, commit, and stop: tell the
   user and wait. Do not start another cycle of the milestone meanwhile.
4. On the ruling: record it, create the new milestone's folder with the moved rows (`status: queued`, the
   seq and rank as the user ruled, by default directly after the one it was cut from), move the repo milestone
   on the moved issues, and continue: finish what is left of the slimmed milestone, or `close` it at once if
   nothing is left.

### `pause` — a hard stop blocks the milestone

Run when no row of the active milestone can move without something only the user can supply (a hard stop
from `AGENTS.md`, an account, a ruling). While any row is unblocked, work that row instead.

1. Set the note's `status: paused` and say in Left what it waits for.
1b. Reconcile the issues as `close` step 3 does: every delivered issue the milestone names is closed (as
   `zooidbot`, naming the merged PR) before the factory waits; report the count closed to the user.
2. Update `SPRINT.md` (Status at a glance, Position, Owed by the user, Open questions), commit, and **stop**:
   tell the user what is owed.

**The factory waits** (user ruling, 2026-11-16): the orchestrator does not open the next milestone while one
is paused. When the user supplies what was owed, set `status: active` and carry on. Only the user may say to
set a paused milestone aside and open another (`rank`).

### `close` — the milestone is built

Run when every row of Needed but the demo run is ✅, and only between cycles (no agent running, no open cycle
PR), so one cycle's decisions never straddle two files.

1. Verify it: every spec's `status:` is `shipped` and every cycle has a RETRO. If `retrospect` was skipped
   somewhere, say so rather than fixing it silently here.
2. Check the open questions are closed, not merely stale. One that still stands moves to the note's Left
   section; an unanswered question at close is a finding to report.
3. Reconcile the issues: list every issue the milestone's table, its specs and its cycles name (`gh issue list
   --state all`, the specs' `issue` frontmatter, the cycle PRs). Each delivered one must be closed (close it
   as `zooidbot` with a comment naming the merged PR); each still open that is not delivered must be said
   to be, in the note's Left section, with why. Report the count closed and any left open to the user.
4. Set the note's `status: built` and write Left: the demo run and anything else the user owes for it. If the
   demo has already run, set `done` instead, `git mv` the folder to `milestones/done/<letter>-<slug>/` and
   close the repo milestone.
5. Remove `knowledge/SPRINT.md` (the next `open` writes a new one). Keep `sprint-archive.md` and `decisions/`.
6. Commit (`docs(sprint): close Milestone G`) and tell the user: the milestone that closed, the demo it now
   waits for, and the path of its decisions file (`decisions/milestone-G.jsonl`).
7. Run `open`. It stops by itself if the backlog is empty or the next rank is only proposed.

When the user reports a demo run later, set that milestone `done` as in step 4; that needs no sprint.

---

## The sprint file

`knowledge/SPRINT.md` exists so that a human or an agent can open it and know **where the sprint stands within
30 seconds**. It is a dashboard, not a diary, and it restates nothing the milestone note holds.

**Hard budget: under 150 lines** (`node scripts/decisions.mjs status` checks it); a one-milestone sprint
should sit well below that. Sections, in this order:

```markdown
# Milestone {G} — {title} — sprint

**Milestone:** [[milestone-{G}]] · **Updated:** {YYYY-MM-DD} · **Decisions:** `decisions/milestone-{G}.jsonl` (`node scripts/decisions.mjs find <issue>`) · **Archive:** [sprint-archive.md](sprint-archive.md)

## Status at a glance

{Three lines in a blockquote, no more: how far along the milestone is and what is missing, in plain words;
what is in flight; the next item. A reader who stops here has the answer.}

## Now / Next

{Now: what is in flight. Next: a numbered list of the remaining items in dependency order, each with its
first action (spec, plan, code) and any blocker. After the list, one line: the milestone that opens next.}

## Position

{At most five lines: what just shipped (PR, sha), what stopped the run, the deployed state.}

## Owed by the user

{Issue numbers and a few words each. Not paragraphs.}

## Open questions

{Only questions that block the milestone or need a ruling: admissions, proposed ranks, a proposed cut.
Delete a question when it is answered.}

## Repo state

{Branch, cleanliness, open PRs, worktrees, next migration number, deployed sha. Two or three lines.}
```

There is no ranking table (the ranking is `ls knowledge/milestones`), no milestone table (it is in the
note), no "Next sprint" section (it is the next folder), no decisions section and no handoff section (a note
for the next orchestrator goes in the relay's `handoff`, or is a line of Position).

`knowledge/sprint-archive.md` is append-only: *Position diary*, *Old open questions*, *Direction changes*, and
the frozen sections of sprints that ran before #372. A checkpoint moves content there verbatim; nothing is
summarised away.

---

## Quality Rules

1. **Evidence-based, like a retro.** "Generated" means a committed plan with a sha. "Shipped" means a RETRO
   exists and the spec says `shipped`. Never report intent as state.

2. **Point at sources; don't duplicate them.** A Needed row gives status in a few words; the spec holds the
   design, the PLAN holds the cycle's scope and test obligations, and `SPRINT.md` holds none of the three.

3. **Decisions go to the decisions log, never here.** One row per decision, written by the agent that made
   it. A durable rule still has to reach an area skill, `AGENTS.md` or `knowledge/architecture.md` through
   `retrospect`: the log records that something was decided, it is not where agents learn how to work.

4. **Reference by stable identifier, never by seq-prefixed path.** `[[AGT43]]` and `[[milestone-G]]`, not
   their folders. The seq is a reassignable ordering hint, and this skill reassigns it.

5. **Record the ordering rationale per edge, and rejected orderings too.** An edge justified only by "B needs
   A" will be reordered by a later session that can't see the mechanism. A rejected ordering is a decision row.

6. **Always re-check the branch before reporting it, and immediately before any commit.** In a shared
   (non-worktree) checkout another session can change branches under you between one `git status` and the
   next. `git rev-parse --abbrev-ref HEAD` is the check; the knowledge repo has its own (`git -C knowledge`).

7. **Never `git add -A`** while foreign uncommitted changes are present. Stage by explicit path.

8. **Concise.** A checkpoint, not a narrative. Status cells are a few words; detail belongs in the spec, the
   PLAN or the RETRO, which the row links to by ID.

9. **One milestone at a time.** No cycle starts for a milestone that is not `active`. When the active
   milestone stalls, the answer is `pause`, never work on a lower-ranked one.

10. **The glance test.** Before committing, read only "Status at a glance" and "Now / Next": could someone
    who has never seen the sprint say where it is and what happens next? If not, rewrite those two sections.

---

## Interaction with the other knowledge skills

- **`spec-author`** owns each stub's format, the ID and seq rules, and supersession. `open` creates stubs
  that conform to it.
- **`tdd-cycle-generator`** turns a spec into a cycle charter (PLAN). Checkpoint after each generation so the
  cycle and its deferred issues land in the Needed table and the Next list. Charters claim no migration
  number; the coder picks it at implementation time (`execute-cycle`).
- **`handoff`** takes over inside one cycle's execution. A sprint may have a live `SPRINT.md` and an executing
  cycle with its own `HANDOFF.md`; neither replaces the other.
- **`retrospect`** carries a cycle's lessons into skills and docs. The decisions log is not drained: a row
  stays as the record of the decision after its lesson has been ingested.
- **`board`** holds the commands for repo milestones; `triage-issues` sets one on an incoming issue.
- **`wiki-lint`** checks the milestones folder against the specs, `SPRINT.md` and the repo milestones.
