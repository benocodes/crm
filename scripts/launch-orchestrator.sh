#!/usr/bin/env bash
# Start the sprint orchestrator as the main session, with the sprint-relay mod
# (the `next_cycle` tool that clears the context between cycles).
# Extra arguments pass through to `claude`.
set -euo pipefail
cd "$(dirname "$0")/.."
exec claude --agent orchestrator --plugin-dir .claude/mods/sprint-relay "$@"
