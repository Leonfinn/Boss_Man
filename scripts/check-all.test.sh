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
# Also drop the merge gate's and user's settings, which would change what the cases below mean. check-all.sh sets CHILD for its child; if we run inside a check-all run the stubbed runs must still go through the retry loop.
unset BOSSMAN_CHECK_CHILD BOSSMAN_MERGE_CHECK BOSSMAN_CHECK_FORCE CHECK_ALL_SLOTS CHECK_ALL_LOCK_WAIT CLAUDECODE BOSSMAN_AGENT_SESSION CHECK_ALL_FORCE
# check-all.sh sweeps /tmp before it takes a slot; on a busy runner that outruns the timed holds below (BOS-557). Sweep an empty folder of ours instead.
mkdir -p "$t/sweep"; export SWEEP_TMP_DIR="$t/sweep"
runs() { grep -c . "$t/count" 2>/dev/null || true; }

# run <expected rc> <expected runs> <label> <stub body> [dir] [command]
run() {
  local want_rc=$1 want_runs=$2 label=$3 body=$4 dir=${5:-$here/..} cmd=${6:-./scripts/check-all.sh} rc=0
  : >"$t/count"; export COUNT="$t/count"
  # Each case uses its own lock so the tests never wait on another agent's real check (the stub takes a slot now).
  (cd "$dir" && CHECK_ALL_LOCK="$t/rlock" CHECK_ALL_PAIR_PROOF="$t/rproof" BOSSMAN_CHECK_BODY="$body" $cmd >"$t/out" 2>&1) || rc=$?
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

# Agent sessions: a hand run is refused (exit 2, nothing runs) unless forced; the merge gate and humans are unaffected.
agent_msg="Full check runs at the merge gate. Run scripts/check-quick.sh for your branch instead, or set CHECK_ALL_FORCE=1 if the CEO asked you to."
run 2 0 "refused inside an agent session" 'echo x >>"$COUNT"' "$here/.." "env CLAUDECODE=1 ./scripts/check-all.sh"
grep -qF "$agent_msg" "$t/out" || fail "agent refusal message missing: $(cat "$t/out")"
run 2 0 "refused for the runner's session marker" 'echo x >>"$COUNT"' "$here/.." "env BOSSMAN_AGENT_SESSION=1 ./scripts/check-all.sh"
run 0 1 "CHECK_ALL_FORCE=1 overrides in an agent session" 'echo x >>"$COUNT"' "$here/.." "env CLAUDECODE=1 CHECK_ALL_FORCE=1 ./scripts/check-all.sh"
run 0 1 "merge gate runs even if the marker is set" 'echo x >>"$COUNT"' "$here/.." "env CLAUDECODE=1 BOSSMAN_MERGE_CHECK=1 ./scripts/check-all.sh"

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
    (cd "$repo" && env CHECK_ALL_LOCK="$t/clock" CHECK_ALL_PAIR_PROOF="$t/cproof" BOSSMAN_CHECK_STORE="$store" BOSSMAN_CHECK_BODY="$body" "$@" ./scripts/check-all.sh >"$t/out" 2>&1) || rc=$?
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
  # BOS-545: the recorded duration is the whole run from slot taken, even if something inside the run (a nested
  # check-all, as in the script tests) writes to the start-time file. Old code recorded the nested write: 0 s.
  if command -v git >/dev/null; then
    git -C "$repo" checkout -q -- . ; git -C "$repo" -c user.name=t -c user.email=t@t commit -q --allow-empty -m clean; rm -f "$store"/*.json
    ( cd "$repo" && env CHECK_ALL_LOCK="$t/dlock" CHECK_ALL_PAIR_PROOF="$t/dproof" BOSSMAN_CHECK_STORE="$store" BOSSMAN_CHECK_FORCE=1 \
        CHECK_ALL_SLOT_COMMAND='sleep 2; [ -z "${CHECK_ALL_STARTED_FILE:-}" ] || date +%s >"$CHECK_ALL_STARTED_FILE"' ./scripts/check-all.sh >"$t/out" 2>&1 ) || fail "duration run failed: $(cat "$t/out")"
    d=$(sed -n 's/.*"duration_seconds":\([0-9]*\).*/\1/p' "$store"/*.json | head -1)
    [ "${d:-0}" -ge 2 ] || fail "duration_seconds is ${d:-missing}, want the whole run (>= 2): $(cat "$t/out")"
  fi
  mkdir "$t/bin"; printf '#!/bin/sh\nexit 0\n' >"$t/bin/pnpm"; cp "$t/bin/pnpm" "$t/bin/node"; chmod +x "$t/bin/pnpm" "$t/bin/node"
  lock() { (cd "$here/.." && PATH="$t/bin:$PATH" CHECK_ALL_LOCK="$t/lock" CHECK_ALL_STOP_AFTER_LOCK=1 CHECK_ALL_QUEUE_REPORT=1 CHECK_ALL_PAIR_PROOF="$t/proof" "$@" ./scripts/check-all.sh 2>&1); }
  # A hold starts counting its seconds only once a waiter has queued behind it (a queue entry newer than the hold),
  # so no case depends on how long check-all takes to reach the lock under load (BOS-563). Hold 3600 and kill for "until released".
  hold() { local st="$t/stamp.$1.$RANDOM"; : >"$st"; ( exec 8>"$t/lock.slot.$1"; flock 8; for _ in $(seq 1500); do [ -n "$(find "$t/lock.queue" -type f -newer "$st" 2>/dev/null | head -1)" ] && break; sleep 0.1; done; exec sleep "$2" ) & }
  waitq() { for _ in $(seq 1500); do [ "$(find "$t/lock.queue" -type f 2>/dev/null | wc -l)" -ge "$1" ] && return 0; sleep 0.1; done; return 1; }

  out=$(lock env) || fail "free slot: expected success, got: $out"
  grep -q "lock held" <<<"$out" || fail "free slot: not acquired"

  # An unusable lock folder (outside a fenced session's grant, or a planted non-file slot) fails at once with a
  # clear message instead of waiting forever as if the slot were busy (BOS-321, Freddy's hazard 2).
  mkdir -p "$t/ro" "$t/bad.slot.1"; chmod 555 "$t/ro"
  if [ ! -w "$t/ro" ]; then
    rc=0; out=$(lock env CHECK_ALL_LOCK="$t/ro/lock" timeout 300) || rc=$?
    [ "$rc" = 2 ] || fail "unwritable lock folder: expected exit 2, got $rc: $out"
    grep -q "cannot use the check lock folder" <<<"$out" || fail "unwritable lock folder: no clear message: $out"
  fi
  chmod 755 "$t/ro"
  rc=0; out=$(lock env CHECK_ALL_LOCK="$t/bad" timeout 300) || rc=$?
  [ "$rc" = 2 ] || fail "unopenable slot: expected exit 2 at once, got $rc: $out"
  grep -q "cannot open $t/bad.slot.1" <<<"$out" || fail "unopenable slot: no clear message: $out"
  [ -z "$(ls "$t/bad.queue" 2>/dev/null)" ] || fail "unopenable slot: queue entry left behind"

  # One slot until a side-by-side pair has passed: a busy slot makes a second check wait, and CHECK_ALL_SLOTS=2 alone is ignored.
  hold 1 3; holder=$!; sleep 0.3
  rc=0; out=$(lock env BOSSMAN_MERGE_CHECK=1 CHECK_ALL_LOCK_WAIT=1 CHECK_ALL_SLOTS=2) || rc=$?
  [ "$rc" = 75 ] || fail "no proof: expected exit 75, got $rc: $out"
  grep -q "ignored" <<<"$out" || fail "no proof: no ignored message: $out"
  kill "$holder" 2>/dev/null || true; wait "$holder" 2>/dev/null || true
  hold 1 3; holder=$!; sleep 0.3
  out=$(lock env CHECK_ALL_PAIR_TRIAL=1) || fail "trial: expected success, got: $out"
  grep -q "lock held" <<<"$out" || fail "trial: second slot not acquired"
  kill "$holder" 2>/dev/null || true; wait "$holder" 2>/dev/null || true
  echo "A=600s B=640s no OOM" >"$t/proof"

  # With a recorded pair, two slots: one busy slot does not stop a second check.
  hold 1 4; holder=$!; sleep 0.3
  out=$(lock env CHECK_ALL_SLOTS=2) || fail "second slot: expected success, got: $out"
  grep -q "lock held" <<<"$out" || fail "second slot: not acquired"
  kill "$holder" 2>/dev/null || true; wait "$holder" 2>/dev/null || true

  # A proof holding just a number sets the slot count (written by the runner from BOSSMAN_CHECK_SLOTS), whatever CHECK_ALL_SLOTS says.
  echo 1 >"$t/proof"; hold 1 4; holder=$!; sleep 0.3
  rc=0; out=$(lock env BOSSMAN_MERGE_CHECK=1 CHECK_ALL_LOCK_WAIT=1 CHECK_ALL_SLOTS=2) || rc=$?
  [ "$rc" = 75 ] || fail "proof 1: expected exit 75 (one slot), got $rc: $out"
  kill "$holder" 2>/dev/null || true; wait "$holder" 2>/dev/null || true
  # A proof of 0 means one slot, not the old default of two.
  echo 0 >"$t/proof"; hold 1 4; holder=$!; sleep 0.3
  rc=0; out=$(lock env BOSSMAN_MERGE_CHECK=1 CHECK_ALL_LOCK_WAIT=1 CHECK_ALL_SLOTS=2) || rc=$?
  [ "$rc" = 75 ] || fail "proof 0: expected exit 75 (one slot), got $rc: $out"
  kill "$holder" 2>/dev/null || true; wait "$holder" 2>/dev/null || true
  echo 3 >"$t/proof"; hold 1 5; h1=$!; hold 2 5; h2=$!; sleep 0.3
  out=$(lock env) || fail "proof 3: expected a third slot, got: $out"
  grep -q "lock held" <<<"$out" || fail "proof 3: third slot not acquired"
  kill "$h1" "$h2" 2>/dev/null || true; wait "$h1" "$h2" 2>/dev/null || true
  echo "A=600s B=640s no OOM" >"$t/proof"

  # With both slots busy a merge check gives up with exit 75 after CHECK_ALL_LOCK_WAIT, and says its place.
  hold 1 3600; h1=$!; hold 2 3600; h2=$!; sleep 0.3  # released by the kill after the leading-zero case below
  rc=0; out=$(lock env BOSSMAN_MERGE_CHECK=1 CHECK_ALL_LOCK_WAIT=2) || rc=$?
  [ "$rc" = 75 ] || fail "busy slots: expected exit 75, got $rc: $out"
  grep -q "place 1 of 1" <<<"$out" || fail "busy slots: no place message: $out"
  grep -q "gave up" <<<"$out" || fail "busy slots: messages missing: $out"
  # A leading zero in a stored duration or in a queue name is read as base 10, not octal (09 would abort the wait).
  mkdir "$t/zstore"; echo '{"status":"pass","duration_seconds":09}' >"$t/zstore/a.json"
  rc=0; out=$(lock env BOSSMAN_MERGE_CHECK=1 CHECK_ALL_LOCK_WAIT=2 BOSSMAN_CHECK_STORE="$t/zstore") || rc=$?
  [ "$rc" = 75 ] || fail "leading zero: expected exit 75, got $rc: $out"
  grep -q "about 1 min" <<<"$out" || fail "leading zero: no estimate: $out"
  [ -z "$(ls "$t/lock.queue" 2>/dev/null)" ] || fail "gave-up check left its queue entry"
  kill "$h1" "$h2" 2>/dev/null || true; wait "$h1" "$h2" 2>/dev/null || true

  # BOS-370: a merge check with no CHECK_ALL_LOCK_WAIT keeps waiting while the queue moves (the slot's holder changes)...
  hold 1 7; h1=$!; hold 2 7; h2=$!; sleep 0.3
  lock env BOSSMAN_MERGE_CHECK=1 CHECK_ALL_STUCK_AFTER=3 >"$t/moving.out" & mw=$!
  waitq 1   # the mover starts once the waiter is in the queue, however long that took
  ( for i in 1 2 3 4 5 6; do echo "$i $i" >"$t/lock.holder.1"; sleep 1; done ) & mover=$!
  mrc=0; wait "$mw" || mrc=$?; out=$(cat "$t/moving.out"); [ "$mrc" = 0 ] || fail "moving queue: expected to keep waiting and get in, got: $out"
  grep -q "lock held" <<<"$out" || fail "moving queue: lock not acquired: $out"
  wait "$h1" "$h2" "$mover"
  # ...and gives up, saying so, only when the same holder sits there past the bound (a dead holder that never lets go).
  hold 1 8; h1=$!; hold 2 8; h2=$!; sleep 0.3
  echo "999999 1" >"$t/lock.holder.1"
  rc=0; out=$(lock env BOSSMAN_MERGE_CHECK=1 CHECK_ALL_STUCK_AFTER=2) || rc=$?
  [ "$rc" = 75 ] || fail "stuck queue: expected exit 75, got $rc: $out"
  grep -q "gave up waiting for the heavy-phase lock.*made no progress for 1 min" <<<"$out" || fail "stuck queue: not said plainly: $out"
  kill "$h1" "$h2" 2>/dev/null || true; wait "$h1" "$h2" 2>/dev/null || true
  rm -f "$t"/lock.holder.*

  # A long wait does not cost a live check its place: an old entry is dropped only when nobody has touched it for 2 h.
  mkdir -p "$t/lock.queue"
  : >"$t/lock.queue/0-1000000000000000000-$$"                       # live pid, old name, fresh file: keeps its place
  : >"$t/lock.queue/0-1000000000000000001-$$"; touch -d '3 hours ago' "$t/lock.queue/0-1000000000000000001-$$"  # untouched for 3 h: dropped
  hold 1 4; h1=$!; sleep 0.3
  rc=0; out=$(lock env BOSSMAN_MERGE_CHECK=1 CHECK_ALL_LOCK_WAIT=2) || rc=$?
  grep -q "place 2 of 2" <<<"$out" || fail "old live entry: expected place 2 of 2 (one entry kept, one dropped): $out"
  rm -f "$t"/lock.queue/*
  kill "$h1" 2>/dev/null || true; wait "$h1" 2>/dev/null || true

  # A hand-run check does not give up on its own: it waits past the time that stops a merge check, then gets in.
  hold 1 4; h1=$!; hold 2 4; h2=$!; sleep 0.3
  out=$(lock env CHECK_ALL_LOCK_WAIT=0) || fail "hand-run wait: expected success, got: $out"
  grep -q "lock held" <<<"$out" || fail "hand-run wait: lock not acquired: $out"
  wait "$h1" "$h2"

  # A merge check with no CHECK_ALL_LOCK_WAIT set waits its turn (the default is hours, not 10 minutes) and announces when its checks begin.
  hold 1 3; h1=$!; sleep 0.3
  out=$(lock env BOSSMAN_MERGE_CHECK=1 CHECK_ALL_SLOTS=1) || fail "merge wait: expected success, got: $out"
  grep -q "waiting for a free check slot" <<<"$out" || fail "merge wait: no queue message: $out"
  grep -q "slot taken, running the checks" <<<"$out" || fail "merge wait: no start marker: $out"
  wait "$h1"

  # BOS-591: an old copy of the script at the head of the line (no version lines, a live pid, ahead of everyone) with every
  # slot free must not jam the line: a hand-run waiter that sees the line stand still takes the slot after the stall time.
  rm -rf "$t/lock.queue"; mkdir -p "$t/lock.queue"
  echo /old >"$t/lock.queue/0-1000000000000000000-$$"
  rc=0; out=$(lock env CHECK_ALL_STALL_AFTER=2 timeout 60) || rc=$?
  [ "$rc" = 0 ] || fail "stalled head: expected the waiter to get in, got rc $rc: $out"
  grep -q "line stood still" <<<"$out" || fail "stalled head: no stall message: $out"
  # ...but not while a slot is held (the line is just busy), and not before the stall time.
  hold 1 3600; h1=$!; hold 2 3600; h2=$!; sleep 0.3
  rc=0; out=$(lock env CHECK_ALL_STALL_AFTER=1 CHECK_ALL_LOCK_WAIT=3 BOSSMAN_MERGE_CHECK=1) || rc=$?
  [ "$rc" = 75 ] || fail "busy slot: the stall rule must not take a held slot, got rc $rc: $out"
  kill "$h1" "$h2" 2>/dev/null || true; wait "$h1" "$h2" 2>/dev/null || true
  # An entry from an older runner boot is dropped; one with the same boot stays.
  rm -rf "$t/lock.queue"; mkdir -p "$t/lock.queue"
  printf '/x\nrules=2\nboot=oldboot\n' >"$t/lock.queue/0-1000000000000000000-$$"
  printf '/x\nrules=2\nboot=thisboot\n' >"$t/lock.queue/0-1000000000000000001-$$"
  hold 1 3600; h1=$!; hold 2 3600; h2=$!; sleep 0.3
  rc=0; out=$(lock env CHECK_ALL_BOOT_ID=thisboot BOSSMAN_MERGE_CHECK=1 CHECK_ALL_LOCK_WAIT=2 CHECK_ALL_SLOTS=1) || rc=$?
  grep -q "place 2 of 2" <<<"$out" || fail "older boot: expected place 2 of 2 (old-boot entry dropped, same-boot kept): $out"
  [ ! -e "$t/lock.queue/0-1000000000000000000-$$" ] || fail "older boot: entry not dropped"
  # An old copy of the script (older rules) finds a newer entry and leaves with exit 75, telling the user to merge origin/main.
  rm -f "$t"/lock.queue/*; printf '/x\nrules=99\nboot=thisboot\n' >"$t/lock.queue/0-1000000000000000000-$$"
  rc=0; out=$(lock env CHECK_ALL_BOOT_ID=thisboot) || rc=$?
  [ "$rc" = 75 ] || fail "older rules: expected exit 75, got $rc: $out"
  grep -q "merge origin/main" <<<"$out" || fail "older rules: no 'merge origin/main' message: $out"
  [ "$(find "$t/lock.queue" -type f | wc -l)" = 1 ] || fail "older rules: leaving waiter kept its queue entry"
  rm -rf "$t/lock.queue"
  kill "$h1" "$h2" 2>/dev/null || true; wait "$h1" "$h2" 2>/dev/null || true

  # Queue order: a merge check that arrives later goes ahead of a hand-run check; hand-run checks keep their order.
  rm -rf "$t/lock.queue"; hold 1 3600; h1=$!; hold 2 3600; h2=$!; sleep 0.3
  ( lock env >"$t/hand1.out"; date +%s%N >"$t/hand1.at" ) & hand1=$!
  waitq 1   # each check is in the queue before the next starts, so the order is the one asserted
  ( lock env CHECK_ALL_FOLDER=other >"$t/hand2.out"; date +%s%N >"$t/hand2.at" ) & hand2=$!
  waitq 2
  ( lock env BOSSMAN_MERGE_CHECK=1 CHECK_ALL_LOCK_WAIT=20 >"$t/merge.out"; date +%s%N >"$t/merge.at" ) & merge=$!
  waitq 3; kill "$h1" "$h2" 2>/dev/null || true
  wait "$h1" "$h2" "$hand1" "$hand2" "$merge"
  for f in hand1 hand2 merge; do grep -q "lock held" "$t/$f.out" || fail "queue: $f did not get a slot: $(cat "$t/$f.out")"; done
  grep -q "place [23] of [23]" "$t/hand2.out" || fail "queue: no place shown: $(cat "$t/hand2.out")"
  [ "$(cat "$t/merge.at")" -le "$(cat "$t/hand1.at")" ] || fail "hand-run check got in ahead of the merge check"
  [ "$(cat "$t/hand1.at")" -le "$(cat "$t/hand2.at")" ] || fail "hand-run checks got in out of order"
  [ -z "$(ls "$t/lock.queue" 2>/dev/null)" ] || fail "queue entries left behind"

  # A waiter that died drops out of the queue instead of blocking those behind it.
  mkdir -p "$t/lock.queue"; : >"$t/lock.queue/1-0000000000000000001-999999"
  hold 1 2; h1=$!; hold 2 2; h2=$!; sleep 0.3
  out=$(lock env) || fail "dead waiter: expected success, got: $out"
  grep -q "lock held" <<<"$out" || fail "dead waiter blocked the queue: $out"
  wait "$h1" "$h2"

  # No recorded pair means one slot: with slot 1 busy a second check waits (merge check gives up), even though slot 2 is free.
  rm -f "$t/proof"
  hold 1 3; h1=$!; sleep 0.3
  rc=0; out=$(lock env BOSSMAN_MERGE_CHECK=1 CHECK_ALL_LOCK_WAIT=1) || rc=$?
  [ "$rc" = 75 ] || fail "default slots: expected one slot (exit 75), got $rc: $out"
  wait "$h1"

  # A queue entry nobody has touched for 2 h is dropped even when its pid is alive (a reused pid of a killed waiter).
  mkdir -p "$t/lock.queue"; : >"$t/lock.queue/1-1000000000000000000-$$"; touch -d "3 hours ago" "$t/lock.queue/1-1000000000000000000-$$"
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

  # Agents can write the queue folder (BOS-321 review). A merge-priority entry dated an hour ahead, with a live pid,
  # must not keep its place: a negative age used to pass the 2-hour prune and keep every hand-run check behind it.
  rm -rf "$t/lock.queue"; mkdir -p "$t/lock.queue"
  future="$t/lock.queue/0-$(($(date +%s) + 3600))000000000-$$"; : >"$future"
  hold 1 2; h1=$!; sleep 0.3
  rc=0; out=$(lock env CHECK_ALL_LOCK_WAIT=6) || rc=$?
  [ "$rc" = 0 ] || fail "future-dated entry: a hand-run check expected to get in ahead of it, got $rc: $out"
  [ ! -e "$future" ] || fail "future-dated queue entry was not removed"
  wait "$h1"

  # A flood of live-looking entries must not stall the queue: one pass over 5000 used to take 13.6 s.
  rm -rf "$t/lock.queue"; mkdir -p "$t/lock.queue"
  # Baseline: the same call on an empty queue, so the time check-all takes to reach the lock (slow on a busy runner) cancels out.
  b0=$SECONDS; lock env BOSSMAN_MERGE_CHECK=1 CHECK_ALL_LOCK_WAIT=5 >/dev/null 2>&1 || true; base=$((SECONDS - b0))
  now_ns=$(date +%s%N)
  for ((i = 0; i < 5000; i++)); do : >"$t/lock.queue/1-$((now_ns + i))-$$"; done
  began=$SECONDS
  rc=0; out=$(lock env BOSSMAN_MERGE_CHECK=1 CHECK_ALL_LOCK_WAIT=5) || rc=$?
  if [ "$rc" != 0 ] || ! grep -q "lock held" <<<"$out"; then fail "flooded queue: merge check didn't get in, got $rc: $out"; fi
  [ $((SECONDS - began)) -le $((base + 3)) ] || fail "flooded queue: took $((SECONDS - began)) s to get a free slot (empty queue: $base s)"
  # A hand-run check behind the flood sees a place past the scan, and waits.
  rc=0; out=$(lock env CHECK_ALL_LOCK_WAIT=2) || rc=$?
  grep -q "place 201 of 200" <<<"$out" || fail "flooded queue: hand-run check's place: $out"
  rm -rf "$t/lock.queue"

  # A check inside an agent's fence (BOS-321) keeps another session's place: it can't signal that session
  # (Landlock ABI 6 scoping), so a kill -0 test would wrongly drop the entry as dead and jump the queue.
  fence="$here/../apps/runner/src/fence/landlock.pl"
  if command -v perl >/dev/null && [ "$(perl "$fence" --probe | sed -n 's/.*"abi":\([0-9]*\).*/\1/p')" -ge 6 ]; then
    rm -rf "$t/lock.queue"; mkdir -p "$t/lock.queue"
    sleep 3600 & waiter=$!
    : >"$t/lock.queue/0-$(date +%s%N)-$waiter"
    hold 1 3; h1=$!; sleep 0.3
    rc=0
    out=$(perl "$fence" --ro / --rw "$t" --rwfile /dev/null -- bash -c 'cd "$1" && TMPDIR="$3" PATH="$2:$PATH" CHECK_ALL_LOCK="$3/lock" CHECK_ALL_STOP_AFTER_LOCK=1 CHECK_ALL_QUEUE_REPORT=1 CHECK_ALL_PAIR_PROOF="$3/proof" BOSSMAN_MERGE_CHECK=1 CHECK_ALL_LOCK_WAIT=2 ./scripts/check-all.sh 2>&1' \
      _ "$here/.." "$t/bin" "$t") || rc=$?
    [ "$rc" = 75 ] || fail "fenced check: expected to wait behind the other session (exit 75), got $rc: $out"
    grep -q "place 2 of 2" <<<"$out" || fail "fenced check: the other session's place was dropped: $out"
    compgen -G "$t/lock.queue/0-*-$waiter" >/dev/null || fail "fenced check removed a live session's queue entry"
    kill "$waiter" "$h1" 2>/dev/null || true; wait "$waiter" "$h1" 2>/dev/null || true
  else
    echo "check-all.test.sh: Landlock ABI 6 missing, fenced queue case skipped"
  fi

  # BOS-558, fair line. One slot for these cases.
  echo 1 >"$t/proof"
  # Ageing: a hand-run check that has waited CHECK_ALL_AGE_AFTER is served before merge checks queued after it. A merge
  # check (a live process that never takes the slot, standing for a steady stream of them) sits ahead of it in the name order.
  rm -rf "$t/lock.queue" "$t/lock.slotlog"; mkdir -p "$t/lock.queue"
  sleep 120 & mproc=$!
  hold 1 3600; h1=$!; sleep 0.3
  # Young hand-run check, merge check queued: the merge check goes first, so the hand-run check gives up without a slot.
  : >"$t/lock.queue/0-$(date +%s%N)-$mproc"
  rc=0; out=$(lock env CHECK_ALL_AGE_AFTER=3600 CHECK_ALL_LOCK_WAIT=2) || rc=$?
  [ "$rc" = 75 ] || fail "ageing: a young hand-run check should wait behind a merge check, got rc $rc: $out"
  # Aged hand-run check with a merge check that queued after it: it is first in line, and takes the slot the moment the holder lets go.
  rm -rf "$t/lock.queue"; mkdir -p "$t/lock.queue"
  ( lock env CHECK_ALL_AGE_AFTER=2 >"$t/aged.out" 2>&1 ) & a=$!
  waitq 1; sleep 3; ! grep -q "lock held" "$t/aged.out" || fail "ageing: took a busy slot"
  : >"$t/lock.queue/0-$(date +%s%N)-$mproc"
  kill "$h1" 2>/dev/null || true; wait "$h1" 2>/dev/null || true
  for _ in $(seq 300); do grep -q "lock held" "$t/aged.out" 2>/dev/null && break; sleep 0.2; done
  grep -q "lock held" "$t/aged.out" || fail "ageing: an aged hand-run check was not served ahead of a merge check: $(cat "$t/aged.out")"
  wait "$a" || true
  # Slot log: the hold above left a start and an end line naming the folder.
  grep -q " start pid=.*kind=hand slot=1 folder=" "$t/lock.slotlog" || fail "slot log: no start line: $(cat "$t/lock.slotlog" 2>&1)"
  grep -q " end pid=.*kind=hand slot=1 folder=$(cd "$here/.." && pwd -P)\$" "$t/lock.slotlog" || fail "slot log: no end line: $(cat "$t/lock.slotlog" 2>&1)"
  # One place per folder: a newer check from the same folder replaces the older one, which leaves saying so.
  rm -rf "$t/lock.queue"; hold 1 3600; h1=$!; sleep 0.3
  ( r=0; lock env >"$t/old.out" 2>&1 || r=$?; echo "$r" >"$t/old.rc" ) & o=$!
  for _ in $(seq 300); do grep -q "waiting for a free check slot" "$t/old.out" 2>/dev/null && break; sleep 0.2; done
  ( lock env >"$t/new.out" 2>&1 ) & n=$!
  for _ in $(seq 300); do [ -s "$t/old.rc" ] && break; sleep 0.2; done
  [ "$(cat "$t/old.rc" 2>/dev/null)" = 75 ] || fail "replace: older check should exit 75, got '$(cat "$t/old.rc" 2>/dev/null)': $(cat "$t/old.out")"
  grep -q "replaced by a newer check of this folder" "$t/old.out" || fail "replace: no message: $(cat "$t/old.out")"
  [ "$(find "$t/lock.queue" -type f | wc -l)" -eq 1 ] || fail "replace: want one queue place, got: $(ls "$t/lock.queue")"
  kill "$h1" 2>/dev/null || true; wait "$h1" 2>/dev/null || true
  for _ in $(seq 300); do grep -q "lock held" "$t/new.out" 2>/dev/null && break; sleep 0.2; done
  grep -q "lock held" "$t/new.out" || fail "replace: the newer check never got the slot: $(cat "$t/new.out")"
  wait "$n" "$o" || true
  # BOS-613 (a): an aged hand-run entry never beats an OLDER merge check. The merge entry is queued first, the hand-run check
  # ages past CHECK_ALL_AGE_AFTER behind it; when the slot frees it must still wait (today's code let it jump the merge check).
  rm -rf "$t/lock.queue"; mkdir -p "$t/lock.queue"; hold 1 3600; h1=$!; sleep 0.3
  : >"$t/lock.queue/0-$(date +%s%N)-$mproc"
  ( lock env CHECK_ALL_AGE_AFTER=1 CHECK_ALL_LOCK_WAIT=8 >"$t/older.out" 2>&1 ) & a=$!
  waitq 2; sleep 3
  kill "$h1" 2>/dev/null || true; wait "$h1" 2>/dev/null || true
  sleep 3
  ! grep -q "lock held" "$t/older.out" || fail "BOS-613 (a): an aged hand-run check went ahead of an older merge check: $(cat "$t/older.out")"
  wait "$a" || true
  # BOS-613 (b): two slots, a merge check waiting, one hand-run check running: a second hand-run check waits, even aged and
  # even though it queued before the merge check. Once the running hand-run check ends the cap lifts and it goes.
  echo 2 >"$t/proof"; rm -rf "$t/lock.queue" "$t"/lock.holder.*
  hold 1 3600; h1=$!; hold 2 3600; h2=$!; sleep 0.3
  echo "$h1 $(date +%s) hand" >"$t/lock.holder.1"
  ( lock env CHECK_ALL_AGE_AFTER=1 >"$t/cap.out" 2>&1 ) & a=$!
  waitq 1; sleep 3
  : >"$t/lock.queue/0-$(date +%s%N)-$mproc"
  kill "$h2" 2>/dev/null || true; wait "$h2" 2>/dev/null || true
  sleep 3
  ! grep -q "lock held" "$t/cap.out" || fail "BOS-613 (b): a second hand-run check took a slot while a merge check waited: $(cat "$t/cap.out")"
  kill "$h1" 2>/dev/null || true; wait "$h1" 2>/dev/null || true
  for _ in $(seq 300); do grep -q "lock held" "$t/cap.out" 2>/dev/null && break; sleep 0.2; done
  grep -q "lock held" "$t/cap.out" || fail "BOS-613 (b): the cap did not lift when the running hand-run check ended: $(cat "$t/cap.out")"
  wait "$a" || true
  rm -f "$t"/lock.holder.*
  kill "$mproc" 2>/dev/null || true; wait "$mproc" 2>/dev/null || true
  echo "A=600s B=640s no OOM" >"$t/proof"

  # The retry budget counts from the slot-taken time, not from before the queue wait (P13 Q4). A check that waits
  # longer than the budget, then hits EAGAIN, is still retried; measured from before the wait it was never retried.
  : >"$t/count"; export COUNT="$t/count"
  rc=0; ( cd "$here/.." && CHECK_ALL_LOCK="$t/rlock" CHECK_ALL_PAIR_PROOF="$t/rproof" BOSSMAN_CHECK_BUDGET_SECONDS=15 CHECK_ALL_QUEUE_TEST_SLEEP=16 BOSSMAN_CHECK_BODY='echo x >>"$COUNT"; echo "Error: spawn EAGAIN"; exit 3' ./scripts/check-all.sh >"$t/budget.out" 2>&1 ) || rc=$?
  [ "$rc" -eq 3 ] || fail "budget after queue wait: rc $rc, want 3: $(cat "$t/budget.out")"
  [ "$(runs)" -eq 3 ] || fail "budget after queue wait: ran $(runs) times, want 3 (a long wait must not use up the retry budget)"
  # A signal leaves a trace and frees the queue place: the output, the stored log and the result store get "killed by signal <name>",
  # the exit is non-zero, and the check's queue entry is gone (before, a signalled check vanished without a word).
  if command -v git >/dev/null; then
    git -C "$repo" checkout -q -- .  # a clean tree, so a result is stored
    for sig in TERM INT HUP; do
      # Hold the slot until we kill the holder, not for a fixed few seconds: under load the check can take longer
      # than the hold to reach its wait loop (the first "waiting" line comes after a slot scan), and a hold that
      # expired would let the check take the slot and run, so the signal arrived too late and the check died on its
      # own missing-file error instead of the trap (BOS-345 merge check, 2 Nov).
      rm -rf "$t/ksto" "$t/lock.queue" "$t/kill.out" "$t/kill.pid"; hold 1 3600; h1=$!; sleep 0.3
      ( cd "$repo" && PATH="$t/bin:$PATH" CHECK_ALL_LOCK="$t/lock" CHECK_ALL_QUEUE_REPORT=1 CHECK_ALL_PAIR_PROOF="$t/none" BOSSMAN_CHECK_STORE="$t/ksto" \
          setsid env --default-signal=HUP,INT,TERM bash -c 'echo $$ >"$1"; exec ./scripts/check-all.sh' _ "$t/kill.pid" >"$t/kill.out" 2>&1 ) & k=$!
      # The queue entry is written before the wait loop, so wait on it (not on the printed line, which the slot
      # scan can delay); then require the "waiting" line before signalling, so the check is provably waiting.
      for _ in $(seq 150); do [ -n "$(ls "$t/lock.queue" 2>/dev/null)" ] && grep -q "waiting for a free check slot" "$t/kill.out" 2>/dev/null && break; sleep 0.2; done
      [ -n "$(ls "$t/lock.queue" 2>/dev/null)" ] || fail "kill $sig: check never queued: $(cat "$t/kill.out")"
      grep -q "waiting for a free check slot" "$t/kill.out" || fail "kill $sig: check never reached its wait loop: $(cat "$t/kill.out")"
      kill -s "$sig" "$(cat "$t/kill.pid")"
      rc=0; wait "$k" || rc=$?
      [ "$rc" -ne 0 ] || fail "kill $sig: exit 0"
      grep -q "killed by signal $sig" "$t/kill.out" || fail "kill $sig: no line in the output: $(cat "$t/kill.out")"
      grep -q "killed by signal $sig" "$t"/ksto/*.log || fail "kill $sig: no line in the stored log"
      grep -q '"status":"killed"' "$t"/ksto/*.json || fail "kill $sig: no result recorded"
      [ -z "$(ls "$t/lock.queue" 2>/dev/null)" ] || fail "kill $sig: queue place not freed: $(ls "$t/lock.queue")"
      kill "$h1" 2>/dev/null || true; wait "$h1" 2>/dev/null || true
    done
  fi
else
  echo "check-all.test.sh: flock missing, slot cases skipped"
fi
echo "check-all.test.sh: ok"
