---
name: tdd-cycle-generator
description: Generate a complete TDD cycle from a spec file. Creates a new cycle folder under knowledge/product/specs/ with a PLAN.md targeting one cycle of work. Use when starting any implementation cycle — the first cycle of a new spec, or a follow-on cycle for an existing one.
---

# TDD Cycle Generator

Generate a complete TDD cycle plan from a spec note (`<ID>.md`). The generated PLAN.md follows the 3-phase Red/Red/Green TDD pattern.

Each TDD cycle is **one folder**. If a spec is implemented across several cycles, each cycle gets its own folder with its own ID, plan, and retro. The spec lives in the folder where it was first authored; later cycles reference it via `implements: "[[<spec-ID>]]"`. See the spec-author skill §1.5 for the full convention.

**Usage:** `/tdd-cycle-generator knowledge/product/specs/<seq>-<ID>-<slug>/<ID>.md`

---

## Workflow

### Step 1: Read and Parse the Spec

First sync the product repo so you read the current spec. `knowledge/product/` is its own git repo (`zooid-ai/product`), and a stale local `main` can hide a changed scope, a shipped status, or an existing RETRO.md:

```bash
git -C knowledge/product pull --rebase
```

Read the spec note (`<ID>.md`) at `$1`. Extract:
- Title, spec ID, and goal
- All section headings (H2, H3)
- Key requirements, interfaces, and acceptance criteria
- Any referenced specs (by ID), packages, or external APIs
- The current `**Implementation cycles:**` block (if present) — it tells you what's already been planned and what scope is still unclaimed

### Step 2: Decide Cycle Shape and Scope

This step has two questions, asked together via `AskUserQuestion`:

1. **Cycle shape** — Is this:
   - **First cycle (spec-introducing).** PLAN.md will live in the same folder as the spec. Use this only when no PLAN.md exists in that folder yet.
   - **Follow-on cycle (plan-only cycle).** The plan is the new folder's owning note `<new-ID>.md` (named by its own ID, so `[[<new-ID>]]` resolves by filename); it references the spec via `implements: "[[<spec-ID>]]"`.

   If a PLAN.md already exists in the spec's folder, the answer is always *follow-on cycle* — never overwrite an existing plan.

2. **Scope** — Present the spec's sections/headings, marking which are already claimed by prior cycles (per the **Implementation cycles** block). Ask which sections this cycle covers. Sections not selected stay open for a later cycle.

3. **Short name** — A kebab-case name for the cycle. Use a name that describes *this cycle's scope*, not the spec at large (e.g. `matrix-transport-bootstrap`, `observability-bridge`). For follow-on cycles this becomes the new folder's slug.

### Step 3: Resolve the New Cycle's Identity (follow-on cycles only)

Skip if this is the first cycle.

For a follow-on cycle, determine:

- **New ID** — pick the next free ID in the spec's area (e.g., next `ZOD###`). Look at `knowledge/product/specs/` and `epics-legacy/` to find the largest existing ID for that area; add one. **Never** suffix the spec's ID (`ZOD036b` is wrong; `ZOD037` is right).
- **Seq prefix** — same seq as the spec-introducing cycle if shipping in the same window (sharing a seq prefix is allowed and recommended for cycles of one spec). Otherwise pick the seq that places this cycle adjacent to its predecessor in implementation order.
- **Folder path** — `knowledge/product/specs/<seq>-<new-ID>-<slug>/`.

### Step 4: Confirm Output Path

Show the user the resolved folder path and confirm before generating:

- **First cycle:** `knowledge/product/specs/<existing-seq>-<spec-ID>-<existing-slug>/PLAN.md` (a support file alongside the spec's `<spec-ID>.md`)
- **Follow-on cycle:** `knowledge/product/specs/<seq>-<new-ID>-<slug>/<new-ID>.md` (the plan-only owning note; the folder is created in this step)

### Step 5: Fetch External Docs (if needed)

If the spec integrates with an external service or protocol (Matrix AS API, Slack Events API, Claude Agent SDK, etc.), fetch the relevant documentation **before** writing the plan. Invented API shapes cause entire phases to be wrong.

### Step 6: Survey the Code

Before writing the plan, read the code the cycle will touch: the modules it changes or calls, their existing tests, and the shared test helpers and factories those tests use. Look for helpers to reuse, the seam to test at, and the context components need to render (router, sidebar, tooltip providers).

Record what you read in the plan's **Code map**: each entry is a `path:line` plus the current signature, copied from the file rather than recalled. Every existing name the plan's tests or implementation steps rely on must appear there. A plan with no citations was written from the spec alone, and its tests will call helpers that don't exist.

### Step 7: Generate PLAN.md

Create the plan note at the path confirmed in Step 4 — `PLAN.md` for a first cycle (a support file beside the spec's `<spec-ID>.md`), or `<new-ID>.md` for a follow-on (plan-only) cycle. The structure differs slightly between first-cycle and follow-on cycles — they have different headers — but the body is the same.

**First-cycle header:** (`id` is the spec's own ID, since plan and spec share the folder)

```markdown
---
id: <spec-ID>
type: plan
order: <seq>
title: "{Title} - TDD Cycle"
implements: "[[<spec-ID>]]"
---

# {Title} - TDD Cycle

**Goal:** {extracted from spec}
**Spec:** [[<spec-ID>]]
**Scope:** {user-defined scope summary}
```

**Follow-on cycle header:** (`id` is this plan-only cycle's own new ID; `implements` links the spec)

```markdown
---
id: <new-ID>
type: plan
order: <seq>
title: "{Cycle title}"
aliases: [<new-ID>, "{Cycle title}"]
status: draft
implements: "[[<spec-ID>]]"
---

# {Cycle title}

**Spec path:** [[<spec-ID>]]
**Goal:** {one-line, scoped to this cycle}
**Scope:** {sections of the spec this cycle covers; sections explicitly deferred go in Out of scope below}
```

**Body (both shapes share this):**

```markdown

---

## Code map
{Existing code this cycle builds on, from Step 6's survey. One entry per type,
function, helper or component, with `path:line` and the current signature copied
from the file. Note context requirements alongside. For plan-only cycles, first
name the prior cycle(s) assumed merged.}

**Source**
- `{path}:{line}` — `{signature}`

**Test helpers**
- `{path}:{line}` — `{signature}` {e.g. `packages/web/test/factories.ts:41` — `makeRoom({ client, myUserId, roomId? }): Room`}
- {Context requirements, e.g. "`RoomInfoDialog` calls `useNavigate()`; tests need `<MemoryRouter>`"}
- {Test environment if non-default: vitest environment, setup files, MSW}

## Phase 0: Branch

Create a feature branch. The cycles live in the top-level `z` repo; code changes
happen in the relevant sub-repo (`budd/` or `zoon/`, each with their own `.git`).

```bash
cd {code-git-root}   # e.g., /Users/ori/Code/z/zooid
git checkout -b feat/{cycle-short-name}
```

All code changes happen on this branch.

## Contracts
{Shapes this cycle adds or changes, which the tests pin exactly: wire/event
payloads, error strings, interface and function signatures, config schema.
Existing shapes stay in the Code map; for a changed one, show before (copied
from the Code map entry) and after.}

## Phase 1: Red (Unit Tests)

### Step 1.0: Verify Against the Tree
Before writing any test, check each Code map entry against the tree: open the
cited file, confirm the signature and context requirements still hold, and look
for anything the map missed. Where the tree disagrees with this plan, the tree
wins; note the difference in the retro.

### Step 1.1: {test file path}
{One line on what this file covers, then a test-case table:}

| Test | Given | When | Then |
|------|-------|------|------|
| {name} | {setup} | {action} | {observable outcome, exact where a Contract applies} |

{Rows describe behavior only; refer to existing code by its Code map name, without repeating locations.}

**Isolation:** {how the boundary is stubbed, naming the Code map helpers used, e.g. `makeFakeClient` + `injectClientForTest`, an MSW handler, a spawned stub}

### Step 1.2: Run Tests (Expect Failures)
{Exact command. Each test must fail because the behavior is missing, not
because of an import error, missing provider or wrong factory call.}

## Phase 2: Red (Integration Tests)

### Step 2.1: {integration test file path}
{Test-case table and isolation strategy, as in Step 1.1}

### Step 2.2: Run Integration Tests (Expect Failures)
{Exact command}

## Phase 3: Green (Implementation)
{Step-by-step implementation to make all tests pass}

### Step 3.1: {First implementation step}
{Files to create or change, key functions and their signatures, the approach
and why. Snippets only for non-obvious logic, not full files.}

...

### Step 3.N: Run Tests
{Commands to run all tests — expect them to pass}

---

## Phase 4: Verify

**IMPORTANT: You MUST actually run all tests. Do NOT skip. Do NOT assume pass.**

### Step 4.1: Run All Tests
```bash
cd {package-path} && pnpm test
```

Fix any failures before proceeding.

### Step 4.2: Type Check
```bash
cd {package-path} && pnpm typecheck
```

### Step 4.3: Build (if applicable)
```bash
pnpm -C {package-path} build
```

### Step 4.4: Stories + visual verification — UI changes only ({zooid-clients/packages/web})

**Include this step only when the cycle changes the Zooid web UI** (anything rendered under `zooid-clients/packages/web` — new components, event rendering, composer/dropdown, styles). Tests assert DOM structure; they do NOT prove the change renders correctly, reads right, or mounts without a runtime/CSS error. Verification is two layers:

**a. Write stories for the visual state matrix — leaf AND scene.**

- **Leaf stories** — each new/changed presentational component gets a `*.stories.tsx` beside it, fed fixture props, covering the states that matter (not just the happy path: empty, mixed, error/failed, long/overflow, edge cases named in the spec's non-goals).
- **Scene story** — when the component is a **timeline surface** (plan board, diff card, tool-call card, anything that renders inside the chat), also story the real connected `TimelinePanel` against a **fixture-seeded fake Matrix client** so its placement *in the timeline* (order, spacing, alongside other tiles) is verified, not just the component in a vacuum. Reuse the unit-test harness — `makeFakeClient`/`makeRoom`/`pushTimelineEvent`/`mkMatrixEvent` from `packages/web/test/factories.ts` + `MatrixClientPeg.injectClientForTest()` in a decorator (see `timeline-panel.test.tsx`). This is why a presentational split is **optional, not required**: peg-injection renders connected components in context directly. Split out a `…View` only when it buys cleaner leaf-state coverage.

The PLAN must list the stories to write (leaf + scene) and the states each covers.

**b. Verify the stories visually with `/verify-web`.** It drives Storybook (:6006), opens each story, and screenshots it. In the PLAN, for each story:

```
/verify-web {Component} {state, e.g. "PlanBoard mixed statuses"}
```

1. **Expected outcome first.** State what "correct" looks like before screenshotting (e.g. "three rows, first struck through with an emerald dot, an amber pulsing dot on the in-progress row, 1/3 in the header") — then confirm/deny.
2. **Both themes.** Check `&globals=theme:dark` and light — status/diff colors use `dark:` variants.
3. **Transient/interactive states** (hover, open dropdown, expanded card, spinner) — drive them with `agent-browser` or bake an interaction into a story `play` function.
4. **Read the console.** Treat React warnings/errors as failures.

**Out of scope for the cycle: the full-app seeded smoke test.** Confirming the component looks right in the *real running app* with real agent activity (the grocery-list prompt → live plan + diffs) is a **manual step the user runs after** stories pass — do not script a live agent turn in the PLAN. The cycle's job is correct, story-verified components; the user does the end-to-end smoke.

---

## Phase 5: Commit, Push & PR

Commit on the feature branch, push it, and open a PR. Opening a PR is the
hand-back point; the user reviews and merges, never the implementer:
```bash
cd {code-git-root}
git add -A
git commit -m "feat({package}): {short description}"
git push -u origin feat/{cycle-short-name}
gh pr create --fill
```

The retro is not part of this phase. The plan's author writes `RETRO.md` into
*this* cycle's folder (via `/retrospect`, never with a `-NN` suffix) after the
PR's review fixes land, so it describes what actually merged. For follow-on
cycles, the same pass sets this cycle's status to `shipped` in the spec's
**Implementation cycles** block.

---

## Verification Commands
{All test/typecheck/build commands in one copy-pasteable block}

---

## Completion Checklist
- [ ] All unit tests executed and passing
- [ ] All integration tests executed and passing
- [ ] TypeScript compiles without errors
- [ ] Build succeeds (if applicable)
- [ ] Manual smoke test (if applicable)
- [ ] Stories written for new/changed presentational components (state matrix) and verified via `/verify-web`; console clean (UI changes only)
- [ ] Committed, pushed, PR opened

Output `<promise>LOOP_COMPLETE</promise>` when all phases done.
```

### Step 8: Commit and Push the Plan

Once you've written the plan, commit it straight to `main` in the product repo and push it. Don't open a PR. Plans are pushed when they're written so that whoever implements the cycle builds from the same plan, and so the retro can cite it. Follow-on cycles also include the spec's updated **Implementation cycles** block:

```bash
cd knowledge/product
git pull --rebase
git add specs/<seq>-<ID>-<slug>/
git commit -m "docs(specs): <ID> cycle <n> plan — <short scope>"
git push
```

If the push is rejected, run `git pull --rebase` and push again. Writing and pushing the plan is where this skill ends. Implementation is a separate step, so don't start it unless asked.

---

## PLAN.md Quality Rules

1. **Complete test cases, not complete test code** — Every test step lists its cases (given/when/then) precisely enough that two implementers would write equivalent tests. Don't say "write a test that does X"; name each case and its expected outcome. Don't paste full test or implementation files either: the plan is written before anyone checks the tree, and pasted code drifts (invented helpers, wrong factory signatures, missing providers). The implementer writes the code in Step 1.0's light. Every rule a test enforces must also be stated in prose or in **Contracts**, never only in an assertion.
2. **File paths from package root** — e.g., `packages/transport-matrix/src/index.ts`.
3. **Correct test commands** — `pnpm test` or `pnpm vitest run <file>`. Never `npx vitest`.
4. **No speculative deps** — Prefer existing deps and Node builtins. If a new dep is required, add it in a dedicated step.
5. **Fetch external API docs** before writing any plan that calls a third-party API. Invented endpoint shapes invalidate entire phases.
6. **Follow existing specs** — If another spec describes an approach, reference and follow it. Don't reinvent.
7. **One cycle, one folder** — A PLAN.md is the only plan in its folder. Never create `PLAN-02.md` / `PLAN-03.md` siblings; subsequent cycles are *new cycle folders* with their own ID and slug. See spec-author skill §1.5.
8. **Plan-only cycles open their Code map by naming the cycle(s) they build on** — e.g., "Assumes `JsonlSink` and `wireAgentCapture` from [[ZOD036]] are merged." This makes the cycle's branching strategy and merge order obvious.
9. **UI cycles ship stories + a `/verify-web` step** — any cycle touching `zooid-clients/packages/web` rendering MUST include Phase 4's Step 4.4: a `*.stories.tsx` per new/changed presentational component covering the state matrix (empty/mixed/error/edge), then `/verify-web` to screenshot them. Green Testing-Library tests prove DOM structure, not that the change renders, reads right, or mounts without a runtime/CSS error — stories + visual review close that gap. Prefer presentational (prop-fed) components so they can be storied; split a pure `…View` out of hook-bound components. The full-app seeded smoke is the **user's** manual step, not the cycle's. Omit Step 4.4 for non-UI cycles.

---

## Embedded Conventions

Always embed the relevant conventions in the PLAN.md based on what the spec involves.

### If working in budd (`/Users/ori/Code/z/zooid`):

**Repo structure:**
- `packages/core/` — SessionRunner, config, types, Transport + AgentAdapter interfaces
- `packages/adapter-claude/` — Claude Code adapter
- `packages/adapter-codex/` — Codex adapter
- `packages/runtime-local/` — host-process runtime
- `packages/runtime-docker/` — container runtime
- `packages/transport-http/` — Hono server, SSE, bearer auth
- `packages/transport-slack/` — Slack Events API (planned)
- `packages/transport-matrix/` — Matrix Application Service (planned)
- `packages/transport-context-mcp/` — MCP server + TransportContextProvider interface
- `packages/middleware-core/` — middleware chain interfaces

**Tech stack:**
- TypeScript ESM, pnpm workspace
- Vitest for tests (colocated `*.test.ts`)
- Hono for HTTP (transport-http)
- matrix-js-sdk for Matrix transport
- Bidrectional stdio (JSON-RPC) for agent communication (epic BUD019)

**Agent server protocol (budd agent server, from BUD019):**
```
→ session/start  { prompt, model, cwd, sessionId? }
← turn/started
← message/delta  { text }
← approval_request { id, description, command?, filePath? }
→ approval/respond { id, approved }
← turn/completed { sessionId }
```

**Transport interface (from core):**
```typescript
interface Transport {
  start(): Promise<void>
  stop(): Promise<void>
  onMessage(handler: MessageHandler): void
  send(target: string, message: OutboundMessage): Promise<void>
}

interface TransportContextProvider {
  getThreadHistory(threadRef: ThreadRef, opts: HistoryOptions): Promise<Message[]>
  getChannelMembers(threadRef: ThreadRef): Promise<Member[]>
  getChannelInfo(threadRef: ThreadRef): Promise<ChannelInfo>
}
```

**Test commands:**
```bash
pnpm -C packages/{pkg} test
pnpm -C packages/{pkg} typecheck
pnpm -r test   # all packages
```

### If working in zooid-clients (`/Users/ori/Code/z/zooid-clients`):

This is the **Zooid web client** (`@zooid/web`) — its own git repo (`git checkout -b` happens at `/Users/ori/Code/z/zooid-clients`) and its own pnpm workspace + lockfile. Never run `pnpm install` at the `z` root; install/test per child.

**Repo structure:**
- Single package: `packages/web/` (`@zooid/web`) — React + Vite client on `matrix-js-sdk`.
- `packages/web/src/components/structures/` — page/structure components; `components/ui/` — shadcn-style primitives (`Tabs`, `Badge`, `Input`, `Button`, `command.tsx` (cmdk), `dialog.tsx`, etc.); `components/dialogs/` — modals.
- `packages/web/src/hooks/` — colocated hooks (`use-*.ts`, tests `*.test.tsx` beside them).
- `packages/web/src/client/` — `peg.ts` (`MatrixClientPeg`: `safeGet()`/`get()`/`injectClientForTest()`/`reset()`), `runtime-config.ts` (`loadRuntimeConfig()` over `/config.json`), storage.
- `packages/web/test/factories.ts` — `makeFakeClient`, `makeRoom`, `pushTimelineEvent`, `makeMatrixEvent`, `injectStateEvent`. `packages/web/test/setup.ts` — MSW (`mswServer`, `onUnhandledRequest: "error"`).
- Routing: `react-router-dom@^6` (`useNavigate`, `useLocation`, `useOutletContext`); routes in `src/app.tsx` under a `<LoggedInView>` layout that provides `LoggedInOutletContext { spaceId }`.

**Tech stack:**
- TypeScript ESM, pnpm workspace, Node ≥22.
- React + Vite for UI (NOT SvelteKit). Tailwind v4, Radix, shadcn-style components.
- `matrix-js-sdk` (^34) for the Matrix client.
- **Vitest** + `@testing-library/react` (`render`, `renderHook`, `act`, `screen`, `waitFor`), `environment: "happy-dom"`, `setupFiles: ["./test/setup.ts"]`, alias `@ → src`. MSW for HTTP.

**Test pattern:** `const client = makeFakeClient({ userId }); (client as unknown as Record<string, unknown>).someMethod = vi.fn(...); MatrixClientPeg.injectClientForTest(client);` then `renderHook`/`render` (wrap routed components in `<MemoryRouter initialEntries={[…]}>` + `<Routes>`, assert navigation via a `Probe` reading `useLocation().pathname`). `afterEach(() => MatrixClientPeg.reset())`.

**Commands** (from `/Users/ori/Code/z/zooid-clients`):
```bash
pnpm -C packages/web test          # vitest run
pnpm -C packages/web typecheck     # tsc --noEmit
pnpm -C packages/web build         # tsc --noEmit && vite build
pnpm -C packages/web exec vitest run <file>   # single file
```

**Matrix / client conventions:**
- Talks directly to a homeserver via `matrix-js-sdk` — no daemon required to log in or chat. Homeserver URL resolves from runtime `config.json` (`homeserver_url`) over build-time `VITE_MATRIX_HOMESERVER_URL`; add new flags with the same precedence (e.g. `global_search` / `VITE_GLOBAL_SEARCH`).
- Custom agent-UX event namespace: **`dev.zooid.*`** (approval cards, agent status, structured output, shared workspace state).
- UI terminology is Matrix-native: **space** + **room** (not "channel"/"workspace"). A daemon-provisioned **workforce space** (`VITE_WORKFORCE_SPACE`) is auto-joined at login; `SpaceSwitcher` is already multi-space.
- Under-typed `MatrixClient` methods (`publicRooms`, `getRoomHierarchy`, `getRoomIdForAlias`, `joinRoom`, `searchMessageText`) are reached via a typed `client/client-ext.ts` accessor rather than scattered `as unknown as` casts.

> Note: the hosted multi-tenant platform (tuwunel deploy config, AS-token provisioning, `@{agent}.{org}:zoon.eco`, org=Space, `matrix.zoon.eco`) lives in **`zoon-cloud/`**, not here. If a cycle targets that, use the zoon-cloud conventions, not the web-client ones above.

### General naming (always embed):
- Files & folders: **kebab-case**
- Functions & variables: **camelCase**
- Types & interfaces: **PascalCase**
- Database fields & API responses: **snake_case**
- Environment variables: **UPPER_SNAKE_CASE**

---

## Lessons from Past Cycles

1. **Fetch external API docs before writing.** Matrix AS API, Slack Events API, Claude Agent SDK — any plan that invents endpoint shapes or event formats will be wrong. Check first.

2. **Test strategy must be explicit.** If a service calls another via HTTP or spawns a subprocess, specify exactly how tests isolate that boundary. "Mock it" is not a strategy.

3. **Specify the approval routing path end-to-end.** The approval_request/response flow crosses process boundaries (agent → runner → transport → room → user → transport → runner → agent). Map every hop in the plan.

4. **Matrix AS registration is per-homeserver.** The AS token is configured in the tuwunel server config, not in the Matrix client. Plans that confuse client auth with AS auth will fail at integration.

5. **Bot users are registered lazily on first @mention.** The AS namespace claim is static; individual bot users are registered on demand via the CS API under the AS token.

6. **JSON-RPC over stdio is line-delimited.** Each message is one `\n`-terminated JSON line. The plan must specify framing — partial lines and multi-line payloads are bugs.

7. **Mid-turn approval blocks the session runner.** The runner holds a `Map<request_id, Promise>` and must not timeout or drop the subprocess. The plan must address what happens if the human never responds.

8. **Follow existing specs before inventing flows.** If a spec already describes the approach, the plan should reference it using wikilink notation (`[[BUD019]]`) and follow it.

9. **Passing UI tests are not a verified UI.** Testing-Library asserts DOM structure (a class, an `aria-label`, a `role`) — not that the component mounts, looks right, or is free of runtime/CSS errors. For any `zooid-clients/packages/web` change, the cycle isn't done until its components have **stories** covering their state matrix and `/verify-web` has screenshotted them in Storybook (light + dark). Stories are fed fixture props, which sidesteps the seeding problem entirely — agent surfaces (plan board, diffs, tool cards) render nothing on a fresh app login, but a story just passes them a `plan`/`diff`/`status` prop. This is why presentational (prop-fed) components win: story-able and unit-testable. The full-app run with a real agent (grocery-list prompt → live plan + diffs) is the **user's** manual smoke after the component checks out — not something the cycle scripts.

10. **Plan code drifts from the tree.** Retros repeatedly record plan test code that called invented helpers (`injectCredentialsForTest`), old signatures (`loadZooidConfig({ source })`, `makeRoom` without `client`), or rendered components without the router/sidebar providers they need. Hence test-case tables plus Step 1.0 instead of pasted code: the implementer reads the real factories before writing tests.
