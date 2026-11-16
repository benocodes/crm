---
name: sprint-planning
description: Open, checkpoint, admit new work into, roll over and close a sprint — a dependency-ordered band of specs planned together toward one goal (e.g. 010–015, the first agent-readable vault). Stubs the whole sequence up front so the band is reserved and visible, then maintains knowledge/SPRINT.md as the single live account of what is drafted, generated, executed and still open across all of them. Use when a design conversation produces more than one spec, when resuming such work in a fresh session, or when the architect is running low on context; delete the file when the last spec ships.
---

# Sprint Planning

A design conversation routinely produces **several** specs at once, in a deliberate order — one
spec's mechanism is another's prerequisite, and the order encodes why. Nothing in the repo holds
that: `spec-author` owns one spec, `tdd-cycle-generator` owns one cycle, `handoff` owns one cycle's
mid-execution state. The sequence itself — which specs, in what order, why that order, how far
along — lives only in the conversation that produced it, and dies with it.

This skill makes the sequence a first-class artifact. It is the **architect's** counterpart to
`handoff`:

| | `handoff` | `sprint-planning` |
|---|---|---|
| Unit of work | one cycle | a band of specs |
| Written by | an agent implementing a cycle | an agent writing specs and generating PLANs |
| Reports position against | the charter's scope items and test obligations | the spec queue |
| Lives at | `HANDOFF.md`, in the cycle folder | `knowledge/SPRINT.md` |
| Cleared by | `retrospect`, when the RETRO lands | `/sprint-planning close`, when the last spec ships |

**On the name.** A sprint here is **not** time-boxed. It ends when the last spec in the band ships,
not when a clock runs out, and its order is a dependency chain rather than a capacity plan. The word
is the team's; the deadline it usually implies is not part of this.

## Design note — one file, overwritten

There is exactly **one** live sprint: `knowledge/SPRINT.md`, plus its append-only overflow
`knowledge/sprint-archive.md`. Checkpointing rewrites the live file in place and moves whatever stopped being
current to the archive; closing deletes both. Don't version, don't keep two live files. A finished sprint's record is its
shipped specs, their cycles and their RETROs — a planning file lingering past that point is stale
state competing with them, and `git log -- knowledge/SPRINT.md` serves anyone who wants the history.

**Decisions are not in this file.** They live in the decisions log, `knowledge/decisions/sprint-NNN.jsonl`:
append-only, one row per decision, keyed by issue, written by the agent that decided
(`node scripts/decisions.mjs add`) and read back per issue (`node scripts/decisions.mjs find <issue>`, which
also lists the parent spec, sibling cycles and specs the cycle's header names). Nobody reads it whole, so it
costs no context, and it is kept when the sprint closes. `SPRINT.md` holds state only: where the sprint is
and what is next.

**A sprint has a size, and it ends on a finished milestone.** The decisions log is also the sprint's measure.
When the script reports the rollover as `DUE`, the sprint is full: it takes on nothing new, finishes the one
milestone it is on, and then rolls over; work from every other milestone waits for the next sprint. When the
script reports `OVERDUE`, that milestone is too big to finish in this sprint, and the user decides how to cut
it (`rollover`, below). The limits live in the script and nowhere else; never state it, or how full a sprint is, in a brief, a spec or a charter. The agents that
record decisions must have no reason to record fewer.

One live sprint at a time is a constraint, not a limitation: a second concurrent band of specs is a
sign the first one's ordering was wrong.

---

## Operations

Five, dispatched on the argument. Bare `/sprint-planning` means **checkpoint** — by far the most
common.

### `open <goal>` — start a sprint

Run this **after** the design conversation has settled and before writing any spec in full.

1. **Fix the band.** Decide which specs the goal needs. For each, assign an `<ID>` per
   `spec-author` (an area code plus the number of the GitHub issue that spawns the spec; open the issue
   with `--label self-triaged` if none exists; never renumbered) and a `<seq>` that places it in **execution
   order** — that is what the seq prefix is for, and a contiguous band (010, 011, 012…) is what makes
   the sprint legible in an `ls`.

2. **Stub every spec in the band, immediately.** Create each folder and its `<ID>.md` with
   frontmatter (`status: draft`, a `drafted` changelog entry) and a Context section of a few
   sentences saying what problem it owns and why it sits where it sits. Nothing else.

   Stubbing up front is the point of this step, for three reasons: it **reserves the IDs** against a
   concurrent session, it makes the sequence visible to anyone who runs `ls knowledge/specs/`
   without reading this file, and it forces the ordering decision to be made once, in the open,
   instead of being re-derived every time a spec is written.

   Stub, don't draft. A stub that speculates about schema it hasn't earned is worse than no stub —
   the next agent reads it as a decision. Write the problem; leave the solution empty.

3. **Write `knowledge/SPRINT.md`** per the template below. If the decisions log's current file already holds
   rows (a previous sprint's), start a fresh one: `node scripts/decisions.mjs rotate --force`.

4. **State the ordering rationale explicitly**, per edge, in the Now / Next list and the specs' Context. "B needs A" is
   not enough — name the mechanism. The ordering is the sprint's one irreducible piece of knowledge,
   and it is the piece most likely to be re-litigated wrongly by a later session.

### (bare) — checkpoint

Rewrite `knowledge/SPRINT.md` in place against current repo state. Run when a plan is generated, an
cycle ships, a decision lands, context is running low, or the user asks.

Gather, in order — **evidence, not memory**:

1. **Per-spec status.** For each spec in the band: does its folder exist, what is its `status:`
   frontmatter, which cycle folders implement it (its **Implementation cycles** block), and for each cycle does a
   `PLAN.md`, `HANDOFF.md` or `RETRO.md` exist. `ls` and `head` the files; don't recall.
2. **What actually shipped.** `git log --oneline` for the commits behind each generated plan and
   each executed cycle. A plan is "generated" when it is committed; a cycle is "executed" when its
   code is committed, which is not the same thing and must not be conflated.
3. **Repo hazards in force right now** — the current branch, whether the working tree is clean,
   whether another session is active in this checkout. See Quality Rules.
4. **Facts established by investigation**, especially ones that cost real time and are not written
   down anywhere else yet: a library API that doesn't exist in the installed version, a constraint
   that already carries the value a spec says to add, a production measurement. Record each as a row in the
   decisions log (`node scripts/decisions.mjs add --issue <n> --by <role> --stage finding "<fact>"`), not in
   this file.
5. **Open questions** put to the user and not yet answered, carried forward until they are.

Then rewrite, in this order:

1. **Milestone tables.** Update each row's State from the evidence above. A spec that appears in no
   milestone table and not in Parked is a finding: place it. Update "Status at a glance" last, from the
   tables, in plain words.
2. **Now / Next / Later.** Name the single next item and its first action. Mark which order is ruled by the
   user and which is the agents' proposal.
3. **Archive overflow.** Position beyond five lines, answered Open questions, anything the budget in
   "The file" no longer allows: append verbatim to `sprint-archive.md` under the matching section, then
   delete from `SPRINT.md`. A decision that turns up in `SPRINT.md` is moved to the decisions log, not to
   the archive. Both files go in the same commit.
4. **Budget check.** `node scripts/decisions.mjs status` must report `SPRINT.md` as `ok`; `OVER` means step 3
   is not finished.
5. **Glance test** (Quality Rule 11).

### `admit` — new work asks to join a running sprint

A sprint's band is fixed at `open`. Work that arrives later does not slip in: it is admitted, by the user,
with the cost in view. An **admission** is either of:

- a **new milestone**;
- a **new spec** in an existing milestone: a capability that is no row of its table yet, whoever asks for it
  (the user in a design conversation, a planner that found a gap, an issue from triage).

Not admissions: a cycle the planner splits off an existing row at plan time, a bug fix, a follow-up issue a
cycle defers inside its own spec. Those belong to work already admitted.

The new work waits for the user; the sprint does not. An unattended orchestrator writes the question under
Open questions, tells the user, and carries on with work already admitted. An agent working directly with the
user asks on the spot. Either way:

1. Run `node scripts/decisions.mjs size` and `node scripts/decisions.mjs status`: the sprint's decisions by
   milestone, and whether it is already full.
2. Put one question to the user, with that table: **what waits for this?** Offer the choices that apply:
   it goes to the next sprint (the default when the sprint is `DUE` or `OVERDUE`, or when it ranks below the
   milestone in flight); it joins this sprint and named items move to `## Next sprint` to make room; it is a
   sprint of its own, and this one rolls over early once its current milestone is finished.
   For a new milestone, also ask where it ranks (below).
3. Record the answer as a ruling (`node scripts/decisions.mjs add --issue <n> --by user --stage ruling "<what
   was admitted, and what waits for it>"`), then update the ranking, the milestone table and Next or
   `## Next sprint` to match. Until the ruling, the new work gets no spec, plan or cycle.

The user may answer in advance ("add X, F waits"): then there is nothing to ask, only the ruling to record.

### `rollover` — the sprint is full: finish the milestone, then start the next sprint

Run when `node scripts/decisions.mjs status` reports the rollover as `DUE` or `OVERDUE`, and only between
cycles (nothing in flight: no agent running, no open cycle PR), so one cycle's decisions never straddle two
files. A milestone is **finished** when every row of its table but the demo run is ✅ (the demo run is the
user's and never holds a rollover). Which of the three steps applies depends on the state:

**Narrow** (`DUE`, and the header has no **Finishing** line yet). The sprint stops taking new work and
finishes one milestone:

1. Name the milestone the sprint finishes: the highest-ranked milestone (Milestones, "Ranking") that still
   has unfinished rows. Write it in the header: `**Finishing:** Milestone G`.
2. Move every unfinished item of the *other* milestones out of Now / Next into a `## Next sprint` section
   (after Now / Next / Later / Parked), in their existing order, each still naming its milestone. Their
   milestone tables stay where they are. Nothing in that section is started until the sprint has rolled over.
3. Commit, tell the user in two lines (the sprint is full, it now only finishes that milestone, what moved to
   the next sprint), and carry on. This is not a stop.

**Roll over** (the **Finishing** milestone is finished, or the status is `DUE` and no milestone has unfinished
rows in this sprint). Mechanical, and not a stop:

1. `node scripts/decisions.mjs rotate`: closes the current `decisions/sprint-NNN.jsonl` and opens the next.
   The closed file is the user's batch of decisions to review.
2. Rewrite `SPRINT.md` in place as the next sprint: milestone rows that are ✅ move to `sprint-archive.md`
   (verbatim); unfinished rows, Now / Next / Later / Parked, Gaps, Owed by the user and open questions carry
   forward unchanged; Position restarts with one line naming the sprint that closed and its decisions file.
   A milestone whose rows are all archived keeps its heading and one line saying what is left (its demo run,
   usually). The `## Next sprint` items move back into Next, in their order, and the section is removed. Do
   not reorder Next: a rollover changes no priorities.
3. Update the header's **Decisions** pointer to the new file, remove the **Finishing** line and bump **Updated**.
4. Commit `SPRINT.md`, `sprint-archive.md` and `decisions` together (`docs(sprint): roll over to sprint NNN`).
5. Tell the user: which sprint closed, the milestone it finished, the path of its decisions file, and the
   next item.

**Cut the milestone** (`OVERDUE` and the **Finishing** milestone is not finished). The milestone is bigger
than a sprint. This is a **stop**, and the cut is the user's decision, never the agents':

1. List the milestone's unfinished rows, in dependency order, each with its state (in review, planned, spec
   only, no spec), and print `node scripts/decisions.mjs size` so the user sees what each milestone has
   taken so far.
2. Propose a cut: which rows are the smallest set that still makes the milestone demonstrable and stay in
   it, and which rows move to a **new milestone** in the next sprint (name it, and say what it adds on top of
   the slimmed one). Say what the slimmed milestone can no longer demonstrate.
3. Write the proposal under Open questions, update Status at a glance and Position, commit, and stop: tell
   the user and wait for the ruling. Do not start another cycle of the milestone meanwhile.
4. On the ruling: record it (`node scripts/decisions.mjs add --issue <n> --by user --stage ruling "<ruling>"`),
   add the new milestone's table to `SPRINT.md` with the moved rows, put its items in `## Next sprint`, and
   continue: finish what is left of the slimmed milestone, or roll over at once if nothing is left.

### `close` — finish the sprint

Run when the last spec in the band has shipped.

1. Verify it: every spec's `status:` is `shipped`, and every cycle has a RETRO.
2. Confirm each spec's changelog and status were updated (`retrospect` owns this; if it was
   skipped, say so rather than fixing it silently here).
3. Check the open questions are genuinely closed, not merely stale. An unanswered question at close
   is a finding — report it.
4. Delete `knowledge/SPRINT.md` and `knowledge/sprint-archive.md` and commit the deletion in the knowledge repo (`git -C knowledge`) with a message naming the band, so
   `git log` reads as a record of what the sprint set out to do. **Keep `knowledge/decisions/`**: it is the
   index of what was decided for each issue, and later work reads it.

---

## The file

`knowledge/SPRINT.md` exists so that a human or an agent can open it and know **where the sprint stands within
30 seconds**. It is a dashboard, not a diary. Everything that has stopped being current moves to
`knowledge/sprint-archive.md` (verbatim, append-only).

**Hard budget: the live file stays under 150 lines** (`node scripts/decisions.mjs status` checks it). If a
checkpoint pushes it past that, archive until it fits. Sections, in this order:

```markdown
# {Goal} — sprint

**Updated:** {YYYY-MM-DD} · **Archive:** [sprint-archive.md](sprint-archive.md) · **Decisions:** `decisions/sprint-{NNN}.jsonl` (`node scripts/decisions.mjs find <issue>`)
{Only once the sprint is full (`rollover`, Narrow): **Finishing:** Milestone {X}}

## Status at a glance

{Three lines in a blockquote, no more. Per milestone: how far along, in plain words, and what is missing.
Then: what is in flight, and the next item. A reader who stops here has the answer.}

## Goal

{Two to four sentences: the outcome the whole sprint is for, and the rulings that bound it.}

## Milestones

{First, the **Ranking**: a table `Rank | Milestone | Why it ranks here | Set by`, one row per milestone that
still has work, most important first. The order is the user's (`Set by: user, {date}`); a rank the agents had
to guess is marked `proposed` and listed under Open questions until the user rules. The reason is a product
reason from `vision.md` or `business-model.md`, in one line, not a dependency.

Then one subsection per milestone (A, B, ...), in rank order. Each has: a four-line pass summary, then a table
`Needed | Spec | State` with one row per capability the milestone needs, in dependency order. State is one of
✅ shipped · ⏭ next · in flight (cycle, branch) · approved / draft (not started) · ❌ gap (no spec) · not run.
The last row of each milestone is its demo run. Every spec in the sprint appears in exactly one milestone
table or in Parked; a spec in neither is a finding.}

## Now / Next / Later / Parked

{Now: what is in flight. Next: a numbered list of the next items, each with the first action (spec, plan,
code) and any blocker. Next follows the Ranking: every unfinished item of a higher-ranked milestone comes
before any item of a lower one, unless a dependency forces otherwise (say which). Within a milestone the order
is the dependency chain. Later: the following milestone's
chain on one line. Parked: a table `Item | Why`, so a parked spec is visibly not a gate.}

## Next sprint

{Only once the sprint is full: the unfinished items of every milestone but the one being finished, in order,
each naming its milestone. Nothing here is started before the rollover.}

## Gaps

{Things the milestones need that nothing owns yet (no spec, no issue, no charter).}

## Position

{At most five lines: what just shipped (PR, sha), what stopped the run, the deployed state.}

## Owed by the user

{Issue numbers and a few words each. Not paragraphs.}

## Open questions

{Only questions that block a milestone or need a ruling. Delete a question when it is answered.}

## Repo state

{Branch, cleanliness, open PRs, worktrees, next migration number, deployed sha. Two or three lines.}
```

There is no table of every spec ever shipped, no "Why this order" essay, no "Next Action" section (that is
Now / Next), no decisions section and no handoff section (a note for the next orchestrator goes in the relay's
`handoff`, or is a line of Position). The ordering rationale lives in the specs' own Context and in the Next
list; a rejected ordering is a row in the decisions log.

### Archive file

`knowledge/sprint-archive.md` is append-only and has these sections: *Sequence table* (frozen rows),
*Position diary*, *Old open questions*, *Direction changes*, *Goal and milestone definitions as first
agreed*. A checkpoint moves content here verbatim; nothing is summarised away.

---

## Quality Rules

1. **Evidence-based, like a retro.** "Generated" means a committed plan with a sha. "Shipped" means
   a RETRO exists and the spec says `shipped`. Never report intent as state.

2. **Point at sources; don't duplicate them.** A milestone table row gives status in a few words;
   the spec file holds the design and the PLAN holds the cycle's scope and test obligations. A sprint file that restates a spec
   will drift from it, and the drift is invisible.

3. **Decisions go to the decisions log, never here.** One row per decision, written by the agent that made
   it. A durable rule still has to reach an area skill, `AGENTS.md` or `knowledge/architecture.md` through
   `retrospect`: the log records that something was decided, it is not where agents learn how to work.

4. **Reference specs and cycles by stable ID, never by seq-prefixed path.** `[[AGT43]]`, not
   `knowledge/specs/065-AGT43-suggestion-expiry/AGT43.md`. The seq is a reassignable ordering
   hint — and this skill *reassigns* it, which makes the rule load-bearing here rather than
   theoretical. The one exception is the archive's frozen Sequence table, where the seq is the subject.

5. **Record the ordering rationale per edge, and record rejected orderings too.** The order is the
   sprint's irreducible knowledge. An edge justified only by "B needs A" will be reordered by a
   later session that can't see the mechanism.

6. **Always re-check the branch before reporting it, and immediately before any commit.** In a
   shared (non-worktree) checkout another session can change branches under you between one
   `git status` and the next — this has already produced a commit landing on the wrong branch.
   `git rev-parse --abbrev-ref HEAD` is the check.

7. **Never `git add -A`** while foreign uncommitted changes are present. Stage by explicit path.

8. **Concise.** A checkpoint, not a narrative. Status cells are a few words; detail belongs in the spec,
   the PLAN or the RETRO, which the row links to by ID.

9. **Archive, don't accumulate.** Position keeps five lines, Open questions only open
   ones, and the whole file stays under 150 lines. Move overflow to `sprint-archive.md` verbatim in the same
   commit. Shipped rows stay in their milestone table as ✅ until that milestone's demo has run, then move
   to the archive.

10a. **Rank decides, not momentum.** The next item is the first unblocked item of the highest-ranked
    milestone, never whatever is closest to the last cycle. When a blocker (usually something owed by the
    user) stalls the top milestone, say so in Status at a glance before working on a lower one.

10. **Parked means parked.** A spec that gates no milestone goes in Parked with a reason, never in a
    milestone table and never as an `approved` row that looks like work.

11. **The glance test.** Before committing, read only "Status at a glance" and "Now / Next": could someone
    who has never seen the sprint say where it is and what happens next? If not, rewrite those two sections.

---

## Interaction with the other knowledge skills

- **`spec-author`** owns each stub's format, the ID/seq rules, and supersession. `open` creates
  stubs that conform to it; this skill adds nothing to the spec format itself.
- **`tdd-cycle-generator`** turns a spec into a cycle charter (PLAN). Checkpoint after each
  generation so the cycle and its deferred issues land in the milestone table and Next list. Charters claim no migration
  number; the coder picks it at implementation time (`execute-cycle`).
- **`handoff`** takes over inside one cycle's execution. The two coexist: a sprint may have a live
  `knowledge/SPRINT.md` and an executing cycle with its own `HANDOFF.md`. Neither replaces the other.
- **`retrospect`** carries a cycle's lessons into skills and docs. The decisions log is not drained: a row
  stays as the record of the decision after its lesson has been ingested.
- **`wiki-lint`** should treat a `knowledge/SPRINT.md` whose specs are all `shipped` as a finding —
  the sprint should have been closed.
