---
name: open-issue
description: Open a GitHub issue in a zooid-ai repository as ZooidBot. Use when the user asks to create, file, or open an issue; leave classification and project-board work to product triage.
---

# Open Issue

Turn the user's report or request into a concise GitHub issue and open it with
ZooidBot. Preserve the user's scope; include context or acceptance criteria only
when they are already clear from the conversation.

Use [`scripts/gh-zooidbot`](scripts/gh-zooidbot) for the writing call. It reads
only `GH_ACCESS_TOKEN` from the workspace's gitignored `hq/.env` and exposes it
to `gh` as `GH_TOKEN`. Never print or pass the token as a command argument.

Infer the target `zooid-ai` repository from the affected project or its git
remote — **except** default to `zooid-ai/zooid` for anything that might be
spec-worthy (spans more than one package, needs a migration, or introduces a
new concept — see `spec-author` §5), even when the affected code lives
elsewhere. All spec IDs mint from `zooid-ai/zooid`'s issue numbers regardless
of area, so that's where spec-worthy issues belong. Small, scoped bugs and UI
tweaks that clearly don't need a spec still go in the repo that holds the
code. Ask only when the target is genuinely ambiguous. Create the issue and
return its URL.

Do not label, assign, deduplicate, add the issue to a project, set board fields,
or otherwise triage it unless the user explicitly asks. **One exception:** if
you're filing the issue so that you can write its spec yourself, add
`--label self-triaged`. Otherwise the triage webhook wakes the cloud
product-owner, which drafts a competing spec for the same ID (see
`spec-author` §1). The product manager
owns that follow-up.

If product triage later decides this issue warrants a spec, its issue number
becomes the spec ID (area code + issue number — see `spec-author` §1) —
**only if it's already in `zooid-ai/zooid`**; if it was filed elsewhere,
triage transfers it there first, which assigns a new number. No action needed
here beyond correct repo selection above; just know the number you return may
be load-bearing beyond this issue.

