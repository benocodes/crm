---
name: wiki-lint
description: Health-check the repo's knowledge layer — AGENTS.md, .agents/skills/, and the nested knowledge/ repo (specs, architecture, project-state) — for dead paths, contradictions, stale spec statuses, seq-prefixed spec references, shipped-but-unrecorded specs, broken wiki-links and a sprint that should have been closed. Run periodically, after a burst of shipped cycles, or when something in the knowledge layer smells stale. Reports findings ranked by severity; fixes only the mechanical ones.
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
- agents never send; suggestions then execution rail
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

### 8. A sprint that should have been closed

If `knowledge/SPRINT.md` exists, every spec in its band should still have work outstanding. If **all** are
`shipped`, nobody ran `/sprint-planning close`, so a stale planning file reads as current. Report it; don't
delete it (closing has verification steps; see [[sprint-planning]]). The reverse also holds: a `SPRINT.md`
whose Sequence table disagrees with the specs' real `status:` is a stale checkpoint, and its Ledger is the
part most likely to have rotted.

### 9. Board and skill drift

The `board` skill holds the project board's IDs. If a skill hard-codes a board ID, option ID or field name
that disagrees with it, report it. If `gh project field-list` (see the `board` skill) no longer matches the file,
the IDs have rotted: re-derive them.

---

## Reporting and fixing

1. **Fix mechanically, in place:** dead references where the target clearly moved (1), seq-prefixed IDs
   (4), dangling links with an obvious target (6), skill-list drift (7).
2. **Fix after reading the source of truth:** contradictions (2) and statuses (3).
3. **Report as a backlog, don't write speculatively:** unrecorded specs (5), board drift (9).

Finish with a summary: findings by check, what was fixed, what remains as backlog. Zero findings is a
meaningful result; say so rather than inventing nits.
