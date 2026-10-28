---
name: open-issue
description: Open a GitHub issue in benocodes/crm as zooidbot. Use when the user asks to create, file, or open an issue; leave classification and project-board work to triage-issues (board IDs and commands: the board skill).
---

# Open Issue

Turn the user's report or request into a concise GitHub issue in **`benocodes/crm`** and open it as
zooidbot. Preserve the user's scope; include context or acceptance criteria only when they are already
clear from the conversation.

Use [`scripts/gh-zooidbot`](../../../scripts/gh-zooidbot) (repo root) for the writing call. It reads
`ZB_GH_TOKEN` from the gitignored `.env` and exposes it to `gh` as `GH_TOKEN`. Never print the token or
pass it as a command argument.

```bash
scripts/gh-zooidbot issue create -R benocodes/crm --title "…" --body "…"
```

There is one code repo, so the target is always `benocodes/crm`. Return the issue URL.

The issue number is load-bearing: if triage later decides the issue warrants a spec, its number becomes
the spec ID (area code + issue number, see `spec-author` §1). That is why everything that might be
spec-worthy is filed here and never transferred.

Do not label, assign, deduplicate, add the issue to a project, set board fields, or otherwise triage it
unless the user explicitly asks. **One exception:** if you are filing the issue so that you can write its
spec yourself, add `--label self-triaged` so `triage-issues` leaves it alone and nothing drafts a
competing spec for the same ID (see `spec-author` §1).
