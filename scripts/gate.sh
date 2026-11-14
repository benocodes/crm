#!/usr/bin/env bash
# The cycle gate as one run (execute-cycle §5): every suite, typecheck, build. Runs all four steps even
# when one fails, so a single run shows everything that is red. Run it from the cycle's worktree root.
#
#   scripts/gate.sh [log-dir]
#
# Default log dir: ${VIBASE_GATE_LOG_ROOT:-~/.cache/vibase-gate}/<worktree folder name>, outside every repo.
# `<root>/latest` is a symlink to the run in progress, so a human can watch it from any terminal with
#   tail -f ~/.cache/vibase-gate/latest/all.log
# all.log is every step's output in order, each under a `==== <step> ====` header.
# Writes <log-dir>/<step>.log per step and, last, <log-dir>/gate.status: one `<step> exit=<n>` line per
# step, then `GATE_EXIT=<0|1>`. Wait for that marker (`until grep -q GATE_EXIT <log-dir>/gate.status; ...`)
# instead of polling the logs. Pass VITEST_MAX_WORKERS=N on a loaded machine.
set -u
# $HOME can be unset or redirected in a sandboxed run: resolve the home directory from the account, and
# fall back to a temp dir when the cache dir is not writable, rather than abort before any test runs.
home_dir="${HOME:-$(cd ~ 2>/dev/null && pwd)}"
root="${VIBASE_GATE_LOG_ROOT:-$home_dir/.cache/vibase-gate}"
if ! mkdir -p "$root" 2>/dev/null || [ ! -w "$root" ]; then
  root="${TMPDIR:-/tmp}/vibase-gate"
  mkdir -p "$root" || { echo "gate.sh: no writable log root" >&2; exit 2; }
fi
log_dir="${1:-$root/$(basename "$PWD")}"
mkdir -p "$log_dir" || { echo "gate.sh: cannot create $log_dir" >&2; exit 2; }
echo "gate.sh: logs in $log_dir; watch with: tail -f $root/latest/all.log" >&2
rm -f "$log_dir"/*.log "$log_dir"/gate.status
ln -sfn "$(cd "$log_dir" && pwd)" "$root/latest"

overall=0
step() {
  local name="$1"; shift
  echo "==== $name: $* ====" | tee -a "$log_dir/all.log" >"$log_dir/$name.log"
  "$@" 2>&1 | tee -a "$log_dir/$name.log" >>"$log_dir/all.log"
  local code=${PIPESTATUS[0]}
  echo "$name exit=$code" >>"$log_dir/gate.status.partial"
  [ "$code" -ne 0 ] && overall=1
}

rm -f "$log_dir/gate.status.partial"
step packages pnpm -r --workspace-concurrency=1 --filter '!@vibase/api' test --reporter=dot
step api pnpm -C packages/api test --reporter=dot
step typecheck pnpm -r typecheck
step build pnpm -r build

mv "$log_dir/gate.status.partial" "$log_dir/gate.status"
echo "GATE_EXIT=$overall" >>"$log_dir/gate.status"
exit "$overall"
