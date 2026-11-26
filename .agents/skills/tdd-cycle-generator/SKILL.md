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

A dormant cycle usually proves "nothing calls this yet" with a test (a grep for callers, [[CORE327]] group 6 in
`packages/storage-d1/src/control-webhooks.integration.test.ts`). That test is meant to break: the wiring cycle's
charter names it under "In this cycle" as a deletion, with the dormant cycle's review notes carried into its Watch
out, so the coder does not "fix" the wiring to keep it green.

A change that lowers a read requirement (a narrower scope reads what a wider one did) is cut as "mechanism first, then
the switch". The first cycle ships the redaction, wired into every output path and proven through a test seam. The
second cycle lowers the requirement, and in the same cycle it widens every place that checks or parses scopes. Then
`main` never leaks unredacted data, and never drops delivery to holders of the old scope. Name every scope-grammar copy in
the switch cycle's charter. A copy that filters stored scopes drops the new scope without an error, for example the
dispatch filter in `webhooks/crm-reads.ts` ([[API514]] review). When widening the grammar and its closure, with a
matrix over authentication paths, makes the switch cycle too big, cut it into three. Ship the grammar and the closure
dormant first: they are gated on the declared set, so nothing changes until a scope is declared ([[API518]]). Then
ship the switch.

A dormant cycle proven "through a test seam" sometimes needs a small production hook for the seam, because today's
declarations cannot express the new case (in [[API518]], an event type readable at `read_metadata`). Name that hook
in the charter, and name the switch cycle as the one that fills it. Otherwise the coder has to invent it.

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
only adds an interim state where old and new mechanisms live side by side. Say so in the Size line. A rename
charter also asks for: the docs' samples parsed by the shipped code (a renamed key is an ordinary word no token ban
catches), the old name refused by a test that the guard's allow-list names, and the changesets read back after the
replace (lowercase sentence starts survive into the CHANGELOG) ([[CORE569]] review).

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
sits far under the budget; charters of this shape need no split discussion. **CORE187** (`knowledge/specs/013-CORE187-sort-discovery/RETRO.md`)
confirms it: 5 groups (1 matrix), 5 decisions, no migration or E2E cost 169k tokens / 53 calls, ~25 min, approved round 1
with no findings. Its spec decisions (D16–D18) were settled at plan time, leaving the coder only presentation choices; a
generated golden (6,388 lines here) is not counted against the budget. **CORE188** (`knowledge/specs/013-CORE188-execution-sort/RETRO.md`):
5 groups (1 matrix), 7 decisions, no migration or E2E cost ~240k tokens / 118 calls, ~33 min, approved round 1. Seven
absence mutations and a file rewritten after a bad restore drove the calls, not the counts; the budget holds.
**CORE200** (`knowledge/specs/013-CORE200-deal-filter-grammar/RETRO.md`): 6 groups (1 matrix), 8 decisions, at the limit on
both, no migration or E2E cost ~228k tokens / ~100 calls, +363 code / +596 test lines, one 3-call fix round (description
text). A charter at the limit on two lines still fits one run. When a charter restates a spec's claim about stored data (a
collation, a uniqueness, a nullability), check it against the migration at plan time or name it in Watch out as a premise
the coder must test: CORE200's D7 premise (tag names case-sensitive "as the index is") was false.
**CORE201** (`knowledge/specs/013-CORE201-filter-rollout/RETRO.md`): 6 groups (1 matrix), 5 decisions, no migration or E2E
cost ~250k tokens / ~80 calls initially (one run, continued past the 20-min api suite), then two fix rounds (31 and 7 calls,
the cap) and three review rounds, all on the prose of checked-in stated-cost reasons. The budget held; the overrun came from a
deliverable with no obligation on its truth. When a charter asks for checked-in reasons, descriptions or notes that state
facts about the schema or indexes, either add an obligation that a test checks them against the catalog, or ask for
category reasons that name no index; never leave their correctness to review.
**CORE202** (`knowledge/specs/013-CORE202-deal-aggregate/RETRO.md`): 6 groups (1 matrix), 5 decisions, no migration or E2E
cost ~254k tokens / ~101 calls in one run, +297 code / +540 test lines, approved round 1 with no blocking findings and no
fix round. A new registry operation exposed on REST, MCP and CLI is one definition and one test per surface, not three pieces
of work. Applying the CORE201 lesson at plan time (the cost sentence generated, index-free and plan-checked as an obligation)
removed the review rounds it had cost. When Watch out names a numeric limit, name the layer below it too (2^53 for JS, then
int64 for the engine).
**CORE259** (`knowledge/specs/015-CORE259-control-plane-database/RETRO.md`): 6 groups (1 matrix), 8 decisions, 1 migration
(at the limit on three lines), no E2E cost 294k tokens / 152 calls (263k/115 initial, ~31k/37 for one fix round), ~25 min
gate; the budget holds. The calls went to harness rewrites in three packages for a second database binding. When a cycle adds a
binding or a database, (1) list every harness and test that composes the Worker in Watch out, and (2) add an obligation against
the **real** `wrangler.jsonc` (`getPlatformProxy`), not only the test kit's own Miniflare: the shared placeholder
`database_id` that made the two databases one locally passed every kit-based test and was caught only at review.
**OPS260** (`knowledge/specs/015-OPS260-two-database-tooling/RETRO.md`): 5 groups (1 matrix), 5 decisions, 1 migration, no E2E,
cost ~374k tokens / 75 calls over three runs (the first ran out of context at 204k after 47 calls, before a green gate). Few
calls, many tokens: a real `release:build` + `release:check` run and full-suite output fill the context. The budget holds; when a
charter asks for such a run, say "capture the output to a file, quote the decisive lines", and for a migration that drops or
moves tables, Watch out says "grep every package for the names" rather than listing the files the planner found.
**CORE261** (`knowledge/specs/015-CORE261-audit-list/RETRO.md`): 5 groups (1 matrix), 1 spec decision + 6 planner rules, no
migration, cost 245k / 148 calls including one 5k fix round. The budget holds. The fix round came from a rule worded as
"anywhere" (P2, "not a default grant anywhere") with an enumeration of only two sites; the coder found a third, review a fourth
(the `/mcp` challenge hint). When a rule says "every" or "anywhere", state the property and the grep that finds the sites
(here `grantableScopes(`), never a closed list of the sites the planner remembered.
**CORE357** (`knowledge/specs/015-CORE357-api-key-events-off-feed/RETRO.md`): 4 groups (1 matrix), no migration, one fix
round. A grep by pattern finds texts that say something wrong, never a text that omits something: when a cycle moves a
capability to a new home (key changes from the feed to `audit.list`), name the home's own enumeration as an obligation
("`audit.list`'s description lists API keys"), found by grepping the previous mover's entry (`not in the event feed`).
**OPS275** (`knowledge/specs/015-OPS275-instance-tooling-two-databases/RETRO.md`): the same Size line (5 groups, 1 matrix, 5
decisions), no migration, scripts-only, cost 143k / 41 calls in one run with review approved in round 1; without release runs
and with the `@vibase/api` suite legitimately skipped (`execute-cycle` §5) the same counts cost ~40% of OPS260. The budget holds.
**OPS276** (`knowledge/specs/015-OPS276-setup-vb-names/RETRO.md`): 4 groups (1 matrix), 4 decisions, no migration, scripts-only,
cost 182k / 51 calls in one run, approved round 1. When an obligation spans several front-ends (two CLIs, REST and MCP), state a
refusal as "refused before any call, with that front-end's refusal exit code", not one number: OPS276's charter said exit 2 for
both setup front-ends, but `setup:remote` exits 1 for every refusal, and the coder had to amend it. And when a cycle changes a
default name, ship the guard that keeps existing instances on their recorded names in the same cycle, and say where the record is
read relative to the first step that creates a resource.
**OPS279** (`knowledge/specs/015-OPS279-setup-control-database/RETRO.md`): 6 groups (1 matrix), 7 decisions, at the limit on
groups, no migration, scripts-only, cost ~320k / 97 calls in one run plus a one-line fix round. Twice OPS276's cost for 1.5x the
counts: the unbudgeted work was a planner decision (P4: setup adds a control database to *every* recorded instance) that changed
the plan of every existing fixture, so 8 suites asserting "nothing planned" for `smoked1`/`demo` had to record a control database.
When a charter decision changes the default plan or output for every existing instance or fixture, say so in **Watch out** and
name it in the Size line ("rider: existing fixtures"), so the split question is asked with that cost in view.
**CORE283** (`knowledge/specs/015-CORE283-better-auth-clients-discovery/RETRO.md`): 6 groups (1 matrix), 4 decisions, no
migration, 1 local E2E part, cost 307k / 108 calls (one 8k fix round). The budget holds. A Watch out item that ends in "check what
it does and record it" (the rate limiter with no client IP) is an unproven behaviour: make it an obligation with its own test,
or it comes back as a review finding, as it did here.
**CORE287** (`knowledge/specs/015-CORE287-invitation-signup/RETRO.md`): 5 groups (1 matrix), 4 decisions + 7 planner rules,
no migration, 1 local E2E part, cost 258k / 82 calls in one run plus a 9k fix round. The budget holds. Both review findings came
from the charter. (1) A rule for a commit across two stores (CRM, then control) named a repair for only one partial state. When
a charter orders a write across stores, list every partial state and say what the next attempt does with each. (2) "Checked
where every account creation passes" had no obligation of its own, so the second-layer hook shipped untested. Every place a
requirement names as a check point gets a test that reaches it directly.
**UI254** (`knowledge/specs/015-UI254-ui-foundation/RETRO.md`): 6 groups (1 matrix: component × runtime), 8 decisions, no
migration, 1 local E2E part (the Playwright gallery), new package, cost ~198k / 53 calls in one run plus a 5k / 6-call gate-fix
round, approved round 1 with no findings. The budget holds, and a matrix over two runtimes costs little once one suite body
serves both. The gate-fix round came from a new workspace package: the release tests pin the package list and the changesets
`ignore` list (`execute-cycle` §commit). A charter that adds a package says so in Watch out. A browser E2E part earns its
place for UI: it found the one runtime bug (`spellCheck={false}` dropped by Preact) that both happy-dom projects missed.
**UI446** (`knowledge/specs/023-UI446-auth-pages-on-new-ui/RETRO.md`): 5 groups (1 matrix), 8 decisions, no migration, 1 local
E2E part, cost ~160k plus a ~181k fix round, approved with no findings. The budget holds; the cost sat in the E2E round. A
charter that swaps a package's runtime (Preact to React) names in Watch out what only a browser shows: scheduled vs
synchronous first render, component transitions under `emulateMedia`, and Biome's React rules turning on with the
dependency (`execute-cycle` §5).
**UI247** (`knowledge/specs/015-UI247-oauth-pages/RETRO.md`): 5 groups (1 matrix), 7 decisions, no migration, 1 local E2E part
(two legs, the real CLI and an MCP-style client), cost ~307k / 148 calls in one run plus a 5k fix round of four small findings.
[[UI246]] had the same shape and cost ~290k: a pages cycle with a real-browser E2E lands near 300k at 5 groups, and the E2E
carries the extra calls. The budget holds. Before writing an E2E initial state, check what the real clients in it demand. UI247's
charter set `PUBLIC_BASE_URL=http://localhost`, but `vibase login` refuses a non-https issuer, which cost several E2E
iterations (writing-tests §7 has the HTTPS recipe). A package list copied from the spec ("no change") goes stale as soon as the
charter leaves a method to the coder. Say "expected" there, not "unchanged".
**UI297** (`knowledge/specs/015-UI297-connect-better-auth/RETRO.md`): 5 groups (1 matrix), 2 decisions, no migration, 1 local
E2E part (one leg added to an existing script). It cost ~140k in one run plus a 3k fix round. This is a follow-on cycle
split off a pages spec at plan time, and it cost about half the parent cycle, because the E2E harness and the HTTPS recipe
already existed. The budget holds. The one finding came from a planner rule that gave only the success end state
("afterwards the page shows signed-out"). A rule for a new action names its end state on failure too.
**CORE294** (`knowledge/specs/015-CORE294-google-sign-in/RETRO.md`): 5 groups (1 matrix), 3 decisions + 5 planner rules,
no migration, 1 local E2E part (a leg added to an existing script). It cost ~266k / 99 calls in one run plus a 5k fix
round (+178 / +648 lines): a follow-on cycle like UI297, but two new fakes (workerd outbound service, Node `fetch`) and a
security matrix nearly doubled it. The budget holds. The fix round repeated UI297's gap: P1 named how a callback error is
shown, not what happens to it when a later action fails. For any displayed error, name when it clears. A stop condition
phrased as a premise to test ("prove `getOAuthState()` is readable in the hook before building on it") worked: the
coder answered it with a test instead of improvising.
**CORE288** (`knowledge/specs/015-CORE288-membership-writes/RETRO.md`): 6 groups (1 matrix), 4 decisions + 7 planner rules,
no migration, 1 local E2E part, four packages touched. It cost 338k / 116 calls in one run with no fix round (+420 / +625
lines, 27 files): the dearest cycle of the band so far, at the group limit, and the budget held. The hidden work was a
read-only resource becoming writable: the generic contract suite (a `patch` fixture), the administration storage suite ("no
write operations"), a roles test and three goldens all pinned read-only and turned red. When a charter adds writes to an
existing resource, name those pins in Watch out. A charter that lists every partial state of a cross-store write (P5) and
puts the race inside the guard (P4), each with an absence mutation, drew no review finding: the CORE287 lesson applied.
**OPS249** (`knowledge/specs/015-OPS249-programmatic-setup/RETRO.md`): 6 groups (1 matrix), 6 decisions, no migration,
scripts-only, rider existing fixtures, split at plan time from 9 decisions. It cost ~327k / 82 calls in one run plus a 3k fix
round (+405 / +938 lines, 26 files). The budget holds, but every obligation ran on both setup front-ends: six groups became two
51-test files, and kit work in both kits was the largest part. When obligations must be proven on two parallel front-ends,
write "× 2 front-ends" in the Size line. The one finding was a file-creating path that skipped a check the read-side probe
only made for existing files: when a charter adds a write to a file that holds a secret, make "refused unless git ignores it"
an obligation of its own.
**OPS306** (`knowledge/specs/015-OPS306-setup-verify-docs/RETRO.md`): 6 groups (1 matrix) × 2 front-ends, 4 decisions plus 4
planner rules, scripts and docs only. It cost 232k / 76 calls over two runs (+138 code / +639 test / +117 doc lines, 15 files),
with one text-only review round. Writing "× 2 front-ends" in the Size line and asking for one shared fixture builder per seam
kept this cycle under OPS249's cost.
**OPS308** (`knowledge/specs/015-OPS308-workers-dev-mode/RETRO.md`): 6 groups (1 matrix) × 2 front-ends, 3 decisions plus 6
planner rules, scripts and docs only, at the group limit. It cost 333k / 75 calls in one run plus a ~16k / 11-call fix round
(+357 code / +822 test lines, 35 files): OPS249's cost, so a sixth group × 2 front-ends is the ceiling. Both findings trace to
the charter. P3 put "host resolution in preflight" next to an account-wide write (registering the subdomain), and the coder
did the write during resolution, before later refusals. When a rule mixes a read with an external write, the charter says
the write runs after every refusal and a passing preflight, and asks for a "no write" case per later refusal. The charter
also said "the Google redirect URI" where an instance has two (Better Auth sign-in `/auth/callback/google`, the Gmail
connector's `/oauth/google/callback`): name each URI a consequence line must carry.
**OPS250** (`knowledge/specs/015-OPS250-auth-migration/RETRO.md`): 5 groups (1 matrix), 2 decisions + 4 planner rules,
scripts-only, one front-end. It cost ~196k / 57 calls over two runs (+121 code / +300 test lines, 11 files), one review round.
The budget holds; the round came from the charter. It listed the resource kinds a rebuilt env block must cover from setup's
record reader ("the Workflow too if the coder finds the record reads it"), and the reader shares setup's blind spot: the real
`smoked1`/`hq` blocks carry a hand-added `MAIL_SYNC` Workflow that no setup path writes (#368). When a charter rebuilds,
replaces or compares an env block, diff a real recorded block in `wrangler.jsonc` against what setup writes at plan time and
name every binding the real one holds, each with an obligation.
**OPS251** (`knowledge/specs/015-OPS251-smoked1-cutover/RETRO.md`): a remote cutover as a coder cycle plus a remote E2E, 6
groups (0 matrix), one test-only fix, review approved round 1. Coder ~112k / 47 calls; the budget holds. The extra cost
(~65k, one stop) came from the charter: it did not name the owner email the setup run invites, the coder defaulted to the
git user's, and an unclaimed owner invitation cannot gain a second owner beside it (`ship-branch`, `owner-reset`). A charter
that runs setup or a replace on a real instance names the owner email (or the `.env.<env>` line holding it).
**CORE302** (`knowledge/specs/015-CORE302-readmit-removed-member/RETRO.md`): 5 groups (1 matrix), 2 decisions + 6 planner
rules, no migration, 1 local E2E part (+224 code / +546 test lines, 12 files), two review rounds (the cap). The budget
holds; the rounds came from the spec. P1 said which token re-admits but not *when* it must have been issued, so the
first review had to add "created after the latest removal", and the fix for that weakened a same-second pin. When a
rule restores something a removal took away (a membership, a grant, a key), the spec bounds the restoring credential
in time ("issued after the removal"), and every timestamp-bound pin is built on a whole second (writing-tests).
**CORE304** (`knowledge/specs/015-CORE304-self-service-reset/RETRO.md`): 6 groups (1 matrix), 4 decisions + 4 planner
rules, no migration, 1 local E2E part, riders folded into group 6. It cost ~300k in its final run (+278 code / +1033 test
lines, 27 files), approved round 1 with no findings plus one free gate-fix round. The budget holds at the group limit. Two
charter lines were wrong against the real library and tooling: a refusal row for a route Better Auth 1.7.22 does not have
(`/forget-password`, a 404 before any hook), and "a new leg in `e2e:auth-pages`" for a scenario that needs a different
Worker configuration (email on, its own entry), which must be its own script (writing-tests §7). Before chartering a
behaviour of a library route, check the route exists in the pinned version; an E2E part whose Worker differs from an
existing script's is a new script, not a leg.
**CORE326** (`knowledge/specs/015-CORE326-control-plane-every-mode/RETRO.md`): 5 groups (1 matrix), 3 spec decisions + 6
planner rules, no migration, no E2E, rider existing fixtures. +185 code / +699 test lines, 70 files, approved after one fix
round. The budget holds, but the rider was the work: "every harness that composes the Worker" was ~25 server-d1 suites, 3
cli suites and the instance kit, absorbed only because the coder moved the new setup into the kit defaults. When a charter
makes a configuration mandatory that tests omit today, name the kit default that should carry it in Watch out. The fix
round was dead branches: the charter listed the scripts to refuse but not the code that consumed the old optional value
(`instance/gate.ts`, `upgrade.ts`). When a value turns from optional to required, ask for every `?`/`undefined` branch on
it to go, by property (grep the field name).
**CORE356** (`knowledge/specs/015-CORE356-api-key-writers-control/RETRO.md`): 5 groups (1 matrix), 4 spec decisions + 5
planner rules, no migration, no E2E, rider existing fixtures. ~283k / 129 calls in one run, +266 code / +653 test lines, 64
files, approved round 1. Over the call count of comparable cycles because the rider was ~40 suites that bootstrap through
`bootstrapD1` (import switched to a kit wrapper) and 8 that counted CRM keys or pinned an audit log. When a charter moves a
write that a shared test helper performs, grep the helper's callers at plan time and put the count in the Size line
(`rider: existing fixtures (~40 bootstrapD1 callers)`); above ~30, name the kit wrapper in Watch out so the coder edits one
default, not each suite.
**CORE329** (`knowledge/specs/015-CORE329-crm-contract-drop/RETRO.md`): 6 groups (1 matrix), 3 spec decisions + 6
planner rules, 1 migration (a CRM table drop), no E2E, rider existing fixtures. ~314k / 151 calls in one run, +157 / -543
code and +560 / -1537 test lines, 68 files, approved round 1 with no fix rounds. The budget holds, but the Size line said
"~15 suites and kits, found by grep" without running the grep, and the real rider was ~45 files. A cycle that removes a
table from the shared Kysely `Database` (or any shared type) touches every typecheck fixture, kit table list, golden and
suite that names it, not only its callers. Run `grep -rlw <name> packages` for each removed name at plan time and put the
file count, not an estimate, in the Size line.
**OPS393** (`knowledge/specs/015-OPS393-auth-migration-apply-run/RETRO.md`): 6 groups (1 matrix), 2 spec decisions + 6
planner rules, scripts only, no E2E, three skill riders. ~233k / 64 calls over two runs (+254 code / +634 test lines, 9
files), approved in round 2 after one coder round. The budget holds; the round came from the charter. The charter named
the deploy step's clean-tree guard only in Watch-out, not among the pre-write checks. As written, a dirty tree was
found after the control batch and the secret: exit 2 and a resume, where a refusal (exit 1) belonged. When a
multi-step command writes before a later step that can refuse (a deploy's clean tree, a committed config, a migration
level, a pairing), the charter lists that step's guard among the pre-write checks. It reuses the step's own guard and
asks for a "refused, nothing written" case for it.
**OPS397** (`knowledge/specs/015-OPS397-auth-migration-claim/RETRO.md`): chartered as 5 groups (1 matrix), really 6
groups over 6 bullets, with a refusal list of 8 cases × (real, `--dry-run`) that is a second matrix; 3 spec decisions + 6
planner rules, no migration, 1 local E2E part as a new script with a test-only driver. Coder 318k / 143 calls over an
initial run and one review round (+337 code / +1231 test lines, 496 of them E2E, 12 files). Over budget in substance: count
the bullets, not an estimate, and count a refusal list run under `--dry-run` too as a matrix. A new E2E script whose driver
swaps a shipped command's dependencies costs about half a cycle by itself; when the cycle also has a matrix, split the E2E
into its own cycle. The one review finding came from the charter naming three driver seams where the code path needed
seven: the charter lists every dependency the driver may fake, and asks for each to be named in the driver's header with
the manual check that replaces it (writing-tests §7).
**UI381** (`knowledge/specs/015-UI381-device-one-step/RETRO.md`): 5 groups (1 matrix), 2 decisions, no migration, 1 local
E2E part (legs changed in an existing script). Initial run ~117k / 32 calls (+67 code / +207 test lines, 13 files), then three
small follow-up rounds (lint, an E2E fold failure plus a leg left stale by an earlier fix, bookkeeping) of ~5 calls each that
re-read ~120k of context apiece and tripled the total. The budget holds. When a charter leaves a layout value to the coder
(a cap, a width) under a fold criterion, expect one E2E round on it. When the E2E part edits an existing script, put "run
the unchanged script once first" in Watch out, so a leg already broken on `main` is seen before it is mistaken for the
cycle's own failure.
**CHN410** (`knowledge/specs/015-CHN410-workspace-blocklist/RETRO.md`): 6 groups (1 matrix), 4 spec decisions + 4 planner
rules, no migration, no E2E, rider existing fixtures. ~224k / 75 calls in one run (+162 code / +659 test lines, 24 files),
approved round 1, gate green first time. The budget holds. The hidden work was a new generic resource's list: it must adopt
`withColumnFilters` and `withColumnSorts` (the registry filter and sort contracts refuse it otherwise), which adds
stated-cost entries in `filter-costs.ts` / `sort-costs.ts` and moves both contracts' counts. When a charter adds a generic
resource with a `list`, name "list contracts (column filters, sorts, stated costs)" in the Size line's riders. The same
adoption brings the whole filter grammar (`eq`, `in`, comparisons, `like`, `ilike`), so a planner rule about how a list
filter matches is written over that grammar: it constrains the bare/`eq` form, or says the column gets a narrower filter
option (410.12 superseded a rule that assumed an exact match only). Before chartering an acceptance case over a table,
read its CHECK constraints: "the same value with the other kind is accepted" could not occur (410.10).
**CHN420** (`knowledge/specs/016-CHN420-forms-resource/RETRO.md`): 6 groups (1 matrix), 8 decisions + 5 planner rules, 1
migration (at the limit on three lines), no E2E, riders list contracts and goldens. 238k / 74 calls in one run (+500 code /
+1,351 test and golden lines, 29 files), gate green first time, approved round 1 with no findings. A new generic resource with
its own migration at the limit on three lines still fits one run; a 15-decision spec split three ways at plan time cost nothing
extra. Planner rules that settle every interim behaviour (P1–P5: refused fields, dormant tables, the accepted gap until the
next cycle) left the coder only constraint shapes and harness choices to decide.
**CHN423** (`knowledge/specs/016-CHN423-form-principal-managed/RETRO.md`): 5 groups (1 matrix), 2 decisions + 6 planner rules,
no migration, no E2E, cost 158k / 44 calls in one run plus a 2k / 4-call fix round (+224 code / +384 test lines, 10 files).
The budget holds; a cycle well under it is cheap. Two charter riders were empty: "goldens (operation descriptions)" (golden
fixtures carry no descriptions, `writing-tests` §goldens) and "tests that pinned the interim gap must flip" (none existed).
Before naming a rider or a test to flip, grep for it at plan time; otherwise word it "if any". The fix round was a missing
changeset for a change in `@vibase/api` alone (`execute-cycle`, changesets). When a charter names the changeset, name the
published package it bumps (`@vibase/server-d1`), not `@vibase/api`, which is unpublished ([[CHN424]] 424.10).
**CHN421** cycle 1 (`knowledge/specs/016-CHN421-form-ingress/RETRO.md`): 6 groups (1 matrix), 4 decisions + 3 planner rules,
1 migration rebuilding five tables, no E2E. Cost 197k / 72 calls over two runs (+263 code / +669 test lines, 36 files), with
one fix round of four findings, all about evidence. The budget holds. The hidden work was changing a shared program's input
shape (`recordMessages`), which touched about 25 call sites. When a charter changes a signature that tests and callers
share, grep its call sites at plan time and name the count in the Size line ("rider: N call sites").
**CHN428** (`knowledge/specs/016-CHN428-form-submission-unit/RETRO.md`): 6 groups (1 matrix), 7 decisions + 5 planner rules,
no migration, no E2E, dormant. Cost ~222k / 60 calls (+523 code / +760 test lines, 5 files), one gate-fix round and one review
round of four evidence findings; every coder decision accepted. The budget holds. When a dormant cycle adds a file beside an
earlier dormant cycle's no-caller test, say so in Watch out: CHN424's substring guard failed the gate on a comment
(`writing-tests`, no-caller tests).
**CHN433** (`knowledge/specs/016-CHN433-forms-smoked1/RETRO.md`): a remote deploy plus a remote E2E, 5 groups (0 matrix), no
code change, no PR code. The coder's part was cheap; the E2E cost two runs because the sign-in hand-off (a 5-minute reset
link, a password the classifier would not let the agent read) was not planned, and one step failed on a charter claim
copied from a vendor's docs (the always-pass Turnstile secret "accepts only the dummy token"; it passes any token). When a
charter states how a third-party test fixture behaves, probe it once at plan time (one `curl`) or name it in Watch out as a
premise; and an E2E step that needs a human-in-the-loop secret names who supplies it and how, before the run.
**UI460** (`knowledge/specs/021-UI460-workspace-app-served/RETRO.md`): 6 groups (1 matrix), 8 decisions, no migration,
1 local E2E part, at the limit on two lines. Cost ~299k / 112+ calls over two runs (+773 code / +1,173 test lines, 56
files), one review fix round. Within budget, at the top of the range: the riders hid work. "The release layout" was ~80
lines over `stage`, `layout`, `check` and the fixtures, plus four test edits. A charter that adds a page or asset directory
to the tarball counts the release package as its own rider with a line count ("rider: release package, ~4 files"). A
charter that names a non-gate check (`release:check`, `smoke:worker`, an E2E script) says what `main` shows for it, since
both were red on `main` here (`writing-tests` §7, "Checks outside the gate rot unseen").
**UI468** (`knowledge/specs/026-UI468-accounts-settings/RETRO.md`): 6 groups (1 matrix), 4 decisions + 6 planner rules, no
migration, 1 local E2E part. ~272k / 107 calls over two runs (+725 code / +986 test lines, 18 files), one review fix round.
Within budget; the hidden part was an E2E seed the charter left to "the way the coder can do it faithfully". When an E2E's
initial state is something the UI cannot create (a connected mailbox), name the seed as a rider with its method ("rider:
E2E seed, `connectOperation` in-process via `getPlatformProxy`, imported from `../../api/src`") so the coder records it
up front. And when a charter states an operation's answer in a given Worker configuration, read the handler's check order
first: unconfigured `connections.sync` answers `501` before it reads the connection, so the charter's `409` needed a
second, configured Worker (468.15).
**UI459** cycle 1 (`knowledge/specs/026-UI459-workspace-agents/RETRO.md`): 6 groups (1 matrix), 8 decisions + 5 planner
rules, no migration, 1 local E2E part, at the limit on groups and decisions. ~793k over three coder runs (~253k / 112+
calls first, then ~263k and ~277k) (+461 code / +1,033 test lines, 30 files), two review fix rounds and one gate-fix
round. The first run was in range; the review rounds were layout. The charter added a slot to a shared layout component
(`ResourceList`'s `detail`) and said nothing about how it sits beside the row's actions or at 375 px. A charter that adds
content to a shared row or flex component states the layout at desktop and narrow width and counts it as an E2E part
with geometric assertions (`writing-tests` §7), not as a gallery rider. A charter that adds a value to an allow-list
names the grep for that literal in tests as a rider (`execute-cycle` §survey; `continuation.test.ts` cost the gate-fix).
**UI476** (`knowledge/specs/026-UI476-connect-switch/RETRO.md`): 5 groups (1 matrix), 1 spec decision + 7 planner rules,
no migration, 1 local E2E part (legs changed in an existing script), riders a page deletion (~20 files) and the release
package. 218k / 80 calls in one run (+71 code / +357 test lines, −2,373 deleted, 52 files), approved round 1. The budget
holds: a deletion rider costs little by itself, the matrix and its absence mutations carry the cycle. A charter that fixes
every answer of a route (status, `Location`, headers, which gates it runs before) leaves the coder only local choices.
**UI447** (`knowledge/specs/027-UI447-remove-preact-layer/RETRO.md`): 5 groups (1 matrix), 9 decisions (one over, taken
under the OPS92 mechanical-deletion exception), no migration, no E2E. ~138k / 37 calls in one run plus a 2-call prose
round (+14 code / +157 test lines, −1,708 deleted, 50 files), gate green first time. The exception held. The one round was
prose: a deletion's prose pass removed a skill lesson together with the mechanism that motivated it. When a charter deletes
a mechanism a skill paragraph cites, it says "keep the lesson, drop the reason, re-cite a surviving file" for that
paragraph. Proof that nothing shipped changed: hash the built `dist/assets` tree on `main` twice (determinism) and on the
branch.
**API503** (`knowledge/specs/029-API503-machine-endpoint-paths/RETRO.md`): a three-path rename, 6 groups (1 matrix),
8 decisions (at the limit), no migration, no E2E, five riders. ~164k / 68 calls over two runs (+56 code / +249 test
lines, 39 files), one review round. Within budget; a mechanical rename with a source-scan test is well under the
ceiling even at 8 decisions. The charter told the coder to "run `smoke:worker` on `main` first" and still wrote the
obligation as "green from the branch": `main` aborted, so the obligation was unmeetable (#505). The planner runs a named
non-gate check on `main` at plan time and writes the obligation against what it saw (green, or "same ok count as `main`
plus a restored bypass for the legs past the abort").
**UI507** (`knowledge/specs/030-UI507-app-pages-under-app/RETRO.md`, [[UI504]] cycle 2): 6 groups (1 matrix), 8 spec
decision halves + 5 planner rules, no migration, 1 local E2E part (edited legs), riders counted by `git grep` at plan time
(~62 files; 59 real). ~228k / 84 calls in one run plus a 2k / 4-call fix round (+118 code / +540 test lines, 59 files),
gate green first time. The budget holds for a path move cut by bundle: a rider counted with the grep, not estimated, was
accurate to 5%, and planner rules that fixed every answer under the new prefix (P4) left the coder harness choices only.
The one charter miss was an answer stated for the wrong phase: `release:check` runs on an uninitialised instance (`503`,
not `404`; `writing-tests`, smoke scripts).
**API514** cycle 1 (`knowledge/specs/031-API514-scope-messages-read-metadata/RETRO.md`): 5 groups (1 matrix: output path
× caller), 6 decisions, no migration, no E2E, dormant. +157 code / +428 test lines, 15 files. The gate passed first
time and review approved round 1 with no findings; coder cost was not measured. The budget holds for a 13-decision spec
split at plan time. One path was covered only after green: the keyset-sorted list decode, a second decode in the same file. A charter
that names "list" should say "both list decodes". Charter riders that guess at a golden's contents ("record schema optionality") or at an architecture's shape
("payload builder") are better phrased as "where it lands".
**API518** ([[API514]] cycle 2, `knowledge/specs/031-API518-scope-grammar-closure/RETRO.md`): 5 groups (1 matrix:
5 authentication paths × 3 closure cases), 2 decisions + 3 planner rules, no migration, no E2E, dormant. ~210k / 70
calls in one run (+61 code / +499 test lines, 19 files). The gate passed first time, and review approved round 1 with
no findings. The budget holds. The matrix and its per-path mutations were most of the cost, which is about 8 test
lines per production line.
**CORE315** (`knowledge/specs/020-CORE315-object-definitions/RETRO.md`): 6 groups (1 matrix), 8 decisions + 3 planner rules
(at the limit), no migration or E2E, but three sweep riders (every `COLUMN_KINDS` reader, every scope-policy reader, every
registry builder) and 12 absence mutations over three packages: ~400k / 137+ calls initial, two review rounds, one gate-fix.
About 1.7x CORE200's cost for the same counts. A sweep rider ("every reader of X", found by a grep) is real work: at the
limit on decisions, two or more sweeps mean split (here, scopes by rule could have been its own cycle). Two charter premises
were wrong (a proposable `d1Only` write, which `api-routes` forbids; a mutation assuming the rail executes approved
proposals): before naming an absence mutation, trace the code path that carries the behaviour, or name the behaviour
and let the coder choose the mutation.
**CORE543** (`knowledge/specs/020-CORE543-redeploy-extensions/RETRO.md`): 5 groups (1 matrix), 6 decisions + 8 planner
rules, no migration, 1 remote E2E part, riders listed. It cost 366k / 137 calls initial plus two small resumes (+895 /
+754 lines, 48 files), just past 543.1's ~350k line. The unnamed sweep was every bundler of the Worker (auth harness,
`smoke:worker`, three e2e scripts): a new module in the Worker's import graph is a sweep rider ("every bundler of
`worker.ts`", found by grepping `esbuild`/`build(`) and goes in the Size line. The one review finding was a cosmetic
carried item skipped without a row: every line under "In this cycle", "Carried" included, is scope; the coder does it
or records why not.
**CORE318** (`knowledge/specs/033-CORE318-property-bag/RETRO.md`): 6 groups (1 matrix), 8 decisions, 1 migration, no E2E,
at the limit on three lines, with goldens and "record-shape pins found by the suites going red" named as riders. It cost
218k / 93 calls in one run (+181 / +892 lines), gate green first time, review approved round 0. The budget holds at its
limit when no line hides a sweep; a field added to existing registry-derived surfaces is cheap. Naming the pin rider up
front kept the five pinned record shapes from becoming a gate round.
**CORE559** (`knowledge/specs/020-CORE559-extension-fields-served/RETRO.md`): 6 groups (1 matrix), 7 decisions + 8 planner
rules, no migration or E2E, one sweep rider ("every path that writes or emits an event of the four built-ins", ~6 files).
It cost ~354k / 133 calls initial plus a ~29k fix round (+549 / +1,238 lines, 37 files), past 559.1's ~300k line. The
sweep was 11 files, and it carried its own obligation (a named test and an absence mutation per path: 15 mutations), so it
was a group, not a rider. The grep (the definitions' importers, `eventStatement`) missed the capture pipeline, which reaches
contacts from a Workflow and webhooks through `recordMessages`; that gap was the review round. **Rule:** a sweep whose
proof is per path (a test or a mutation each) counts as a "Must be tested" group in the Size line, and its file count comes
from a grep that follows the callers of every function the swept value is passed to, including entry points outside the
registry (Workflows, queues, webhooks, ingress), written as a number, not an estimate.
**CORE561** (`knowledge/specs/020-CORE561-extension-fields-switched-on/RETRO.md`, the switch over [[CORE559]]'s dormant
seam): 5 groups (1 matrix), 6 decisions + 5 planner rules, no migration, 1 remote E2E part, riders counted by grep. ~188k
/ 59 calls in one run plus a ~4-call fix round (+179 / +388 lines, 21 files), gate green. The budget holds: "mechanism
dormant, then the switch" puts the sweep in the first cycle, and the switch is cheap even with a remote E2E.
**CORE556** (`knowledge/specs/020-CORE556-contact-merge-references/RETRO.md`, [[CORE315]] U3): 6 groups (1 matrix), 2
decisions + 6 planner rules, no migration, no E2E, split at plan time. ~257k / ~120 calls initial plus a free gate-fix
round and one review round (+~110 code / +~510 test lines, 21 files). The budget holds. Both extra rounds were charter
omissions. A cycle that changes any schema on contacts, companies, deals or tasks names the `wire-core554` snapshot as a
rider ("rider: re-pin the wire snapshot", `writing-tests` §goldens): a digest is not found by grepping the operation's
name. A cycle that lifts a refusal greps the docs for the sentence that states it (`packages/docs`) and names that line
under "In this cycle" (556.21).
**CORE574** (`knowledge/specs/034-CORE574-capture-integrity/RETRO.md`, [[CORE571]] cycle 2): 6 groups (1 matrix), 3
decisions + 5 planner rules, 1 migration, no E2E. 268k / 106 calls in one run plus a free 3-call gate-fix round (+323 /
+676 lines, 22 files), approved round 0. The budget holds. The calls went to restructuring four "already stored?" sites
into one rule, plus nine absence mutations. When a charter changes a dedup rule on a path that writes to a key derived
from the deduplicated id (R2 content at the external id), Watch out says the write happens before commit, and asks for
the decision to be re-taken right before it; CORE574's coder found that only through the (d) mutation. A cycle that adds
or removes a D1 query on an operation or the capture pipeline names `measured-limits.test.ts` as a rider.
**AGT588** cycle b (`knowledge/specs/035-AGT588-hostile-content-approval-card/RETRO.md`): 6 groups (1 matrix), 6
decisions + 1 planner rule, 1 migration, 1 E2E leg. ~257k / 118+ calls first run (+450 / +703 lines, 22 files), then a
free gate-fix round and two review rounds. The budget holds; the rounds were spec gaps, not size. A charter that adds a
field to a resource record names the wire snapshot as a rider (writing-tests §1). A charter (or spec) that has the
server read a stored value into a response for a caller who may hold only `request_approval` states the read scope each
value needs (api-routes, "Owner-granted resource authority"); AGT588 found the label and then the thread subject one
review round apart.
**CORE602** (`knowledge/specs/037-CORE602-filter-ranges/RETRO.md`): 6 groups (1 matrix), 8 decisions, no migration, no
E2E, split at plan time from a 10-decision spec. 207k / 87 calls over a build run and a free gate-fix round (+121 / +404
lines, 18 files), approved round 0. The budget holds. The gate-fix was a rider named wrong ("OpenAPI goldens"): a cycle
that changes a query parameter's schema names the wire snapshot, not the goldens, as its rider (writing-tests §1).
**DX603** cycle 1 (`knowledge/specs/038-DX603-typescript-sdk/RETRO.md`): 6 groups (1 matrix), 8 decisions, no migration,
no E2E, a new workspace package. ~380k / ~64 calls over a build run and one fix round (+701 / +606 lines, plus 14k
generated lines), approved round 1. Few calls, many tokens: ~650 KB of generated files and full-suite output filled the
context. The budget holds; when a cycle generates a large artifact, Watch out says "never read the generated files, quote
the drift test's first differing line". The fix round came from a spec example never checked against the document
(`messages.content` is JSON): an operation a charter names as an example of a response shape is checked in the
document first. From DX603 on, every operation-changing cycle has a rider: `pnpm -C packages/sdk generate` (api-routes).
**DX608** (`knowledge/specs/038-DX608-sdk-filters-pagination-proposals/RETRO.md`): 6 groups (1 matrix), 4 decisions + 6
planner rules, no migration, no E2E, the same package as DX603 cycle 1. 155k / 34 calls plus a ~7k test-only round
(+298 / +535 lines, 19 files), approved round 2. The Watch out "never read the generated files" cut the cost to about
40% of DX603 cycle 1's at the same Size line: keep it in every charter that regenerates a large artifact. Three gate
runs (two red on load-sensitive tests outside the cycle, #611) are not cycle cost.
**CORE207** (`knowledge/specs/041-CORE207-aggregate-group-by/RETRO.md`): 6 groups (1 matrix), 8 decisions, at the limit on
both, no migration or E2E. 179k / 53 calls in one run (+183 code / +531 test lines, +287 generated, 16 files), approved round
0. The budget holds: a new parameter on an operation already registry-derived on every surface is cheap even at the decision
limit. When a charter reduces a spec's scope clause ("needs no per-field scope"), grep the checks that exist first
(`checkContentScope`, `customFilters[].requires`): 207.12 said column filters carry no per-field scope, and [[API514]]
content fields are one (review 207.19, #618).
**DX616** (`knowledge/specs/042-DX616-sdk-aggregate/RETRO.md`): 6 groups (1 matrix), 7 decisions, no migration or E2E, a
new API extension plus generator and type work across `@vibase/api` and `@vibase/sdk`. ~176k / 53 calls first run, a
4-call fix round (+180 code / +480 test lines, +69 generated, 23 files), approved round 1. The budget holds; a type-heavy
matrix (positive and `@ts-expect-error` cases on two clients) costs test lines, not tokens. The one round was a spec type
narrowed without a decision row (execute-cycle §3).
**API622 cycle 1** (`knowledge/specs/044-API622-wildcard-origins-oauth-cors/RETRO.md`, split at plan time from a
10-decision spec): 4 groups (1 matrix), 6 decisions + 3 planner rules, no migration or E2E, three packages. 158k / 41
calls in one run (+106 code / +334 test lines, 21 files), approved round 0. A plan-time split on decisions alone gives a
cheap cycle; half a cycle is fine. Its grammar mutation ("drop the inner-`*` check") named a check the host regex made
redundant, so the mutation changed nothing: name the row that must turn red, not the line to delete.
**CORE627** (`knowledge/specs/045-CORE627-oauth-client-operations/RETRO.md`, [[CORE623]] cycle 2 of 3): 5 groups (1
matrix), 8 decisions + 5 planner rules, no migration, 1 local E2E part. 227k over three runs (initial 204k / 72 calls,
then a free gate-fix round and a free E2E-fix round; +581 / +980 lines, 25 files), with no code findings in review. The
budget holds. Both extra rounds were charter gaps. First, **every cycle that adds, removes or renames an operation, on any
surface, names the wire snapshot as a rider** (writing-tests §1): the meta operations moved three digests. Second, a rule
that admits several classes of value (https and loopback http redirects) needs one obligation per class carried through
the library that checks the value again (writing-tests §1). Group 5 ran only https, and the E2E found Better Auth refusing
loopback http.
**CORE628** (`knowledge/specs/045-CORE628-oauth-client-update-origin-warning/RETRO.md`, [[CORE623]] cycle 3 of 3): 5
groups (1 matrix), 7 decisions + 6 planner rules, no migration, 1 local E2E part, riders named (wire snapshot, SDK
generate, changeset). 161k / 43 calls in one run (+134 code / +490 test lines, +190 generated, 16 files), gate green
first run, E2E pass first run, approved round 0. Same Size line as CORE627 at about 70% of its tokens: the two CORE627
gaps (wire-snapshot rider, one library round trip per redirect class, both directions in workerd) were in the charter,
and each cost a free round when absent. A Watch out naming the existing assertions a new response field turns red
(exact-keys on the create answer) let the coder move them in the red commit instead of finding them in the gate.

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
| red run | new behaviour a test can see missing before the code exists. Not for a check of code that may already be right (a replay of new fixtures through existing parsers, a cost formula the code may already meet): ask for "red run, or an absence mutation if it is green on first run" ([[CHN153b]]: three such obligations had no red run). Behaviour a move must keep (the old code is the reference, so the test is green before the move) is never red: ask for the mutation that swaps in the new dependency's default (its own error words, its own wire shape) ([[DX609]] group 3). When the move puts calls on a library, state the wire rule in the library's terms (read its spec's decisions), not the old client's literal query ([[DX609]]: `status=<tab>` became the SDK's `status=eq.<tab>`) |
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
  org is refused, so the only fallback is a fresh local D1 ([[API6]] E2E). Check that each scope exists and is
  **agent-grantable** (`agentGrantable` in the scope policy): a human-only operation (`forms.create`, `forms:write`)
  cannot be a bootstrap agent's setup step, so the scenario names an owner path for it (in-process as the owner on
  local state, a signed-in session remotely). [[CHN432]]'s charter had the agent create the form (432.19).
- **Name the database as the script's own**: a local scenario runs on a fresh temp-dir state, never "the
  `.wrangler/state` of the worktree", which a coder read as licence to wipe the developer's dev database
  ([[CHN432]] review, 432.25). Before writing "temp dir", check the scenario's setup tools take one: `bootstrap` and
  `e2e/seed-connection.ts` open only the default state (#474), so a scenario built on them names "this cycle worktree's
  own fresh `.wrangler/state`" instead, as `writing-tests` §7's standing exception says ([[UI469]] chartered a temp dir
  the tools could not use, 469.9).
- **A budget in a charter or a review quotes its number and what it bounds** (JS or CSS, gzipped or raw). [[UI469]]'s
  review compared the app's JavaScript with [[UI443]] D6's 25 KB *CSS* budget and logged an overrun that did not exist
  (469.12, superseded by 469.13).
- **A migration over data seeds the old schema directly** (SQL against the database at the previous
  migration, or the previous build), never through the new Worker: since [[CORE61]] the new code answers
  `503 migrations_pending` until the database is current. List that `503` as an expected step.
- **An obligation that says "still" (a trigger, a constraint, a refusal kept) is checked against the migration
  that created it.** [[CHN140]]'s charter said a rebuild kept `UPDATE` *and* `DELETE` refused; `0004` only ever
  refused `UPDATE`, which cost a deviation. Open the original file before writing "still".
- **A cycle that changes an existing E2E script's expectation** (a step that flips) names that script for the
  tester too. [[API115]] flipped the connect E2E's MCP step without naming it, and review had to add the run as a
  pre-merge condition.
- **Deletes as the spec defines them:** for a soft delete, say "`deleted_at` set, row kept". Left unsaid,
  the tester asserted that cascaded edges were gone, against [[CORE62]] D15.
  An **undo built on a soft delete is not an exact inverse**: the rows it removes stay as tombstones. A
  "state equals the snapshot" obligation after an undo says "up to tombstones" (and that the removed row is
  soft-deleted, not gone), and the charter says what the forward operation's state check does on a re-run over
  those tombstones. [[OPS394]]'s charter said "exactly"; review amended it (394.16) and found that the same plan
  cannot be re-applied after a revert (394.17).
- **A refusal step is a full command line.** The tool validates its required flags before the check the step
  targets, so a refusal written as "`--clerk-env-file .env` refuses" is refused for a missing `--api-host`
  instead, and never reaches the key check ([[OPS87]] A4).
- **A step that asserts what a page shows a principal kind checks the app shell's admission first.** A shell-level
  guard decides what a role sees before any page rule does (`packages/server-d1/src/app/state.ts` refuses every
  non-person), so "the agent sees its own row on `/agents`" is a premise to test, not a step. [[UI479]]'s leg C was
  written from [[UI459]] D8 alone and cost a stop and a user ruling.
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
   (in a sprint: decide it in the spec, with a row in the decisions log) before the charter ships.
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
   **Write an E2E fixture in the format's own keys** (the JSON, or the declaration's words), never prose the
   format lacks: [[CORE561]]'s "text, nullable" named no key (a non-required field is nullable), and the tester
   had to guess.
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
   route. **A guard or file the obligation names must exist: one `git grep` before the charter ships.** OPS262's charter
   asked for an absence mutation of "`packages/release`'s forbidden list", which names no package (it scans for
   secrets); the coder had to find the real guards. When the grep finds nothing, name the property instead and let
   the coder find its guards (`knowledge/specs/015-OPS262-vibase-rename/RETRO.md`). **An obligation about the form of
   an input (case, whitespace, a `+tag`) goes to the layer that sees the raw input.** A pure function over normalised
   values cannot see case, and a stored state that a schema CHECK refuses cannot be seeded. Before asking for either,
   read the normaliser the caller runs first and the column's constraints. [[CHN414]] asked for `Support+eu@` (case)
   in a pure predicate matrix and for a mailbox stored in mixed case, which `identities_email_ascii_lower` refuses.
   The first cost a review round and the second a deviation (`knowledge/specs/015-CHN414-sender-filters/RETRO.md`).
9. **A charter revised mid-cycle names the stop point and what survives.** When a design decision changes while the
   coder is working, the coder stops at a commit, and the planner revises the spec (changelog and decisions log) and the
   charter in place, never in a second plan file. The revised charter opens with a **Revised** block. That block
   names the sha the coder stopped at and sorts the work into **Stays as built** (with the red runs and mutations
   that still count), **Reworked** (whose existing tests must be seen red again against the new source) and **New**.
   Re-check the Size line, and split out whatever no longer fits. Expect the resumed run to cost about as much as a
   fresh one: in [[OPS237]] the continuation took 210k tokens against the initial run's 140k. Give any fixture the
   revision introduces the same "what moves it" check (`writing-tests` §4); OPS237's only review finding came from
   one (`knowledge/specs/014-OPS237-release-ci-docs/RETRO.md`).
