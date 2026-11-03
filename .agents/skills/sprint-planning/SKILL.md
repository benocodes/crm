---
name: sprint-planning
description: Open, checkpoint and close a sprint — a dependency-ordered band of specs planned together toward one goal (e.g. 010–015, the first agent-readable vault). Stubs the whole sequence up front so the band is reserved and visible, then maintains knowledge/SPRINT.md as the single live account of what is drafted, generated, executed and still open across all of them. Use when a design conversation produces more than one spec, when resuming such work in a fresh session, or when the architect is running low on context; delete the file when the last spec ships.
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

One live sprint at a time is a constraint, not a limitation: a second concurrent band of specs is a
sign the first one's ordering was wrong.

---

## Operations

Three, dispatched on the argument. Bare `/sprint-planning` means **checkpoint** — by far the most
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

3. **Write `knowledge/SPRINT.md`** per the template below.

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
   that already carries the value a spec says to add, a production measurement. These belong in the
   Ledger section and are the highest-value part of the file.
5. **Open questions** put to the user and not yet answered, carried forward until they are.

Then rewrite, in this order:

1. **Milestone tables.** Update each row's State from the evidence above. A spec that appears in no
   milestone table and not in Parked is a finding: place it. Update "Status at a glance" last, from the
   tables, in plain words.
2. **Now / Next / Later.** Name the single next item and its first action. Mark which order is ruled by the
   user and which is the agents' proposal.
3. **Archive overflow.** Position beyond five lines, Ledger beyond twelve, answered Open questions,
   anything the budget in "The file" no longer allows: append verbatim to `sprint-archive.md` under the
   matching section, then delete from `SPRINT.md`. Both files go in the same commit.
4. **Glance test** (Quality Rule 11).

### `close` — finish the sprint

Run when the last spec in the band has shipped.

1. Verify it: every spec's `status:` is `shipped`, and every cycle has a RETRO.
2. Confirm each spec's changelog and status were updated (`retrospect` owns this; if it was
   skipped, say so rather than fixing it silently here).
3. Check the open questions are genuinely closed, not merely stale. An unanswered question at close
   is a finding — report it.
4. Delete `knowledge/SPRINT.md` and `knowledge/sprint-archive.md` and commit the deletion in the knowledge repo (`git -C knowledge`) with a message naming the band, so
   `git log` reads as a record of what the sprint set out to do.

---

## The file

`knowledge/SPRINT.md` exists so that a human or an agent can open it and know **where the sprint stands within
30 seconds**. It is a dashboard, not a diary. Everything that has stopped being current moves to
`knowledge/sprint-archive.md` (verbatim, append-only).

**Hard budget: the live file stays under about 150 lines.** If a checkpoint pushes it past that, archive
until it fits. Sections, in this order:

```markdown
# {Goal} — sprint

**Updated:** {YYYY-MM-DD} · **Archive:** [sprint-archive.md](sprint-archive.md)

## Status at a glance

{Three lines in a blockquote, no more. Per milestone: how far along, in plain words, and what is missing.
Then: what is in flight, and the next item. A reader who stops here has the answer.}

## Goal

{Two to four sentences: the outcome the whole sprint is for, and the rulings that bound it.}

## Milestones

{One subsection per milestone (A, B, ...). Each has: a four-line pass summary, then a table
`Needed | Spec | State` with one row per capability the milestone needs, in dependency order. State is one of
✅ shipped · ⏭ next · in flight (cycle, branch) · approved / draft (not started) · ❌ gap (no spec) · not run.
The last row of each milestone is its demo run. Every spec in the sprint appears in exactly one milestone
table or in Parked; a spec in neither is a finding.}

## Now / Next / Later / Parked

{Now: what is in flight. Next: a numbered list of the next items, each with the first action (spec, plan,
code) and any blocker; say which order is ruled and which is proposed. Later: the following milestone's
chain on one line. Parked: a table `Item | Why`, so a parked spec is visibly not a gate.}

## Gaps

{Things the milestones need that nothing owns yet (no spec, no issue, no charter).}

## Position

{At most five lines: what just shipped (PR, sha), what stopped the run, the deployed state.}

## Owed by the user

{Issue numbers and a few words each. Not paragraphs.}

## Open questions

{Only questions that block a milestone or need a ruling. Delete a question when it is answered.}

## Recent decisions (the Ledger)

{One line per material decision, newest first, at most 12 lines. Facts a fresh agent would otherwise pay to
rediscover go here only until `retrospect` ingests them into a skill, AGENTS.md or architecture.md.}

## Repo state

{Branch, cleanliness, open PRs, worktrees, next migration number, deployed sha. Two or three lines.}
```

There is no table of every spec ever shipped, no "Why this order" essay and no "Next Action" section (that is
Now / Next). The ordering rationale lives in the specs' own Context and in the Next list; a rejected ordering
goes in the Ledger for a checkpoint and then to the archive.

### Archive file

`knowledge/sprint-archive.md` is append-only and has these sections: *Sequence table* (frozen rows),
*Position diary*, *Ledger*, *Old open questions*, *Direction changes*, *Goal and milestone definitions as first
agreed*. A checkpoint moves content here verbatim; nothing is summarised away.

---

## Quality Rules

1. **Evidence-based, like a retro.** "Generated" means a committed plan with a sha. "Shipped" means
   a RETRO exists and the spec says `shipped`. Never report intent as state.

2. **Point at sources; don't duplicate them.** A milestone table row gives status in a few words;
   the spec file holds the design and the PLAN holds the cycle's scope and test obligations. A sprint file that restates a spec
   will drift from it, and the drift is invisible.

3. **The Ledger is a staging area, not a second home.** A fact belongs there only until
   `retrospect` ingests it into an area skill, `AGENTS.md` or `knowledge/architecture.md`. At each
   checkpoint, prune what has landed elsewhere. A durable fact left only here dies with the sprint.

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

9. **Archive, don't accumulate.** Position keeps five lines, the Ledger twelve, Open questions only open
   ones, and the whole file stays near 150 lines. Move overflow to `sprint-archive.md` verbatim in the same
   commit. Shipped rows stay in their milestone table as ✅ until that milestone's demo has run, then move
   to the archive.

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
- **`retrospect`** is what drains the Ledger. When it ingests a lesson into a skill or doc, the
  next checkpoint removes it from here.
- **`wiki-lint`** should treat a `knowledge/SPRINT.md` whose specs are all `shipped` as a finding —
  the sprint should have been closed.
