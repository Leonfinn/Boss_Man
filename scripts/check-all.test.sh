#!/usr/bin/env bash
# Checks check-all.sh's retry logic with a stub in place of the real checks (BOSSMAN_CHECK_BODY).
# shellcheck disable=SC2016  # the stub bodies are meant to expand later, inside the child
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
t="$(mktemp -d)"; trap 'rm -rf "$t"' EXIT
fail() { echo "FAIL: $*"; exit 1; }
export BOSSMAN_CHECK_RETRY_SECONDS=0
runs() { grep -c . "$t/count" 2>/dev/null || echo 0; }

# run <expected rc> <expected runs> <label> <stub body> [dir] [command]
run() {
  local want_rc=$1 want_runs=$2 label=$3 body=$4 dir=${5:-$here/..} cmd=${6:-./scripts/check-all.sh} rc=0
  : >"$t/count"; export COUNT="$t/count"
  (cd "$dir" && BOSSMAN_CHECK_BODY="$body" $cmd >"$t/out" 2>&1) || rc=$?
  [ "$rc" -eq "$want_rc" ] || fail "$label: rc $rc, want $want_rc: $(cat "$t/out")"
  [ "$(runs)" -eq "$want_runs" ] || fail "$label: ran $(runs) times, want $want_runs"
}

run 0 1 "success" 'echo x >>"$COUNT"'
run 3 3 "EAGAIN retried, final rc kept" 'echo x >>"$COUNT"; echo "Error: spawn EAGAIN"; exit 3'
run 3 3 "spawnSync form retried" 'echo x >>"$COUNT"; echo "Error: spawnSync git EAGAIN"; exit 3'
run 3 1 "real failure not retried" 'echo x >>"$COUNT"; echo "AssertionError: nope"; exit 3'
run 0 2 "flaky then pass" 'echo x >>"$COUNT"; if [ "$(grep -c . "$COUNT")" -lt 2 ]; then echo "fork: retry"; exit 1; fi'
run 0 1 "relative path from scripts/" 'echo x >>"$COUNT"' "$here" ./check-all.sh
run 0 1 "bash check-all.sh from scripts/" 'echo x >>"$COUNT"' "$here" "bash check-all.sh"
echo "check-all.test.sh: ok"
