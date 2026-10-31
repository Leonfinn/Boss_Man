#!/usr/bin/env bash
# Checks check-all.sh's retry logic with a stub in place of the real checks (BOSSMAN_CHECK_BODY).
# shellcheck disable=SC2016  # the stub bodies are meant to expand later, inside the child
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
t="$(mktemp -d)"; trap 'rm -rf "$t"' EXIT
fail() { echo "FAIL: $*"; exit 1; }
# check-all.sh runs this inside its own child, so drop the markers that would switch the retry loop off
unset BOSSMAN_CHECK_CHILD BOSSMAN_CHECK_ATTEMPTS BOSSMAN_CHECK_BUDGET_SECONDS BOSSMAN_CHECK_BODY
export BOSSMAN_CHECK_RETRY_SECONDS=0 BOSSMAN_CHECK_STORE=off
# check-all.sh sets this for its child; if we run inside a check-all run the stubbed runs must still go through the retry loop.
unset BOSSMAN_CHECK_CHILD
runs() { grep -c . "$t/count" 2>/dev/null || true; }

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

# The result store: a pass is kept and reused on identical content, the merge gate never reuses it, failures are not reused.
# Needs a clean git checkout, so test in a scratch repo holding a copy of the script.
if command -v git >/dev/null; then
  repo="$t/repo"; mkdir -p "$repo/scripts"; cp "$here/check-all.sh" "$repo/scripts/"
  git -C "$repo" init -q; git -C "$repo" add -A
  git -C "$repo" -c user.name=t -c user.email=t@t commit -q -m init
  store="$t/store"
  cached() { # cached <expected rc> <expected runs> <label> <stub body> [env VAR=value ...]
    local want_rc=$1 want_runs=$2 label=$3 body=$4 rc=0; shift 4
    : >"$t/count"; export COUNT="$t/count"
    (cd "$repo" && env BOSSMAN_CHECK_STORE="$store" BOSSMAN_CHECK_BODY="$body" "$@" ./scripts/check-all.sh >"$t/out" 2>&1) || rc=$?
    [ "$rc" -eq "$want_rc" ] || fail "$label: rc $rc, want $want_rc: $(cat "$t/out")"
    [ "$(runs)" -eq "$want_runs" ] || fail "$label: ran $(runs) times, want $want_runs"
  }
  cached 3 1 "store: failure" 'echo x >>"$COUNT"; echo "AssertionError"; exit 3' env
  cached 0 1 "store: failure is not reused" 'echo x >>"$COUNT"' env
  compgen -G "$store/*.log" >/dev/null || fail "store: log not kept"
  grep -q '"status":"pass"' "$store"/*.json || fail "store: pass not recorded"
  cached 0 0 "store: pass reused" 'echo x >>"$COUNT"' env
  grep -q "already passed" "$t/out" || fail "store: no reuse message: $(cat "$t/out")"
  cached 0 1 "store: merge gate does not trust it" 'echo x >>"$COUNT"' env BOSSMAN_MERGE_CHECK=1
  cached 0 1 "store: force re-runs" 'echo x >>"$COUNT"' env BOSSMAN_CHECK_FORCE=1
  echo change >"$repo/f"; git -C "$repo" add -A; git -C "$repo" -c user.name=t -c user.email=t@t commit -q -m two
  cached 0 1 "store: new content runs" 'echo x >>"$COUNT"' env
  echo dirty >>"$repo/f"
  cached 0 1 "store: dirty tree runs" 'echo x >>"$COUNT"' env
  cached 0 1 "store: dirty tree still runs the second time" 'echo x >>"$COUNT"' env
fi

# The slots and queue (need flock). pnpm/node are stubbed and CHECK_ALL_STOP_AFTER_LOCK stops the child once a slot is held.
if command -v flock >/dev/null; then
  mkdir "$t/bin"; printf '#!/bin/sh\nexit 0\n' >"$t/bin/pnpm"; cp "$t/bin/pnpm" "$t/bin/node"; chmod +x "$t/bin/pnpm" "$t/bin/node"
  lock() { (cd "$here/.." && PATH="$t/bin:$PATH" CHECK_ALL_LOCK="$t/lock" CHECK_ALL_STOP_AFTER_LOCK=1 CHECK_ALL_QUEUE_REPORT=1 "$@" ./scripts/check-all.sh 2>&1); }
  hold() { ( exec 8>"$t/lock.slot.$1"; flock 8; sleep "$2" ) & }

  out=$(lock env) || fail "free slot: expected success, got: $out"
  grep -q "lock held" <<<"$out" || fail "free slot: not acquired"

  # One slot by default: a busy slot makes a merge check give up. With CHECK_ALL_SLOTS=2 a second check runs.
  hold 1 4; holder=$!; sleep 0.3
  out=$(lock env CHECK_ALL_SLOTS=2) || fail "second slot: expected success, got: $out"
  grep -q "lock held" <<<"$out" || fail "second slot: not acquired"
  kill "$holder" 2>/dev/null || true; wait "$holder" 2>/dev/null || true

  # With both slots busy a merge check gives up with exit 75 after CHECK_ALL_LOCK_WAIT, and says its place.
  hold 1 5; h1=$!; hold 2 5; h2=$!; sleep 0.3
  rc=0; out=$(lock env BOSSMAN_MERGE_CHECK=1 CHECK_ALL_LOCK_WAIT=2) || rc=$?
  [ "$rc" = 75 ] || fail "busy slots: expected exit 75, got $rc: $out"
  grep -q "place 1 of 1" <<<"$out" || fail "busy slots: no place message: $out"
  grep -q "gave up" <<<"$out" || fail "busy slots: messages missing: $out"
  [ -z "$(ls "$t/lock.queue" 2>/dev/null)" ] || fail "gave-up check left its queue entry"
  kill "$h1" "$h2" 2>/dev/null || true; wait "$h1" "$h2" 2>/dev/null || true

  # A hand-run check does not give up on its own: it waits past the time that stops a merge check, then gets in.
  hold 1 4; h1=$!; hold 2 4; h2=$!; sleep 0.3
  out=$(lock env CHECK_ALL_LOCK_WAIT=0) || fail "hand-run wait: expected success, got: $out"
  grep -q "lock held" <<<"$out" || fail "hand-run wait: lock not acquired: $out"
  wait "$h1" "$h2"

  # Queue order: a merge check that arrives later goes ahead of a hand-run check; hand-run checks keep their order.
  hold 1 3; h1=$!; hold 2 3; h2=$!; sleep 0.3
  ( lock env >"$t/hand1.out"; date +%s%N >"$t/hand1.at" ) & hand1=$!
  sleep 0.3
  ( lock env >"$t/hand2.out"; date +%s%N >"$t/hand2.at" ) & hand2=$!
  sleep 0.3
  ( lock env BOSSMAN_MERGE_CHECK=1 CHECK_ALL_LOCK_WAIT=20 >"$t/merge.out"; date +%s%N >"$t/merge.at" ) & merge=$!
  wait "$h1" "$h2" "$hand1" "$hand2" "$merge"
  for f in hand1 hand2 merge; do grep -q "lock held" "$t/$f.out" || fail "queue: $f did not get a slot: $(cat "$t/$f.out")"; done
  grep -q "place 3 of 3" "$t/hand2.out" || grep -q "place 2 of 3" "$t/hand2.out" || fail "queue: no place shown: $(cat "$t/hand2.out")"
  [ "$(cat "$t/merge.at")" -le "$(cat "$t/hand1.at")" ] || fail "hand-run check got in ahead of the merge check"
  [ "$(cat "$t/hand1.at")" -le "$(cat "$t/hand2.at")" ] || fail "hand-run checks got in out of order"
  [ -z "$(ls "$t/lock.queue" 2>/dev/null)" ] || fail "queue entries left behind"

  # A waiter that died drops out of the queue instead of blocking those behind it.
  mkdir -p "$t/lock.queue"; : >"$t/lock.queue/1-0000000000000000001-999999"
  hold 1 2; h1=$!; hold 2 2; h2=$!; sleep 0.3
  out=$(lock env) || fail "dead waiter: expected success, got: $out"
  grep -q "lock held" <<<"$out" || fail "dead waiter blocked the queue: $out"
  wait "$h1" "$h2"

  # Default is one slot: with slot 1 busy a second check waits (merge check gives up), even though slot 2 is free.
  hold 1 3; h1=$!; sleep 0.3
  rc=0; out=$(lock env BOSSMAN_MERGE_CHECK=1 CHECK_ALL_LOCK_WAIT=1) || rc=$?
  [ "$rc" = 75 ] || fail "default slots: expected one slot (exit 75), got $rc: $out"
  wait "$h1"

  # A queue entry older than 2 h is dropped even when its pid is alive (a reused pid of a killed waiter).
  mkdir -p "$t/lock.queue"; : >"$t/lock.queue/1-1000000000000000000-$$"
  hold 1 2; h1=$!; sleep 0.3
  out=$(lock env) || fail "stale waiter: expected success, got: $out"
  grep -q "lock held" <<<"$out" || fail "stale waiter blocked the queue: $out"
  wait "$h1"
  # A hostile queue entry name must be removed, never run.
  rm -rf "$t/lock.queue"; mkdir -p "$t/lock.queue"
  hostile="$t/lock.queue/1-a[\$(touch PWNED)]-$$"; : >"$hostile"
  hold 1 2; h1=$!; sleep 0.3
  out=$(lock env) || fail "hostile entry: expected success, got: $out"
  [ ! -e PWNED ] || { rm -f PWNED; fail "hostile queue entry name ran a command"; }
  [ ! -e "$hostile" ] || fail "hostile queue entry was not removed"
  wait "$h1"
else
  echo "check-all.test.sh: flock missing, slot cases skipped"
fi
echo "check-all.test.sh: ok"
