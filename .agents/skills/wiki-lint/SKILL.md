---
name: wiki-lint
description: Health-check the repo's knowledge layer — AGENTS.md, docs/, .agents/skills/, and spec metadata — for dead paths, contradictions, stale Status headers, seq-prefixed spec references, shipped-but-undocumented specs, and broken wiki-links. Run periodically, after a burst of shipped epics, or when something in the wiki smells stale. Reports findings ranked by severity; fixes only the mechanical ones.
---

# Wiki Lint

The wiki (docs/), AGENTS.md, and the skills are the repo's **maintained knowledge layer**, synthesized from raw sources (RETROs, migrations, git history). `epic-retrospect` keeps it current at write time; this skill is the read-time audit — it catches what ingest missed, what code changes silently invalidated, and what contradicts what.

**Usage:** `/wiki-lint` (whole knowledge layer) or `/wiki-lint <path>` (one file/section)

Every check below has caught (or would have caught) a real defect in this repo — examples cited inline.

---

## The checks

Run all of them for a full lint; each is independent. Use subagents for the read-heavy ones when doing a full pass.

### 1. Dead paths

Every file/directory path mentioned in AGENTS.md, `docs/**`, and `.agents/skills/**/SKILL.md` must exist on disk.

```bash
# Extract path-like tokens; only keep ones that look like real file refs
# (have an extension or a trailing slash) — extensionless docs/... tokens are
# usually fumadocs route URLs or external-site URLs, not file paths.
grep -rhoE '(packages|knowledge|specs|docs|data|SOP|epics)/[A-Za-z0-9_./-]+' AGENTS.md docs .agents/skills \
  | sed 's/[).,:;`]*$//' | grep -v '[{<*]' | grep -E '(\.[a-z]+$|/$)' | sort -u \
  | while read -r p; do [ -e "$p" ] || echo "MISSING: $p"; done
```

Template placeholders (`packages/{pkg}`, `knowledge/specs/<spec-folder>`) are excluded by the `[{<*]` filter. A path quoted *as an anti-pattern example* (e.g. spec-author's "don't reference `knowledge/specs/010-API-003-foo/API-003.md`") is a false positive — read the surrounding sentence before flagging. For each real miss, decide: was the file moved/renamed (fix the reference) or is the whole claim about it stale (rewrite the passage)?

*Real instance: the epic-generator skill prescribed a "matcher" package for two months after that package design was abandoned.*

### 2. Contradictions between knowledge sources

The same fact stated in two places must agree. Compare AGENTS.md, `docs/index.mdx` ("For AI agents"), `docs/conventions.mdx`, and the area skills on the load-bearing claims:

- tenancy axis (organization vs user), and which wrappers are mandated
- LLM SDK (`ai` + `@ai-sdk/*`) and test mocking (`MockLanguageModelV2`, never fetch)
- capture path (MAIN-world patch primary, CDP legacy)
- test stacks and commands per package
- types workflow (`types.generated.ts` generated, narrowing in `types.ts`)
- PostGraphile containment (new business logic = Hono RPC, no new plugins)

For each claim, grep for its keywords across all four sources and read the hits side by side. Where they disagree, **code wins** — check the implementation, then fix every non-conforming statement.

*Real instance: a skill prescribed the Anthropic SDK while AGENTS.md mandated the Vercel AI SDK.*

### 3. Spec `status:` frontmatter vs. RETRO evidence

A spec whose epics all have a `*-RETRO.md` should not say `draft`.

```bash
# zsh-safe: `status` is a read-only zsh variable, and unmatched globs error — use `st` and find(1)
for spec in knowledge/specs/*/; do
  f=$(find "$spec" -maxdepth 1 -name '*.md' | head -1); [ -z "$f" ] && continue
  st=$(grep -m1 '^status:' "$f" | sed 's/status: *//')
  plans=$(find "$spec"epics -name '*-PLAN.md' 2>/dev/null | wc -l | tr -d ' ')
  retros=$(find "$spec"epics -name '*-RETRO.md' 2>/dev/null | wc -l | tr -d ' ')
  [ "$plans" -gt 0 ] && [ "$retros" = "$plans" ] && case "$st" in draft|approved) echo "STALE: $f says '$st' with $retros/$plans epics retro'd";; esac
  [ "$retros" -gt 0 ] && [ "$retros" != "$plans" ] && case "$st" in draft|approved) echo "SHIPPING?: $f says '$st' with $retros/$plans epics retro'd";; esac
done
```

Flag; don't blindly flip — a spec can have completed epics covering only part of its scope (`shipping`, not `shipped`). Read the spec's scope before updating the frontmatter, and add a changelog entry with any change. Also check that every `superseded_by:` field has a matching row in `docs/specs/index.mdx`'s known-supersessions list, and vice versa.

### 4. Seq-prefixed spec references outside `knowledge/specs/`

Specs are referenced by stable ID (`AI-009`), never by seq-prefixed folder name (`042-AI-009`) — seqs are reassignable and go stale.

```bash
grep -rnE '\b[0-9]{3}-(API|EXT|DB|WEB|CORE|AI|OPS)-[0-9]{3}' docs AGENTS.md .agents/skills \
  | grep -v 'knowledge/specs/[0-9]'   # literal full paths get checked by check 1 instead
```

Every hit: replace with the bare stable ID (and verify the claim still holds while you're there).

*Real instance: `docs/vision/` cited `042-AI-009` after the spec was renumbered to `041-`, breaking the links.*

### 5. Shipped-but-undocumented specs

A spec with completed epics that no docs page mentions is a candidate wiki gap.

```bash
for spec in knowledge/specs/*/; do
  id=$(basename "$spec" | sed -E 's/^[0-9]+-([A-Z]+-[0-9]+).*/\1/')
  retros=$(find "$spec"epics -name '*-RETRO.md' 2>/dev/null | wc -l | tr -d ' ')
  [ "$retros" -gt 0 ] || continue
  grep -rql "$id" docs >/dev/null || echo "UNDOCUMENTED: $id ($retros retro(s), no docs mention)"
done
```

Judgment, not mechanical: a small internal refactor may not need a docs page — but anything that changed architecture, a data shape, or user-visible behavior does. Report the list with a recommendation each.

### 6. Broken wiki-links

Stable-ID wiki-links must resolve to a file named `<target>.md`: `[[CORE-019]]` → the spec, `[[CORE-023-e01-RETRO]]` → that epic's retro. Only check the ID-shaped forms — PLAN/RETRO files also carry Obsidian-style links to non-spec notes, which are raw-source content, not lintable references:

```bash
grep -rhoE '\[\[(API|EXT|DB|WEB|CORE|AI|OPS)-[0-9]+(-e[0-9]+[a-z]?-(PLAN|RETRO))?\]\]' knowledge docs .agents 2>/dev/null \
  | sort -u | sed 's/\[\[\(.*\)\]\]/\1/' \
  | while read -r t; do find knowledge/specs -name "$t.md" | grep -q . || echo "DANGLING: [[$t]]"; done
```

A dangling link to a bare spec ID can be a **reserved ID** — deliberately allocated for a future spec (e.g. `[[AI-007]]`, cited as "reserved" by several shipped specs). Check how the referencing text describes it; reserved IDs are fine to leave dangling — the link marks a spec worth writing, not an error.

### 7. Skill-list drift

The skill inventories in AGENTS.md ("Conventions live as skills") and `docs/conventions.mdx` must match `ls .agents/skills/`. A skill that exists but isn't listed won't get read; a listed skill that doesn't exist misleads.

### 8. A sprint that should have been closed

If `knowledge/SPRINT.md` exists, every spec in its band should still have work outstanding. Check each one's `status:` — if they are **all** `shipped`, the sprint finished and nobody ran `/sprint-planning close`, so a stale planning file is sitting at the canonical path reading as current. Report it; don't delete it yourself (closing has verification steps — see `sprint-planning`).

Same check in reverse: a `SPRINT.md` whose Sequence table disagrees with the specs' actual `status:` frontmatter is a stale checkpoint, and its Ledger is the part most likely to have rotted.

---

## Reporting and fixing

1. **Fix mechanically, in place:** dead references where the target clearly moved (check 1), seq-prefixed IDs (check 4), dangling wiki-links with an obvious target (check 6), skill-list drift (check 7).
2. **Fix after reading the source of truth:** contradictions (check 2 — verify against code first) and Status headers (check 3 — read the spec's scope first).
3. **Report as a backlog, don't write speculatively:** undocumented-spec gaps (check 5) — each needs real fact-gathering from the spec/RETRO/code before a docs page is worth writing.

Finish with a summary: findings by check, what was fixed, what remains as backlog. Zero findings is a meaningful result — say so rather than inventing nits.
