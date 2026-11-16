---
name: wiki-lint
description: Health-check the repo's knowledge layer — AGENTS.md, .agents/skills/, and the nested knowledge/ repo (specs, architecture, project-state) — for dead paths, contradictions, stale spec statuses, seq-prefixed spec references, shipped-but-unrecorded specs, broken wiki-links, a sprint that should have been closed, and an AGENTS.md that has grown past its size budget. Run periodically, after a burst of shipped cycles, or when something in the knowledge layer smells stale. Reports findings ranked by severity; fixes only the mechanical ones.
---

# Wiki Lint

`AGENTS.md`, the skills and `knowledge/` are the repo's **maintained knowledge layer**, synthesized from raw
sources (retros, migrations, git history). [[retrospect]] keeps it current at write time; this skill is the
read-time audit. It catches what ingest missed, what code changes silently invalidated, and what
contradicts what.

**Usage:** `/wiki-lint` (whole layer) or `/wiki-lint <path>` (one file or section)

Run from the code repo root. `knowledge/` is a nested git repo, so edits there commit separately
(`git -C knowledge`).

---

## The checks

Each is independent; run them all for a full lint.

### 1. Dead paths

Every file or directory path mentioned in `AGENTS.md`, the skills and `knowledge/*.md` must exist.

```bash
grep -rhoE '(packages|knowledge|scripts|\.agents)/[A-Za-z0-9_./-]+' AGENTS.md .agents knowledge --include='*.md' \
  | sed 's/[).,:;`]*$//' | grep -v '[{<*]' | grep -E '(\.[a-z]+$|/$)' | sort -u \
  | while read -r p; do [ -e "$p" ] || echo "MISSING: $p"; done
```

Template placeholders (`packages/{pkg}`, `knowledge/specs/<seq>-<ID>-<slug>`) are excluded by the `[{<*]`
filter. A path quoted *as an anti-pattern example* (spec-author's "don't reference
`knowledge/specs/004-AGT19-agent-scopes`") is a false positive; read the sentence before flagging. For each
real miss, decide: moved or renamed (fix the reference), or is the whole claim stale (rewrite the passage)?

Paths under `packages/` will legitimately be missing early on: the repo is pre-code, and skills describe
conventions that the first CORE cycles introduce. Report those as **not yet built**, not as errors, once
per path.

### 2. Contradictions between knowledge sources

The same fact stated in two places must agree. Compare `AGENTS.md`, `knowledge/architecture.md` and the
skills on the load-bearing claims:

- tenancy axis (organisation, never user) and which wrappers are mandated
- the test pool is production-like (nothing preset) vs. any skill that presets tenancy
- LLM SDK (Vercel AI SDK only)
- owner-granted resource authority ([[AGT8]], 2026-11-05): write includes request_approval; read is independent; users or agents with target write can review; direct and reviewed sends share the vault execution rail (planned, not yet implemented)
- one operation registry feeds REST and MCP (no second surface hand-written)
- test stacks and commands per package
- the spec ID scheme (area code + issue number) and the area code list

For each claim, grep across all sources and read the hits side by side. Where they disagree, **code wins**
once code exists; before that, `knowledge/architecture.md` is the authority. Fix every non-conforming
statement.

### 3. Spec `status:` vs. retro evidence

A spec whose listed cycles all have a `RETRO.md` should not say `draft` or `approved`.

```bash
# zsh-safe: `status` is a read-only zsh variable; use `st`
for dir in knowledge/specs/*/; do
  f=$(find "$dir" -maxdepth 1 -name '*.md' ! -name PLAN.md ! -name RETRO.md ! -name HANDOFF.md | head -1)
  [ -z "$f" ] && continue
  st=$(grep -m1 '^status:' "$f" | sed 's/status: *//')
  [ -f "$dir/RETRO.md" ] && case "$st" in draft|approved) echo "STALE: $f says '$st' but has a RETRO";; esac
done
```

Flag; don't blindly flip. A spec can have a retro'd first cycle covering only part of its scope (`shipping`,
not `shipped`); read the **Implementation cycles** block before changing the frontmatter, and add a
changelog entry with any change. Also check every `superseded_by:` target exists and is itself not
`dropped`.

### 4. Seq-prefixed spec references outside `knowledge/specs/`

Specs are referenced by stable ID (`CORE12`), never by seq-prefixed folder name (`004-CORE12`); seqs are
reassignable.

```bash
grep -rnE '\b[0-9]{3}-(CORE|API|CHN|AGT|UI|DX|OPS)[0-9]+' AGENTS.md .agents knowledge/*.md knowledge/discussions \
  | grep -v 'knowledge/specs/[0-9]'   # literal full paths are check 1's job
```

Every hit: replace with the bare ID (and verify the claim still holds while you are there).

### 5. Shipped-but-unrecorded specs

A spec with a `RETRO.md` should have a line in `knowledge/project-state.md`'s `## Completed specs`.

```bash
for dir in knowledge/specs/*/; do
  [ -f "$dir/RETRO.md" ] || continue
  id=$(basename "$dir" | sed -E 's/^[0-9]+-([A-Z]+[0-9]+)-.*/\1/')
  grep -q "\[$id\]" knowledge/project-state.md || echo "UNRECORDED: $id has a retro but no project-state line"
done
```

Report the list; each needs a one-line summary drawn from the retro. If a spec changed a stated principle
or data shape, also check `knowledge/architecture.md` still says so.

### 6. Broken wiki-links

Stable-ID wiki-links must resolve to a file named `<target>.md` under `knowledge/specs/`:

```bash
grep -rhoE '\[\[(CORE|API|CHN|AGT|UI|DX|OPS)[0-9]+\]\]' knowledge .agents AGENTS.md 2>/dev/null \
  | sort -u | sed 's/\[\[\(.*\)\]\]/\1/' \
  | while read -r t; do find knowledge/specs -name "$t.md" | grep -q . || echo "DANGLING: [[$t]]"; done
```

A dangling link to a bare spec ID can be a **reserved ID**, deliberately allocated for a spec not yet
written. Check how the referencing text describes it; reserved IDs are fine to leave dangling, since the
link marks a spec worth writing. Examples in skills (`[[CORE12]]` in a convention description) are false
positives.

### 7. Skill-list drift

The skill tables in `AGENTS.md` ("Workflow (skills)" and "Domain skills") and `knowledge/skills-inventory.md`
must match `ls .agents/skills/`. A skill that exists but isn't listed won't get read; a listed skill that
doesn't exist misleads.

### 8. Milestones and the sprint

A sprint is one milestone ([[sprint-planning]]). Check `knowledge/milestones/` and `knowledge/SPRINT.md`
against each other and against the specs:

- every ranked folder is `<seq>-<letter>-<slug>/` holding `milestone-<letter>.md` whose `id` is that letter;
  no letter appears twice (ranked or under `done/`), and no two ranked folders share a seq;
- at most one note has `status: active` or `paused`. `SPRINT.md` exists exactly when one does, and its header
  names that milestone;
- a note whose Needed rows are all ✅ but which is still `active` was never closed
  (`/sprint-planning close`); a `done` note still in a ranked folder was never moved; a `rank: proposed` note
  is an open question for the user;
- a State cell that disagrees with the spec's real `status:` is a stale checkpoint;
- a milestone referred to by its seq-prefixed folder anywhere (use `[[milestone-G]]`);
- `SPRINT.md` repeating a milestone's table, a ranking, or holding a "Next sprint" section;
- each ranked note's `github_milestone` exists in `gh api repos/benocodes/crm/milestones` with the title
  `<letter>: <title>`, and the open issues its Needed table names carry it.

Run `node scripts/decisions.mjs status` too: a `SPRINT.md` over its line budget, or an `OVERDUE` sprint that
was not cut, is a finding. Report these; don't close, re-rank or cut anything here.

### 9. Board and skill drift

The `board` skill holds the project board's IDs. If a skill hard-codes a board ID, option ID or field name
that disagrees with it, report it. If `gh project field-list` (see the `board` skill) no longer matches the file,
the IDs have rotted: re-derive them.

### 10. Size and accretion

`AGENTS.md` is loaded into every agent session, so every word in it is paid for on every run. Agents add
clauses and rarely remove one; this check is the counterweight.

```bash
wc -w AGENTS.md                                           # budget: 4,000 words
awk '{ if (NF > 120) print "LONG: line " NR " (" NF " words)" }' AGENTS.md
grep -nE '\*\*(Extended|Exception|Standing exception)[^*]*\((user, )?20[0-9]{2}-' AGENTS.md
```

- **Over the budget:** move detail to the skill that owns the topic and leave the rule plus a pointer. The
  precedents (#332): invariant 5's list of event-less writes lives in `api-routes`, the release and
  remote commands in `ship-branch`, the E2E scripts in `writing-tests`. Raise the budget only when the user
  says so.
- **A line over 120 words** is a list that grew inside a sentence. Turn it into a table or bullets, in the
  skill if it is detail.
- **Dated rulings appended to a rule** (`**Extended (user, <date>)**` and the like): a rule is stated once, as
  it stands today, with its ruling dates in one closing line. Merge the chain into one statement. Environment
  permissions go in `AGENTS.md`'s "Environments" section and nowhere else.

Consolidating changes wording, never authority: the merged rule must grant and forbid exactly what the chain
did. Where two rulings contradict each other, report it and let the user rule; do not pick one.

---

## Reporting and fixing

1. **Fix mechanically, in place:** dead references where the target clearly moved (1), seq-prefixed IDs
   (4), dangling links with an obvious target (6), skill-list drift (7).
2. **Fix after reading the source of truth:** contradictions (2) and statuses (3).
   Size and accretion (10) too: move or merge the text, and show the before and after in the summary so the user can
   confirm that no permission changed.
3. **Report as a backlog, don't write speculatively:** unrecorded specs (5), board drift (9).

Finish with a summary: findings by check, what was fixed, what remains as backlog. Zero findings is a
meaningful result; say so rather than inventing nits.
