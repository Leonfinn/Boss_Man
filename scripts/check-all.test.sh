#!/usr/bin/env bash
# Checks check-all.sh's retry logic with a stub in place of the real checks (BOSSMAN_CHECK_BODY).
# shellcheck disable=SC2016  # the stub bodies are meant to expand later, inside the child
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
t="$(mktemp -d)"; trap 'rm -rf "$t"' EXIT
fail() { echo "FAIL: $*"; exit 1; }
# check-all.sh runs this inside its own child, so drop the markers that would switch the retry loop off
unset BOSSMAN_CHECK_CHILD BOSSMAN_CHECK_ATTEMPTS BOSSMAN_CHECK_BUDGET_SECONDS BOSSMAN_CHECK_BODY
export BOSSMAN_CHECK_RETRY_SECONDS=0
# check-all.sh sets this for its child; if we run inside a check-all run the stubbed runs must still go through the retry loop.
unset BOSSMAN_CHECK_CHILD
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
run 3 1 "no retry when another run would blow the budget" 'echo x >>"$COUNT"; sleep 2; echo "Error: spawn EAGAIN"; exit 3' "$here/.." "env BOSSMAN_CHECK_BUDGET_SECONDS=1 ./scripts/check-all.sh"
run 0 1 "relative path from scripts/" 'echo x >>"$COUNT"' "$here" ./check-all.sh
run 0 1 "bash check-all.sh from scripts/" 'echo x >>"$COUNT"' "$here" "bash check-all.sh"

# The heavy-phase lock (needs flock). pnpm/node are stubbed and CHECK_ALL_STOP_AFTER_LOCK stops the child once the lock is held.
if command -v flock >/dev/null; then
  mkdir "$t/bin"; printf '#!/bin/sh\nexit 0\n' >"$t/bin/pnpm"; cp "$t/bin/pnpm" "$t/bin/node"; chmod +x "$t/bin/pnpm" "$t/bin/node"
  lock() { (cd "$here/.." && PATH="$t/bin:$PATH" CHECK_ALL_LOCK="$t/lock" CHECK_ALL_STOP_AFTER_LOCK=1 "$@" ./scripts/check-all.sh 2>&1); }

  out=$(lock env) || fail "free lock: expected success, got: $out"
  grep -q "lock held" <<<"$out" || fail "free lock: not acquired"

  # A second caller waits, then gives up with exit 75 after CHECK_ALL_LOCK_WAIT (no retry: not a process-limit error).
  ( exec 8>"$t/lock"; flock 8; sleep 5 ) & holder=$!
  sleep 0.5
  rc=0; out=$(lock env CHECK_ALL_LOCK_WAIT=1) || rc=$?
  [ "$rc" = 75 ] || fail "busy lock: expected exit 75, got $rc"
  grep -q "waiting for it" <<<"$out" || fail "busy lock: no waiting message: $out"
  grep -q "gave up" <<<"$out" || fail "busy lock: messages missing: $out"
  kill "$holder" 2>/dev/null || true; wait "$holder" 2>/dev/null || true

  # A merge check waiting for the lock holds back a hand-run check that arrives later: when the holder lets go, the merge check gets it.
  ( exec 8>"$t/lock"; flock 8; sleep 3 ) & holder=$!
  sleep 0.3
  ( lock env BOSSMAN_MERGE_CHECK=1 CHECK_ALL_LOCK_WAIT=10 >"$t/merge.out"; date +%s%N >"$t/merge.at" ) & merge=$!
  sleep 0.5
  ( lock env CHECK_ALL_LOCK_WAIT=10 >"$t/hand.out"; date +%s%N >"$t/hand.at" ) & hand=$!
  wait "$holder" "$merge" "$hand"
  grep -q "lock held" "$t/merge.out" || fail "merge check: lock not acquired: $(cat "$t/merge.out")"
  grep -q "lock held" "$t/hand.out" || fail "hand-run check: lock not acquired: $(cat "$t/hand.out")"
  [ "$(cat "$t/merge.at")" -le "$(cat "$t/hand.at")" ] || fail "hand-run check got in ahead of the merge check"
  [ -z "$(ls "$t/lock.merge-waiting" 2>/dev/null)" ] || fail "merge check left its waiting marker behind"

  # Once the holder lets go, the waiter gets in.
  ( exec 8>"$t/lock"; flock 8; sleep 1 ) & holder=$!
  sleep 0.3
  out=$(lock env CHECK_ALL_LOCK_WAIT=10) || fail "released lock: expected success, got: $out"
  wait "$holder"
else
  echo "check-all.test.sh: flock missing, lock cases skipped"
fi
echo "check-all.test.sh: ok"
