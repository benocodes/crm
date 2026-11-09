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
2. **Scope.** Which spec sections and decisions this cycle delivers, within the **size budget** below.
   Split when the budget is exceeded, or when part of the spec depends on something not yet merged.
3. **Short name.** Kebab-case, describing *this cycle's* scope (`contacts-resource`, `webhook-delivery`).

#### A cycle is a complete, verifiable unit of work, not a complete feature

A cycle merges to `main` with the gate green, leaves `main` working, and proves every one of its own
obligations inside the cycle: no obligation whose test can only pass once a later cycle lands. Within those
three rules it may ship code nothing in production calls yet: a mechanism reached only through a test-only
operation, a route behind a config switch that is off, a table no operation writes until the next cycle.
**Dormant is fine. Unproven is not.**

So these are **not** reasons to keep a cycle whole: "a split would ship a runner nothing enqueues", "a route
nothing calls", "a table nothing writes". Nor is "the last cycle was larger and passed review in one round":
review rounds were never the problem with big cycles. Their cost was coder tokens (AGT8 cycle 1 about 550k,
[[CHN155]] about 390k, [[AGT165]] over 480k before E2E), context pressure, and expensive resumes. A good cut
gives each piece obligations it can prove on its own (often the mechanism first, proven through a test kit,
then its entry points, then its riders) and names every deferred item.

#### Size budget

Count these before you write the charter, and put the counts in its **Size** line:

| Measure | Budget |
|---|---|
| "Must be tested" groups (one bullet = one group) | **≤ 6** |
| matrix-shaped groups (a case per resource, per credential path, per policy × outcome) | **≤ 1** |
| spec decisions (D-numbers) delivered | **≤ 8** |
| migrations | **≤ 1** |
| E2E parts (a local run and a remote deploy check are two) | **≤ 1** |
| riders: another issue's fix, a docs guide, a recorder kind, an env's cron line | **0** if it brings its own obligation |

Over budget on any line means split, at plan time. Do not write a fallback cut ("split if the runner passes
~1,500 lines"): a coder deep in a cycle does not stop to split it, and lines do not predict tokens ([[AGT165]]
D47's tripwire never fired). The one exception is OPS92's: a large mechanical change (renames, file
splits) that one check proves whole, such as a before/after test-name manifest, is one cycle, because a split
only adds an interim state where old and new mechanisms live side by side. Say so in the Size line.

These numbers are a first calibration (2026-11-06). Each retro records the cost against them ([[retrospect]]),
and they move when the retros say so.

**AGT165 calibration** (`knowledge/specs/008-AGT165-execution-rail/RETRO.md`): its pre-budget charter
had 12 test groups (2 matrix), 13 new spec decisions and the #168 rider; the original implementation
was reported at about 503k tokens / 171 calls, before the final fix round. Its natural cut was four
cycles: table and queued approval; runner and retries; cron and expiry sweep; #168's visibility fix.
Those independently provable units were available before coding. The runner's proposed ~1,500-line
tripwire did not protect the whole cycle. Apply the existing budget up front; this example adds no
exception and does not lower the current limits.

**CORE175 calibration** (`knowledge/specs/012-CORE175-list-sort-rollout/RETRO.md`): 5 groups (1 matrix),
7 decisions, no migration or E2E cost 274k tokens / 129 calls in one run, approved with no findings. A
201-case matrix is cheap once fixture devices exist. The unbudgeted work was ~9 existing assertions that
used a not-yet-adopted resource as their negative example. When a cycle makes a capability universal
(every list, every resource), say in **Watch out** that existing tests using an unadopted resource as the
"without X" case will turn red and must move to a case excluded by design; this is not a budget count.

**AGT186 calibration** (`knowledge/specs/013-AGT186-agent-scope-delta/RETRO.md`): 6 groups (1 matrix),
8 decisions, no migration or E2E cost 149k tokens / 56 calls in one run, ~27 min, approved round 1 with
cosmetic notes only; +70 code / +754 test and fixture lines. A one-resource override with no migration
sits far under the budget; charters of this shape need no split discussion.
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
**Size:** {n} test groups ({m} matrix) · {d} decisions · {migration or none} · E2E {0|1} part · riders {none | list}
{Every count within the size budget, or the OPS92 mechanical exception named.}

## In this cycle
{The spec sections and decisions (D-numbers) this cycle delivers, one bullet each. Name the outcome,
not the files. Where the spec is silent on a shape the tests will pin (an error code, an event payload),
say so here: the coder decides it and records the decision, and review rules on it. Where the coder
also decides a mechanism's *extent* (one parameter or all of them, one type or every type), the matching
obligation says that the test pins whichever extent is chosen, on a case other than the original. Otherwise a
general implementation that is tested only through its first case costs a review round ([[CORE129]] D10a).}

## Deferred
- {item} → {[[cycle ID]] or #issue}

{Plus non-goals that someone might reasonably expect in this cycle, with a reason.}

## Must be tested before review
{The behaviours and risks that must be proven, each with the evidence that counts. This is the list the
reviewer checks the branch against. It is not per-file test tables: say *what* must hold, not how the
test is written.}

{A "never in events" or "never leaks" obligation names every path that emits the resource's events, including
programs owned by other resources (cascades from a parent's delete, merges), not only the resource's own create,
update and delete. [[CORE131]] listed created/updated/merged; the company-delete cascade leaked and cost a review round.}

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
| red run | new behaviour a test can see missing before the code exists. Not for a check of code that may already be right (a replay of new fixtures through existing parsers, a cost formula the code may already meet): ask for "red run, or an absence mutation if it is green on first run" ([[CHN153b]]: three such obligations had no red run) |
| absence mutation (name the fault and the engine) | a suite that needs the whole vertical (contract, parity, atomicity, concurrency, golden), or a "never does X" property |
| both engines | anything in storage or the service layer (D1 is the oracle; Postgres runs and reports drift) |
| type-level negative at the call site | a compile-time contract ([[writing-tests]] §2) |
| empty-state case | a rule that compares against stored state is silent when there is none (rule 3) |
| contract / golden suite | a new resource definition (contract suite, [[architecture]] §11) or a deliberate behaviour change (golden regeneration) |
| drift case per guard | a D1 set write or a write with more than one guard |

Pick the obligations by risk: tenancy and attribution, the AGENTS.md invariants the cycle touches, every
refusal and error path the spec defines, and anything a past cycle of this spec got wrong. At most six
groups (the size budget); if the risks need more, the cycle is too big. A behaviour the spec states but
this cycle doesn't deliver belongs under Deferred, not here.

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
that spec D6 caches for the isolate's life, and review had to amend the scenario. Likewise, the E2E runs
from the unmerged cycle branch, so a check against a live deployment that compares with HEAD (a deploy
step's idempotence, `/health.version`) reports a change, not `ok`: exclude that step or expect the change
([[OPS65]]'s A3 expected "every step ok" and got `deploy: update`).

Write the scenario so a tester can run it literally ([[CORE74]] needed two deviations and one false failure):
- **Scopes in full** (`notes:read`, `notes:write`): the grammar is `resource:action` with no wildcard, so
  `notes:*` cannot be granted. List the scope of **every** step's operation (a `schema get` step needs
  `schema:read`), and do not plan to add scopes later through `bootstrap`: a second bootstrap on the same
  org is refused, so the only fallback is a fresh local D1 ([[API6]] E2E).
- **A migration over data seeds the old schema directly** (SQL against the database at the previous
  migration, or the previous build), never through the new Worker: since [[CORE61]] the new code answers
  `503 migrations_pending` until the database is current. List that `503` as an expected step.
- **An obligation that says "still" (a trigger, a constraint, a refusal kept) is checked against the migration
  that created it.** [[CHN140]]'s charter said a rebuild kept `UPDATE` *and* `DELETE` refused; `0004` only ever
  refused `UPDATE`, which cost a deviation. Open the original file before writing "still".
- **A cycle that changes an existing E2E script's expectation** (a step that flips) names that script for the
  tester too. [[API115]] flipped `e2e:connect`'s MCP step without naming it, and review had to add the run as a
  pre-merge condition.
- **Deletes as the spec defines them:** for a soft delete, say "`deleted_at` set, row kept". Left unsaid,
  the tester asserted that cascaded edges were gone, against [[CORE62]] D15.
- **A refusal step is a full command line.** The tool validates its required flags before the check the step
  targets, so a refusal written as "`--clerk-env-file .env` refuses" is refused for a missing `--api-host`
  instead, and never reaches the key check ([[OPS87]] A4).
- **A step meant to observe a provider's refusal creates the condition for it.** "Record Clerk's raw refusal"
  observed nothing on an instance whose scope catalog was already complete; send one unknown key on purpose
  (and clean up what it creates), or move the observation to an issue ([[OPS87]], #103).

A scenario states, in order:
- **Initial state:** what exists before (rows, tenants, credentials, fixtures) and how to set it up.
  List the **full required configuration** of the adapter the Worker composes (from its config parser or
  `.dev.vars.example`), not only the variables the cycle reads: [[CORE84]]'s scenario omitted
  `CLERK_SECRET_KEY`, which the workspace adapter requires, and the Worker answered `500`.
- **Actions:** the real calls, with payloads (REST/MCP requests, CLI commands, fixture replays).
- **Expected end state:** responses, rows, events, including the failure paths the cycle defines.
- **Expected database:** which one it must run against (an exported `DATABASE_URL` overrides
  `--env-file`, so a server started from a test shell can serve the test DB).

### Step 5: Check and push

1. No seq-prefixed spec path in the text (`grep -nE 'knowledge/specs/[0-9]{3}-' <plan>` is empty).
2. Every deferred item has a cycle or issue; the spec's **Implementation cycles** block lists them.
   The **Size** line's counts match the charter and sit within the budget.
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
   the auth mechanism and the seams. The coder fetches them again for detail. **For an E2E on a real
   third-party instance, check that every configuration step the scenario needs has an API.** A step that
   exists only in the provider's dashboard is a precondition the user completes before the tester runs. Do
   not write it as a tester step. Also check that tokens minted through the provider's API carry the same
   claims as browser tokens. [[CORE64]]: Clerk's session-token customisation is dashboard-only, and
   Backend-API session tokens carry no `azp`. That cost one blocked E2E run and one review round.
   **Do not script a browser sign-in through one sign-in method** (email code `424242`, a password). Those
   methods are dashboard state, and someone may change them between plan and run. Use the provider's
   method-independent path: for Clerk, a Backend-API sign-in token (`POST /v1/sign_in_tokens`) passed as
   `__clerk_ticket` on the Account Portal URL, or `@clerk/testing`'s `clerk.signIn` on the page's own Clerk.
   **Quote an expected error body from the spec's error contract, never a paraphrase.** A configuration
   error is a generic `500 internal`, and only the Worker log names the variable ([[CORE64]]). [[UI30]]'s
   charter had both wrong, which cost the E2E a false failure and a tester round.
7. **A cycle that adds a resource names the contract file and both runs.** Add it to the contract suite
   (`packages/api/src/contract.integration.d1.test.ts`) rather than hand-writing the checks, and say so in the
   charter. The file has a Postgres run and a D1 run; the D1 run registers its resources by hand, so a
   resource in the D1 gate must be added to that registry and fixture map. [[CORE68]]'s plan named a
   nonexistent file and said "both backends" without the D1 step, so the fixtures it switched had no red
   run and ran only on Postgres.
8. **Check that every obligation names a case the code can reach.** An error-path obligation must name a state
   where the failure can be seen: [[CHN5]] cycle 1 asked for "the source sees `cancel` when `put` rejects (buffered
   path)", but on that path the source is already drained, so no test could see the cancel. The coder tested the
   known-size path instead. A measurement obligation names the artifact to measure. "The Worker bundle size before and
   after" could not show the cost, because `src/worker.ts` tree-shakes a module with no route yet. Name the bundle
   that contains the module (there, the smoke pipeline bundle), or defer the measurement to the cycle that wires the
   route.
