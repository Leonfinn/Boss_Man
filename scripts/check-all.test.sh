#!/usr/bin/env bash
# Checks check-all.sh's retry logic with a stub in place of the real checks (BOSSMAN_CHECK_BODY).
# shellcheck disable=SC2016,SC2030,SC2031  # stub bodies expand later, inside the child; web_tests cases set env in their own subshells
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
t="$(mktemp -d)"; trap 'rm -rf "$t"' EXIT
fail() { echo "FAIL: $*"; exit 1; }
# check-all.sh runs this inside its own child, so drop the markers that would switch the retry loop off
unset BOSSMAN_CHECK_CHILD BOSSMAN_CHECK_ATTEMPTS BOSSMAN_CHECK_BUDGET_SECONDS BOSSMAN_CHECK_BODY
export BOSSMAN_CHECK_RETRY_SECONDS=0 BOSSMAN_CHECK_STORE=off
# Also drop the merge gate's and user's settings, which would change what the cases below mean. check-all.sh sets CHILD for its child; if we run inside a check-all run the stubbed runs must still go through the retry loop.
unset BOSSMAN_CHECK_CHILD BOSSMAN_MERGE_CHECK BOSSMAN_CHECK_FORCE CHECK_ALL_SLOTS CHECK_ALL_LOCK_WAIT CLAUDECODE BOSSMAN_AGENT_SESSION CHECK_ALL_FORCE
# The runner's shared check-slot.sh (BOS-614) would stand in for the copy under test here; the cases below test this branch's.
unset BOSSMAN_CHECK_SLOT BOSSMAN_CHECK_SLOT_HELD CHECK_ALL_PRE_DONE
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
run 3 3 "agent that could not start under load retried (BOS-965)" 'echo x >>"$COUNT"; echo "Error: The run ended with an error: Couldn'"'"'t start claude-code-acp: x (EAGAIN)"; exit 3'
run 3 1 "a plain run-ended error is not retried (BOS-965)" 'echo x >>"$COUNT"; echo "Error: The run ended with an error: Couldn'"'"'t set up the agent'"'"'s skills"; exit 3'
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

# A ticket's kept scratch (BOSSMAN_SCRATCH, BOS-592): the whole log of the run is kept there, the previous one as .previous,
# and a failed run's log is kept too. Written in place when the folder is writable; a fenced run that can't write it puts the
# log in /tmp under a kept name, which the runner moves into the scratch at its next start.
scratch_case() { # scratch_case <label> <scratch dir> <stub body> <expected rc>
  local label=$1 dir=$2 body=$3 want=$4 rc=0
  mkdir -p "$dir"
  (cd "$here/.." && env CHECK_ALL_LOCK="$t/scl" CHECK_ALL_PAIR_PROOF="$t/scp" BOSSMAN_CHECK_STORE=off BOSSMAN_SCRATCH="$dir" BOSSMAN_TICKET="${BOSSMAN_TICKET_FOR_CASE:-11111111-1111-4111-8111-111111111111}" BOSSMAN_CHECK_BODY="$body" ./scripts/check-all.sh >"$t/out" 2>&1) || rc=$?
  [ "$rc" = "$want" ] || fail "$label: rc $rc, want $want: $(cat "$t/out")"
}
scratch_case "scratch: a passing run" "$t/scratch.own" 'echo a step of output' 0
[ -s "$t/scratch.own/check-all.log" ] || fail "scratch: no log in the scratch: $(cat "$t/out")"
grep -q "a step of output" "$t/scratch.own/check-all.log" || fail "scratch: the log misses the run's output: $(cat "$t/scratch.own/check-all.log")"
grep -q "check-all: finished .* (exit 0)" "$t/scratch.own/check-all.log" || fail "scratch: the log is not marked finished"
scratch_case "scratch: a failing run" "$t/scratch.own" 'echo the failure; exit 3' 3
[ -s "$t/scratch.own/check-all.log" ] || fail "scratch: a failing run left no log: $(cat "$t/out")"
grep -q "the failure" "$t/scratch.own/check-all.log" || fail "scratch: a failure's log misses its output"
grep -q "(exit 3)" "$t/scratch.own/check-all.log" || fail "scratch: a failure's log is not marked with its exit"
grep -q "a step of output" "$t/scratch.own/check-all.log.previous" || fail "scratch: the previous run's log is not kept: $(ls "$t"/scratch.own)"
# A fenced run can't write the scratch, but can write /tmp: the log waits there under a kept name, for the runner to move in.
mkdir -p "$t/scratch.denied"; chmod 555 "$t/scratch.denied"
# A ticket id of its own for this run, so no leftover or parallel run shares the /tmp file name.
tid="$(printf '%08x-%04x-4%03x-8%03x-%012x' "$RANDOM$RANDOM" "$$" "$RANDOM" "$RANDOM" "$RANDOM$RANDOM$RANDOM" | cut -c1-36)"
keep="/tmp/bossman-scratch-$tid.log"
# -w says yes for a fenced /tmp that still refuses a write, so probe with a real write.
if [ ! -w "$t/scratch.denied" ] && : 2>/dev/null >"/tmp/bossman-probe-$tid" && rm -f "/tmp/bossman-probe-$tid"; then
  BOSSMAN_TICKET_FOR_CASE=$tid
  scratch_case "scratch: a run that can't write it" "$t/scratch.denied" 'echo through the temp folder' 0
  grep -q "through the temp folder" "$keep" || fail "scratch: no /tmp log for a fenced run: $(cat "$t/out")"
  grep -q "check-all: finished .* (exit 0)" "$keep" || fail "scratch: the /tmp log is not marked finished"
  rm -f "$keep"
  # The kept name already holds a file the run can't write (another user's, or read-only): the run still passes and its log is kept under another name.
  : >"$keep"; chmod 444 "$keep"
  if [ ! -w "$keep" ]; then
    scratch_case "scratch: kept /tmp name not writable" "$t/scratch.denied" 'echo beside the taken name' 0
    # shellcheck disable=SC2144
    grep -lq "beside the taken name" /tmp/bossman-scratch-"$tid".*.log || fail "scratch: no fallback log beside a taken name: $(cat "$t/out")"
    rm -f /tmp/bossman-scratch-"$tid".*.log
  fi
  rm -f "$keep"
fi
chmod 755 "$t/scratch.denied"

# The result store: a pass is kept and reused on identical content, the merge gate never reuses it, failures are not reused.
# Needs a clean git checkout, so test in a scratch repo holding a copy of the script.
if command -v git >/dev/null; then
  repo="$t/repo"; mkdir -p "$repo/scripts"; cp "$here/check-all.sh" "$here/check-slot.sh" "$repo/scripts/"
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
  # BOS-415: the per-step times printed by the run are stored in the result's "steps" object, in order.
  rm -f "$store"/*.json "$store"/*.log
  cached 0 1 "store: step times" 'echo x >>"$COUNT"; echo "check-all: step typecheck:server took 12s (exit 0, at 10:00:00 UTC)"; echo "check-all: step test:server took 345s (exit 0, at 10:06:00 UTC)"' env
  grep -q '"steps":{"typecheck:server":12,"test:server":345}' "$store"/*.json || fail "store: step times not recorded: $(cat "$store"/*.json)"
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
    # BOS-674: without scripts/check-threads.mjs beside it (this copy) the budget falls back to 2 instead of failing the run.
    grep -q "CPU budget 2 threads" "$t/out" || fail "no fallback CPU budget: $(cat "$t/out")"
  fi
  # BOS-674: one CPU budget reaches what runs in the slot (check-quick's heavy phase, queued vitest runs): set, or this
  # slot's share as scripts/check-threads.mjs works it out from the slot count in the proof file.
  budget() { (cd "$here/.." && env -u BOSSMAN_CHECK_THREADS -u GOMAXPROCS -u RAYON_NUM_THREADS -u TOKIO_WORKER_THREADS -u BOSSMAN_CHECK_SLOTS \
      CHECK_ALL_LOCK="$t/tlock" CHECK_ALL_PAIR_PROOF="$t/tproof" "$@" \
      CHECK_ALL_SLOT_COMMAND='echo "got $BOSSMAN_CHECK_THREADS $GOMAXPROCS $RAYON_NUM_THREADS $TOKIO_WORKER_THREADS"' ./scripts/check-all.sh 2>&1); }
  budget BOSSMAN_CHECK_THREADS=3 | grep -qx "got 3 3 3 3" || fail "set budget not passed on: $(budget BOSSMAN_CHECK_THREADS=3)"
  budget BOSSMAN_CHECK_THREADS=3 GOMAXPROCS=1 | grep -qx "got 3 1 3 3" || fail "a caller's GOMAXPROCS is not kept"
  echo 3 >"$t/tproof"
  want=$(env -u BOSSMAN_CHECK_THREADS BOSSMAN_CHECK_SLOTS=3 node "$here/check-threads.mjs")
  budget | grep -qx "got $want $want $want $want" || fail "3-slot budget is not $want: $(budget)"
  rm -f "$t/tproof"
  mkdir "$t/bin"; printf '#!/bin/sh\nexit 0\n' >"$t/bin/pnpm"; cp "$t/bin/pnpm" "$t/bin/node"; chmod +x "$t/bin/pnpm" "$t/bin/node"
  lock() { (cd "$here/.." && PATH="$t/bin:$PATH" CHECK_ALL_LOCK="$t/lock" CHECK_ALL_STOP_AFTER_LOCK=1 CHECK_ALL_QUEUE_REPORT=1 CHECK_ALL_PAIR_PROOF="$t/proof" "$@" ./scripts/check-all.sh 2>&1); }
  # A hold starts counting its seconds only once a waiter has queued behind it (a queue entry newer than the hold),
  # so no case depends on how long check-all takes to reach the lock under load (BOS-563). Hold 3600 and kill for "until released".
  hold() { local st="$t/stamp.$1.$RANDOM"; : >"$st"; ( exec 8>"$t/lock.slot.$1"; flock 8; for _ in $(seq 1500); do [ -n "$(find "$t/lock.queue" -type f -newer "$st" 2>/dev/null | head -1)" ] && break; sleep 0.1; done; exec sleep "$2" ) & }
  waitq() { for _ in $(seq 1500); do [ "$(find "$t/lock.queue" -type f 2>/dev/null | wc -l)" -ge "$1" ] && return 0; sleep 0.1; done; return 1; }

  # Server-queued job (DR-003): no lock files are touched even while a slot is held, and it does not wait.
  hold 1 3; holder=$!; sleep 0.3
  rc=0; out=$(lock env BOSSMAN_CHECK_NO_LOCK=1 BOSSMAN_MERGE_CHECK=1 CHECK_ALL_LOCK_WAIT=1) || rc=$?
  [ "$rc" = 0 ] || fail "no-lock mode: expected exit 0 with a busy slot, got $rc: $out"
  grep -q "no lock files" <<<"$out" || fail "no-lock mode: not announced: $out"
  [ ! -e "$t/lock.queue" ] || [ -z "$(ls "$t/lock.queue" 2>/dev/null)" ] || fail "no-lock mode: queue entry written"
  kill "$holder" 2>/dev/null || true; wait "$holder" 2>/dev/null || true

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
  # Slot log: the hold above left a start and an end line naming the check kind, the checked tree (BOS-666) and the folder.
  # The tree is this checkout's, with "-dirty" when it has uncommitted changes (as it may while the tests are written).
  stree="$(git -C "$here/.." rev-parse 'HEAD^{tree}')"
  grep -Eq " start pid=.*kind=hand slot=1 check=full tree=$stree(-dirty)? folder=" "$t/lock.slotlog" || fail "slot log: no start line: $(cat "$t/lock.slotlog" 2>&1)"
  grep -Eq " end pid=.*kind=hand slot=1 check=full tree=$stree(-dirty)? folder=$(cd "$here/.." && pwd -P)\$" "$t/lock.slotlog" || fail "slot log: no end line: $(cat "$t/lock.slotlog" 2>&1)"
  # check-quick.sh names its slot hold check=quick; an unknown kind falls back to full.
  rm -rf "$t/lock.queue" "$t/lock.slotlog"; mkdir -p "$t/lock.queue"  # drop the stand-in merge entry, or these holds wait behind it
  lock env CHECK_ALL_CHECK_KIND=quick >/dev/null || fail "quick-kind hold failed"
  grep -Eq " start pid=.* check=quick tree=$stree(-dirty)? folder=" "$t/lock.slotlog" || fail "slot log: no check=quick line: $(cat "$t/lock.slotlog" 2>&1)"
  rm -f "$t/lock.slotlog"; lock env 'CHECK_ALL_CHECK_KIND=x y' >/dev/null || fail "odd-kind hold failed"
  grep -Eq " start pid=.* check=full tree=" "$t/lock.slotlog" || fail "slot log: odd kind not replaced by full: $(cat "$t/lock.slotlog" 2>&1)"
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
  # Only hand-run entries are ever replaced: a "replaced" marker for a waiting merge check's pid must not bounce it.
  rm -rf "$t/lock.queue" "$t/mc.out"; hold 1 3600; h1=$!; sleep 0.3
  ( lock env BOSSMAN_MERGE_CHECK=1 >"$t/mc.out" 2>&1 ) & mc=$!
  for _ in $(seq 300); do ls "$t/lock.queue"/0-* >/dev/null 2>&1 && grep -q "waiting for a free check slot" "$t/mc.out" 2>/dev/null && break; sleep 0.2; done
  mqe=""; for mqf in "$t"/lock.queue/0-*; do [ -e "$mqf" ] && mqe=${mqf##*/} && break; done; [ -n "$mqe" ] || fail "merge marker: merge check never queued: $(cat "$t/mc.out")"
  : >"$t/lock.replaced.${mqe##*-}"
  sleep 2
  kill -0 "$mc" 2>/dev/null || fail "merge marker: a merge check left the line on a replaced marker: $(cat "$t/mc.out")"
  ! grep -q "replaced by a newer check" "$t/mc.out" || fail "merge marker: merge check was replaced: $(cat "$t/mc.out")"
  pkill -P "$mc" 2>/dev/null || true; kill "$mc" 2>/dev/null || true; wait "$mc" 2>/dev/null || true
  rm -f "$t"/lock.replaced.*
  kill "$h1" 2>/dev/null || true; wait "$h1" 2>/dev/null || true
  # BOS-613 (a): an aged hand-run entry never beats an OLDER merge check. The merge entry is queued first, the hand-run check
  # ages past CHECK_ALL_AGE_AFTER behind it; when the slot frees it must still wait (today's code let it jump the merge check).
  rm -rf "$t/lock.queue"; mkdir -p "$t/lock.queue"; hold 1 3600; h1=$!; sleep 0.3
  : >"$t/lock.queue/0-$(date +%s%N)-$mproc"
  ( lock env CHECK_ALL_AGE_AFTER=1 CHECK_ALL_LOCK_WAIT=8 >"$t/older.out" 2>&1 ) & a=$!
  waitq 2; sleep 2
  kill "$h1" 2>/dev/null || true; wait "$h1" 2>/dev/null || true
  sleep 2
  ! grep -q "lock held" "$t/older.out" || fail "BOS-613 (a): an aged hand-run check went ahead of an older merge check: $(cat "$t/older.out")"
  wait "$a" || true
  # BOS-613 (b): two slots, a merge check waiting, one hand-run check running: a second hand-run check waits, even aged and
  # even though it queued before the merge check. Once the running hand-run check ends the cap lifts and it goes.
  echo 2 >"$t/proof"; rm -rf "$t/lock.queue" "$t"/lock.holder.*
  hold 1 3600; h1=$!; hold 2 3600; h2=$!; sleep 0.3
  echo "$h1 $(date +%s) hand" >"$t/lock.holder.1"
  ( lock env CHECK_ALL_AGE_AFTER=1 >"$t/cap.out" 2>&1 ) & a=$!
  waitq 1; sleep 2
  : >"$t/lock.queue/0-$(date +%s%N)-$mproc"
  kill "$h2" 2>/dev/null || true; wait "$h2" 2>/dev/null || true
  sleep 2
  ! grep -q "lock held" "$t/cap.out" || fail "BOS-613 (b): a second hand-run check took a slot while a merge check waited: $(cat "$t/cap.out")"
  kill "$h1" 2>/dev/null || true; wait "$h1" 2>/dev/null || true
  for _ in $(seq 300); do grep -q "lock held" "$t/cap.out" 2>/dev/null && break; sleep 0.2; done
  grep -q "lock held" "$t/cap.out" || fail "BOS-613 (b): the cap did not lift when the running hand-run check ended: $(cat "$t/cap.out")"
  wait "$a" || true
  rm -f "$t"/lock.holder.*
  kill "$mproc" 2>/dev/null || true; wait "$mproc" 2>/dev/null || true
  echo "A=600s B=640s no OOM" >"$t/proof"

  # BOS-614: one copy of the queue rules. "old.sh" stands for a branch's check-all.sh with older rules: it queues in
  # $CHECK_ALL_LOCK and waits while anyone else is in that line (the way a pre-BOS-558 copy waited on the merge checks).
  echo 1 >"$t/proof"; rm -rf "$t/lock.queue" "$t"/lock.holder.*
  cat >"$t/old.sh" <<'OLD'
q="$CHECK_ALL_LOCK.queue"; mkdir -p "$q"; me="$q/0-$(date +%s%N)-$$"; printf '/old\n' >"$me"; trap 'rm -f "$me"' EXIT
while [ -n "$(find "$q" -type f ! -path "$me" | head -1)" ]; do sleep 0.2; done
exec 7>"$CHECK_ALL_LOCK.slot.1"; flock 7; echo "old copy: ran its checks"
OLD
  slot() { (cd "$here/.." && PATH="$t/bin:$PATH" CHECK_ALL_LOCK="$t/lock" CHECK_ALL_QUEUE_REPORT=1 CHECK_ALL_PAIR_PROOF="$t/proof" CHECK_ALL_STALL_AFTER=600 "$@" 2>&1); }
  # Before: the old copy in the shared line with a new-rules waiter behind a busy slot never goes, even once the slot frees.
  hold 1 3600; h1=$!; sleep 0.3
  ( lock env CHECK_ALL_STALL_AFTER=600 >"$t/new1.out" ) & nw=$!
  waitq 1
  rc=0; out=$(cd "$here/.." && CHECK_ALL_LOCK="$t/lock" timeout 4 bash "$t/old.sh" 2>&1) || rc=$?
  [ "$rc" = 124 ] || fail "BOS-614 premise: the old copy should wait on the new waiter in a shared line, got rc $rc: $out"
  kill "$h1" 2>/dev/null || true; wait "$h1" 2>/dev/null || true; wait "$nw" || true
  # After: the merge gate wraps the branch's script in check-slot.sh. A new-rules hand-run waiter and the old-rules merge
  # check share one line with a free slot: both get through in order, well inside the stall window (600 s here).
  rm -rf "$t/lock.queue"; hold 1 3600; h1=$!; sleep 0.3
  ( lock env CHECK_ALL_STALL_AFTER=600 >"$t/new2.out"; date +%s%N >"$t/new2.at" ) & nw=$!
  waitq 1
  ( slot env BOSSMAN_MERGE_CHECK=1 bash ./scripts/check-slot.sh bash "$t/old.sh" >"$t/oldm.out"; date +%s%N >"$t/oldm.at" ) & om=$!
  waitq 2; began=$SECONDS
  kill "$h1" 2>/dev/null || true; wait "$h1" 2>/dev/null || true
  wait "$om" "$nw" || true
  [ $((SECONDS - began)) -le 60 ] || fail "BOS-614: the line took $((SECONDS - began)) s to clear"
  grep -q "old copy: ran its checks" "$t/oldm.out" || fail "BOS-614: the old-rules merge check did not run: $(cat "$t/oldm.out")"
  grep -q "lock held" "$t/new2.out" || fail "BOS-614: the new-rules waiter did not get a slot: $(cat "$t/new2.out")"
  [ "$(cat "$t/oldm.at")" -le "$(cat "$t/new2.at")" ] || fail "BOS-614: the hand-run check went ahead of the merge check"
  ! grep -q "line stood still" "$t/new2.out" "$t/oldm.out" || fail "BOS-614: got through only by the stall rule"
  [ -z "$(ls "$t/lock.queue" 2>/dev/null)" ] || fail "BOS-614: queue entries left behind: $(ls "$t/lock.queue")"
  compgen -G "$t/lock.held.*" >/dev/null && fail "BOS-614: private lock folder left behind"
  grep -q " end pid=.*kind=merge slot=1 " "$t/lock.slotlog" || fail "BOS-614: no slot-log end line for the wrapped check: $(cat "$t/lock.slotlog")"
  # check-slot.sh passes the command's exit status on.
  rc=0; slot env bash ./scripts/check-slot.sh sh -c 'exit 7' >/dev/null || rc=$?
  [ "$rc" = 7 ] || fail "BOS-614: check-slot.sh lost the command's exit status, got $rc"
  # The private lock folder is made fresh by mktemp (random name, mode 0700), not a guessable pid-based name.
  out=$(slot env bash ./scripts/check-slot.sh sh -c 'd=$(dirname "$CHECK_ALL_LOCK"); echo "$(stat -c %a "$d") ${d##*.held.}"') || fail "private folder probe failed: $out"
  out=$(printf '%s\n' "$out" | tail -n 1)
  case "$out" in "700 "??????) ;; *) fail "BOS-614: private lock folder should be mode 700 with a random name, got: $out" ;; esac
  case "${out#700 }" in *[!0-9]*) ;; *) fail "BOS-614: private lock folder name looks pid-based: $out" ;; esac
  # A new check-all.sh hands its wait to the runner's copy (BOSSMAN_CHECK_SLOT) over the one beside it...
  printf 'echo shared >>"%s"; exec bash "%s" "$@"\n' "$t/shared.used" "$here/check-slot.sh" >"$t/shared-slot.sh"
  out=$(lock env BOSSMAN_CHECK_SLOT="$t/shared-slot.sh") || fail "shared slot: expected success, got: $out"
  grep -q "lock held" <<<"$out" || fail "shared slot: not acquired: $out"
  [ "$(grep -c . "$t/shared.used" 2>/dev/null)" = 1 ] || fail "shared slot: the runner's copy was not used"
  # ...falls back to its own when that file is missing...
  out=$(lock env BOSSMAN_CHECK_SLOT="$t/missing.sh") || fail "missing shared slot: expected success, got: $out"
  grep -q "lock held" <<<"$out" || fail "missing shared slot: not acquired: $out"
  # ...and skips the wait only when the held marker names its own lock (a nested check with a lock of its own still queues).
  hold 1 3600; h1=$!; sleep 0.3
  rc=0; out=$(lock env BOSSMAN_CHECK_SLOT_HELD="$t/elsewhere" BOSSMAN_MERGE_CHECK=1 CHECK_ALL_LOCK_WAIT=1) || rc=$?
  [ "$rc" = 75 ] || fail "held marker for another lock: expected to queue (exit 75), got $rc: $out"
  kill "$h1" 2>/dev/null || true; wait "$h1" 2>/dev/null || true
  echo "A=600s B=640s no OOM" >"$t/proof"

  # The retry budget counts from the slot-taken time, not from before the queue wait (P13 Q4). A check that waits
  # longer than the budget, then hits EAGAIN, is still retried; measured from before the wait it was never retried.
  : >"$t/count"; export COUNT="$t/count"
  rc=0; ( cd "$here/.." && CHECK_ALL_LOCK="$t/rlock" CHECK_ALL_PAIR_PROOF="$t/rproof" BOSSMAN_CHECK_BUDGET_SECONDS=8 CHECK_ALL_QUEUE_TEST_SLEEP=9 BOSSMAN_CHECK_BODY='echo x >>"$COUNT"; echo "Error: spawn EAGAIN"; exit 3' ./scripts/check-all.sh >"$t/budget.out" 2>&1 ) || rc=$?
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
# web_tests (BOS-1095): a failing vitest must make the step fail, and a passing one must not. A stub pnpm stands in for vitest.
# The function is lifted out of check-all.sh so the real text is tested, not a copy.
wt="$t/web-tests"; mkdir -p "$wt/bin"
awk '/^web_tests\(\) \{/{p=1} p{print} p&&/^\}/{exit}' "$here/check-all.sh" >"$wt/fn.sh"
[ -s "$wt/fn.sh" ] || fail "web_tests: function not found in check-all.sh"
printf '%s\n' '#!/usr/bin/env bash' 'echo "stub vitest output"; exit "${STUB_VITEST_RC:-0}"' >"$wt/bin/pnpm"; chmod +x "$wt/bin/pnpm"
web_case() { # web_case <label> <stub vitest exit> <want rc>
  local rc=0
  (set -euo pipefail; export PATH="$wt/bin:$PATH" STUB_VITEST_RC=$2 BOSSMAN_CHECK_TIMES_DIR="$wt"
   self="$wt/check-all.sh"; : >"$self"
   # shellcheck disable=SC1091
   . "$wt/fn.sh"; web_tests "$wt" >"$wt/out" 2>&1) || rc=$?
  [ "$rc" -eq "$3" ] || fail "web_tests $1: rc $rc, want $3: $(cat "$wt/out")"
}
cp "$here/check-no-skips.mjs" "$wt/check-no-skips.mjs"
printf '%s' '{"numPassedTests":1,"testResults":[]}' >"$wt/vitest-web.json"
web_case "passing vitest" 0 0
web_case "failing vitest" 1 1
# With no NODE_PATH, web_tests must hand vitest npm's global folder (when it holds playwright); a set NODE_PATH stays as it is.
mkdir -p "$wt/gnm/playwright" "$wt/bin2"
printf '%s\n' '#!/usr/bin/env bash' 'echo "NODE_PATH seen: ${NODE_PATH:-none}"' >"$wt/bin2/pnpm"
printf '%s\n' '#!/usr/bin/env bash' "echo \"$wt/gnm\"" >"$wt/bin2/npm"
chmod +x "$wt/bin2/pnpm" "$wt/bin2/npm"
(set -euo pipefail; unset NODE_PATH; export PATH="$wt/bin2:$PATH" BOSSMAN_CHECK_TIMES_DIR="$wt"
 self="$wt/check-all.sh"; : >"$self"
 # shellcheck disable=SC1091
 . "$wt/fn.sh"; web_tests "$wt" >"$wt/out2" 2>&1) || fail "web_tests NODE_PATH fallback: $(cat "$wt/out2")"
grep -q "NODE_PATH seen: $wt/gnm" "$wt/out2" || fail "web_tests: no NODE_PATH fallback: $(cat "$wt/out2")"
(set -euo pipefail; export NODE_PATH=/keep/me PATH="$wt/bin2:$PATH" BOSSMAN_CHECK_TIMES_DIR="$wt"
 self="$wt/check-all.sh"; : >"$self"
 # shellcheck disable=SC1091
 . "$wt/fn.sh"; web_tests "$wt" >"$wt/out3" 2>&1) || fail "web_tests keep NODE_PATH: $(cat "$wt/out3")"
grep -q "NODE_PATH seen: /keep/me" "$wt/out3" || fail "web_tests: overwrote NODE_PATH: $(cat "$wt/out3")"
# A HOME that does not exist (a fenced job on an old runner) must not reach the browser tests: they get a home of their own,
# which is removed afterwards. A usable HOME is left alone.
printf '%s\n' '#!/usr/bin/env bash' 'echo "HOME seen: $HOME"; echo "XDG seen: ${XDG_CONFIG_HOME:-none}"' >"$wt/bin2/pnpm"
(set -euo pipefail; export HOME="$wt/no-such-home" PATH="$wt/bin2:$PATH" BOSSMAN_CHECK_TIMES_DIR="$wt"
 self="$wt/check-all.sh"; : >"$self"
 # shellcheck disable=SC1091
 . "$wt/fn.sh"; web_tests "$wt" >"$wt/out4" 2>&1) || fail "web_tests missing HOME: $(cat "$wt/out4")"
grep -q "HOME seen: " "$wt/out4" && ! grep -q "HOME seen: $wt/no-such-home" "$wt/out4" || fail "web_tests: kept an unusable HOME: $(cat "$wt/out4")"
grep -q "XDG seen: .*/.config" "$wt/out4" || fail "web_tests: no XDG_CONFIG_HOME for the missing HOME: $(cat "$wt/out4")"
mkdir -p "$wt/good-home"
(set -euo pipefail; export HOME="$wt/good-home" PATH="$wt/bin2:$PATH" BOSSMAN_CHECK_TIMES_DIR="$wt"
 self="$wt/check-all.sh"; : >"$self"
 # shellcheck disable=SC1091
 . "$wt/fn.sh"; web_tests "$wt" >"$wt/out5" 2>&1) || fail "web_tests good HOME: $(cat "$wt/out5")"
grep -q "HOME seen: $wt/good-home" "$wt/out5" || fail "web_tests: replaced a usable HOME: $(cat "$wt/out5")"
echo "check-all.test.sh: ok"
