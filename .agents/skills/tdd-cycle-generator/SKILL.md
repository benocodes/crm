---
name: tdd-cycle-generator
description: Write a cycle charter (PLAN.md, or a plan-only cycle folder) from a spec - what this cycle delivers versus what is left for later cycles, what must be proven by tests before review, and whether it needs an E2E scenario. It does not survey the code or prescribe implementation; the coder does that once, against the real tree (execute-cycle). Use when starting any implementation cycle: the first cycle of a new spec, or a follow-on cycle for an existing one.
---

# Cycle charter

A PLAN does two jobs and nothing else:

1. **Scope.** What this cycle delivers, and what is left for later cycles (with their issues).
2. **Test obligations.** What must be proven by tests before review, and what kind of evidence counts.

It also says whether the cycle needs an E2E scenario, because that takes the same judgment.

**What a PLAN is not.** It has no code map, no file-by-file test tables, no implementation steps and no
commands. The coder works all of those out once, against the real tree, following
[[execute-cycle]], which holds the boilerplate (worktree, red/green order, gate, commit, report). Plans
used to carry all of that, at 700–1,000 lines. The coder re-checked every citation anyway ("the tree
wins"), and rows written before anyone read the code went stale ([[CORE35]] D22, [[CORE25]]'s grant,
[[CORE58]]'s sanitiser). Aim for **60–120 lines**. If a charter grows past that, the cycle is too big
or the charter is drifting into implementation.

Each cycle is **one folder**. If a spec is implemented across several cycles, each gets its own folder
with its own ID, plan and retro. The spec lives where it was first authored; later cycles reference it
through `implements: "[[<spec-ID>]]"`. See [[spec-author]] §1.5.

**Usage:** `/tdd-cycle-generator knowledge/specs/<seq>-<ID>-<slug>/<ID>.md`

---

## Workflow

### Step 1: Read the spec

```bash
git -C knowledge pull --rebase
```

Read the spec note: its goal, design, decisions (D-numbers), acceptance criteria and its
`**Implementation cycles:**` block (what is already planned or shipped, and what is unclaimed). Read the
RETRO "Deviations" and "Lessons" of **earlier cycles of this spec** only. Area-wide lessons are already in
the skills the coder reads ([[retrospect]] ingests them there).

Look at the code only as far as you need to **size and split** the work: `git log --oneline`, the
package layout, how big the touched modules are. Don't cite signatures or plan steps.

### Step 2: Decide shape, scope and name

Ask via `AskUserQuestion`. In an orchestrated sprint the planner decides itself and records the choice
and the reason in the charter's **Scope** section.

1. **Shape.**
   - **First cycle (spec-introducing):** `PLAN.md` in the spec's folder. Only when no `PLAN.md` exists
     there yet.
   - **Follow-on cycle (plan-only):** the new folder's owning note `<new-ID>.md`, with
     `implements: "[[<spec-ID>]]"`. If a `PLAN.md` already exists in the spec's folder, the answer is
     always follow-on. Never overwrite an existing plan.
2. **Scope.** Which spec sections and decisions this cycle delivers. Split when one PR would be too big
   to review in one sitting, or when part of the spec depends on something not yet merged. A good cut
   leaves `main` working and every deferred item nameable.
3. **Short name.** Kebab-case, describing *this cycle's* scope (`contacts-resource`, `webhook-delivery`).

### Step 3: Resolve identities

- **New cycle ID** (follow-on only): the GitHub issue number tracking it, with the spec's area code
  (`CORE57`). Open the issue first if none exists (`open-issue`, `--label self-triaged`). Never suffix
  the spec's ID (`CORE36b` is wrong).
- **Deferred work:** every deferred item names the cycle or issue that will pick it up. Open those issues
  now (`open-issue`, `--label self-triaged`) and add them to the spec's **Implementation cycles** block,
  so nothing deferred lives only in prose.
- **Folder:** first cycle `knowledge/specs/<seq>-<spec-ID>-<slug>/PLAN.md`; follow-on
  `knowledge/specs/<seq>-<new-ID>-<slug>/<new-ID>.md`. Use the same seq as the spec-introducing cycle
  when shipping in the same window.

### Step 4: Write the charter

**Frontmatter.** First cycle:

```yaml
---
id: <spec-ID>
type: plan
order: <seq>
title: "{Title} - Cycle"
implements: "[[<spec-ID>]]"
---
```

Follow-on:

```yaml
---
id: <new-ID>
type: plan
order: <seq>
title: "{Cycle title}"
aliases: [<new-ID>, "{Cycle title}"]
status: draft
implements: "[[<spec-ID>]]"
---
```

**Body:**

````markdown
# {Cycle title}

**Spec:** [[<spec-ID>]] · **Goal:** {one line, scoped to this cycle}
**Assumes merged:** [[...]] {prior cycles this builds on, or "nothing beyond main"}

## In this cycle
{The spec sections and decisions (D-numbers) this cycle delivers, one bullet each. Name the outcome,
not the files. Where the spec is silent on a shape the tests will pin (an error code, an event payload),
say so here: the coder decides it and records the decision, and review rules on it.}

## Deferred
- {item} → {[[cycle ID]] or #issue}

{Plus non-goals that someone might reasonably expect in this cycle, with a reason.}

## Must be tested before review
{The behaviours and risks that must be proven, each with the evidence that counts. This is the list the
reviewer checks the branch against. It is not per-file test tables: say *what* must hold, not how the
test is written.}

- {behaviour or risk} — {evidence}

## E2E
{A scenario, or `E2E: none ({reason})`.}

## Watch out
{Optional, at most five bullets: a trap from an earlier cycle of this spec, a third-party API whose docs
must be fetched first, a remote resource the user must create (rule 4). Omit the section if empty.}
````

**Evidence kinds** for "Must be tested" (the coder follows [[writing-tests]] for how):

| Evidence | Use when |
|---|---|
| red run | new behaviour a test can see missing before the code exists |
| absence mutation (name the fault and the engine) | a suite that needs the whole vertical (contract, parity, atomicity, concurrency, golden), or a "never does X" property |
| both engines | anything in storage or the service layer (D1 is the oracle; Postgres runs and reports drift) |
| type-level negative at the call site | a compile-time contract ([[writing-tests]] §2) |
| empty-state case | a rule that compares against stored state is silent when there is none (rule 3) |
| contract / golden suite | a new resource definition (contract suite, [[architecture]] §11) or a deliberate behaviour change (golden regeneration) |
| drift case per guard | a D1 set write or a write with more than one guard |

Pick the obligations by risk: tenancy and attribution, the AGENTS.md invariants the cycle touches, every
refusal and error path the spec defines, and anything a past cycle of this spec got wrong. Five to fifteen
bullets is typical. A behaviour the spec states but this cycle doesn't deliver belongs under Deferred, not
here.

**E2E: include a scenario** only when the cycle adds behaviour across a real seam the deterministic tests
fake or skip: a new externally reachable surface (REST route, MCP tool, CLI command, the pane, a channel
adapter over a recorded fixture); infrastructure Node doesn't reproduce (workerd, Workflows, Queues,
Hyperdrive, R2); auth, tenancy or approval flows through the real pool; a migration over a database that
already holds data. Otherwise (refactors, service-layer changes covered by both-engine tests, schema-only
additions covered by contract tests, types, docs, skills) write `E2E: none` with the reason, and the
orchestrator spawns no e2e-tester.

Check each expected end state against the spec's decisions before writing it down, especially caches,
re-read windows and consistency rules. Where state is cached per isolate or per process, say whether a step
runs on a cold or a warm instance. [[CORE61]]'s charter expected a warm Worker to notice a deleted tracker row
that spec D6 caches for the isolate's life, and review had to amend the scenario.

A scenario states, in order:
- **Initial state:** what exists before (rows, tenants, credentials, fixtures) and how to set it up.
- **Actions:** the real calls, with payloads (REST/MCP requests, CLI commands, fixture replays).
- **Expected end state:** responses, rows, events, including the failure paths the cycle defines.
- **Expected database:** which one it must run against (an exported `DATABASE_URL` overrides
  `--env-file`, so a server started from a test shell can serve the test DB).

### Step 5: Check and push

1. No seq-prefixed spec path in the text (`grep -nE 'knowledge/specs/[0-9]{3}-' <plan>` is empty).
2. Every deferred item has a cycle or issue; the spec's **Implementation cycles** block lists them.
3. Every "Must be tested" bullet names its evidence.
4. Commit straight to the knowledge repo's `main` and push (no PR; the coder and the reviewer must read the
   same charter):

```bash
git -C knowledge pull --rebase
git -C knowledge add specs/<seq>-<ID>-<slug>/ specs/<spec folder>/<spec-ID>.md
git -C knowledge commit -m "docs(specs): <ID> cycle charter — <short scope>"
git -C knowledge push
```

Writing and pushing the charter is where this skill ends. Implementation follows [[execute-cycle]].

---

## Charter rules

1. **Reference specs and cycles by stable ID**, never by seq-prefixed path. Folders get renumbered, and
   every reference written through the seq dies silently.
2. **One cycle, one folder.** A `PLAN.md` is the only plan in its folder. Never `PLAN-02.md`.
3. **A rule that compares against stored state gets an empty-state obligation.** A guard such as
   [[CORE3]] D20's newer-copy rule is silent when there is no row to compare, and that is where it leaked
   in [[CORE29]]. If the spec doesn't say what happens with no stored state, raise it as a spec question
   (in a sprint: decide it in the spec, with a Ledger line) before the charter ships.
4. **A step that creates a remote resource names who runs it, and assumes the agent cannot.** Claude
   Code's permission classifier denies an agent's creation of external resources (`wrangler d1 create`,
   `r2 bucket create`, a first deploy that attaches a Custom Domain) even when the spec authorizes it,
   because a spec's word is not the user's consent. Put it under **Watch out** as either "the user runs
   it" (exact commands) or "the agent runs it once the user has added scoped allow rules" to their
   gitignored `.claude/settings.local.json`. Never plan a workaround through another tool ([[OPS4]]).
   Read-only probes are not affected. In a sprint this is a hard stop for the orchestrator.
5. **A behaviour change is a spec decision, not a charter line.** When a cycle migrates existing
   behaviour and the spec doesn't decide whether it changes, the obligation is "matches today's
   behaviour", and the coder reads the old code as the reference ([[CORE35]] D22).
6. **Fetch external API docs** before scoping a cycle that integrates a third-party API, enough to know
   the auth mechanism and the seams. The coder fetches them again for detail.
7. **A cycle that adds a resource names the contract file and both runs.** Add it to the contract suite
   (`packages/api/src/contract.integration.test.ts`) rather than hand-writing the checks, and say so in the
   charter. The file has a Postgres run and a D1 run; the D1 run registers its resources by hand, so a
   resource in the D1 gate must be added to that registry and fixture map. [[CORE68]]'s plan named a
   nonexistent file and said "both backends" without the D1 step, so the fixtures it switched had no red
   run and ran only on Postgres.
