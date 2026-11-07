# Codex delivery roles

Project-scoped custom agents mirror `.claude/agents/` using Codex standalone TOML files.
`AGENTS.md` is the shared workflow and permission authority.

| Role | Model | Reasoning |
|---|---|---|
| orchestrator | gpt-6.1-sol | xhigh |
| planner | gpt-6.1-sol | xhigh |
| coder | gpt-6.1-sol | high |
| e2e-tester | gpt-6.1-sol | medium |

All roles, including verify-only workers, use Sol for now. Reasoning effort varies by role.
These are repository choices, not a claim that Claude and Codex model tiers are equivalent.

Start a sprint in the main session:

```sh
codex --profile orchestrator
```

The installed `~/.codex/orchestrator.config.toml` is a symlink to
`.codex/profiles/orchestrator.config.toml` in this checkout. The profile selects Sol / xhigh
and instructs the main session to read the existing orchestrator role prompt, so its
workflow instructions are maintained in one place. Run it from this repository.
To install on another machine, from the repository root (if the destination is unused):

```sh
ln -s "$PWD/.codex/profiles/orchestrator.config.toml" ~/.codex/orchestrator.config.toml
```

In the app, ask the main session to act as orchestrator and read the same files.
The orchestrator file is also a readable role definition; its presence does not automatically
switch the main session into that role. Only sprint work uses orchestration.

The runtime discovers project agents in `.codex/agents/`. If the current session has no named
custom-agent selector, the orchestrator briefs a fresh agent to read the appropriate TOML,
and passes its model and effort explicitly. A fresh session may be needed to discover new roles.
Workers never delegate further. Permissions are inherited from the parent session.

Keep the shared responsibilities and report formats in sync with `.claude/agents/` when editing.
The Codex adaptation uses Codex messaging tools, fresh-context delegation, runtime limits and
only records usage counts the runtime actually provides. Current AGENTS.md overrides old examples.

Format reference: https://learn.chatgpt.com/docs/agent-configuration/subagents
