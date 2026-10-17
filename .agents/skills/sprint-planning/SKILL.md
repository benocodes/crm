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
| Written by | an agent executing a PLAN | an agent writing specs and generating PLANs |
| Reports position against | the PLAN's phases/steps | the spec queue |
| Lives at | `HANDOFF.md`, in the cycle folder | `knowledge/SPRINT.md` |
| Cleared by | `retrospect`, when the RETRO lands | `/sprint-planning close`, when the last spec ships |

**On the name.** A sprint here is **not** time-boxed. It ends when the last spec in the band ships,
not when a clock runs out, and its order is a dependency chain rather than a capacity plan. The word
is the team's; the deadline it usually implies is not part of this.

## Design note — one file, overwritten

There is exactly **one** live sprint: `knowledge/SPRINT.md`. Checkpointing overwrites it in place;
closing deletes it. Don't append, don't version, don't keep two. A finished sprint's record is its
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

4. **State the ordering rationale explicitly**, per edge, in the Sequence section. "B needs A" is
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

### `close` — finish the sprint

Run when the last spec in the band has shipped.

1. Verify it: every spec's `status:` is `shipped`, and every cycle has a RETRO.
2. Confirm each spec's changelog and status were updated (`retrospect` owns this; if it was
   skipped, say so rather than fixing it silently here).
3. Check the open questions are genuinely closed, not merely stale. An unanswered question at close
   is a finding — report it.
4. Delete `knowledge/SPRINT.md` and commit the deletion in the knowledge repo (`git -C knowledge`) with a message naming the band, so
   `git log` reads as a record of what the sprint set out to do.

---

## The file

Write `knowledge/SPRINT.md`:

```markdown
# {Goal} — sprint

**Band:** {seq range, e.g. 063–068}
**Opened:** {YYYY-MM-DD}
**Updated:** {YYYY-MM-DD}

---

## Goal

{Two or three sentences: the outcome the whole band is for, in the user's terms. Not a summary of
the specs — the thing that makes them one piece of work.}

## Sequence

{A table of the band in EXECUTION order: seq+ID, one-line scope, spec status, cycle status. Cycle
status distinguishes "no cycle" / "plan generated (<sha>)" / "executed (<sha>)" / "shipped (retro)".}

### Why this order

{One bullet per dependency edge, naming the MECHANISM — the function, table or column that makes
the dependency real. Include any ordering that was proposed and rejected, with the reason: an
ordering argued once and discarded will be argued again otherwise.}

## Position

{Where the sprint is right now, in a sentence or two. What was just finished; what is next.}

## Ledger

{Facts established by investigation that no spec, skill or doc records yet — the things a fresh
agent would otherwise pay to rediscover. Each with its evidence. Migration numbers claimed but not
yet landed belong here. Prune anything that has since been written into a skill or `AGENTS.md` by
`retrospect`; this is a staging area, not a second home.}

## Repo State

{Current branch, working-tree cleanliness, concurrent-session hazards, anything committed but not
pushed, anything on an unexpected branch. Cheap to write, expensive to get wrong.}

## Open Questions

{Questions put to the user and not yet answered, oldest first, each with what it blocks. Carried
across checkpoints until answered.}

## Next Action

{The single next concrete thing — which spec to read, which plan to generate, which command to run.
Specific enough that a fresh agent doesn't re-derive it.}
```

---

## Quality Rules

1. **Evidence-based, like a retro.** "Generated" means a committed plan with a sha. "Shipped" means
   a RETRO exists and the spec says `shipped`. Never report intent as state.

2. **Point at sources; don't duplicate them.** The Sequence table gives status and a one-line scope;
   the spec file holds the design and the PLAN holds the steps. A sprint file that restates a spec
   will drift from it, and the drift is invisible.

3. **The Ledger is a staging area, not a second home.** A fact belongs there only until
   `retrospect` ingests it into an area skill, `AGENTS.md` or `knowledge/architecture.md`. At each
   checkpoint, prune what has landed elsewhere. A durable fact left only here dies with the sprint.

4. **Reference specs and cycles by stable ID, never by seq-prefixed path.** `[[AGT43]]`, not
   `knowledge/specs/065-AGT43-suggestion-expiry/AGT43.md`. The seq is a reassignable ordering
   hint — and this skill *reassigns* it, which makes the rule load-bearing here rather than
   theoretical. The one exception is the Sequence table, where the seq is the subject.

5. **Record the ordering rationale per edge, and record rejected orderings too.** The order is the
   sprint's irreducible knowledge. An edge justified only by "B needs A" will be reordered by a
   later session that can't see the mechanism.

6. **Always re-check the branch before reporting it, and immediately before any commit.** In a
   shared (non-worktree) checkout another session can change branches under you between one
   `git status` and the next — this has already produced a commit landing on the wrong branch.
   `git rev-parse --abbrev-ref HEAD` is the check.

7. **Never `git add -A`** while foreign uncommitted changes are present. Stage by explicit path.

8. **Concise.** A checkpoint, not a narrative.

---

## Interaction with the other knowledge skills

- **`spec-author`** owns each stub's format, the ID/seq rules, and supersession. `open` creates
  stubs that conform to it; this skill adds nothing to the spec format itself.
- **`tdd-cycle-generator`** turns a spec into a PLAN. Checkpoint after each generation so the
  claimed migration number lands in the Ledger before it goes stale — a plan's hardcoded migration
  number is the single most common thing to rot between generation and execution.
- **`handoff`** takes over inside one cycle's execution. The two coexist: a sprint may have a live
  `knowledge/SPRINT.md` and an executing cycle with its own `HANDOFF.md`. Neither replaces the other.
- **`retrospect`** is what drains the Ledger. When it ingests a lesson into a skill or doc, the
  next checkpoint removes it from here.
- **`wiki-lint`** should treat a `knowledge/SPRINT.md` whose specs are all `shipped` as a finding —
  the sprint should have been closed.
