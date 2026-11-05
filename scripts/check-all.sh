#!/usr/bin/env bash
# Everything in CI's "check" job that runs without Docker or a real Postgres, for Boss Man's
# "Before merging" command. CI still runs leader.test.ts (real Postgres) and the image job
# on pushes that touch those areas, every night, and on every pull request.
set -euo pipefail
self="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/$(basename "${BASH_SOURCE[0]}")"
cd "$(dirname "$self")/.."

# Only the merge gate runs the full check. Inside an agent session (Claude Code sets CLAUDECODE; the runner's own
# sessions may set BOSSMAN_AGENT_SESSION) a hand run is refused, because it fills the one-slot queue for hours.
# The merge gate (BOSSMAN_MERGE_CHECK, which also runs with a bare environment) and humans are unaffected;
# CHECK_ALL_FORCE=1 overrides, for when the CEO asked for a full run.
if [ -z "${BOSSMAN_CHECK_CHILD:-}" ] && [ -z "${BOSSMAN_MERGE_CHECK:-}" ] && [ -z "${CHECK_ALL_FORCE:-}" ] \
  && { [ -n "${CLAUDECODE:-}" ] || [ -n "${BOSSMAN_AGENT_SESSION:-}" ]; }; then
  echo "Full check runs at the merge gate. Run scripts/check-quick.sh for your branch instead, or set CHECK_ALL_FORCE=1 if the CEO asked you to." >&2
  exit 2
fi

# Where finished runs are kept (result + full log), keyed by the git tree of the checked-out files, so a check that
# already passed on identical content is not run again. /var/tmp survives between runs; "off" switches the store off.
STORE="${BOSSMAN_CHECK_STORE:-/var/tmp/bossman-check-results}"

# The shared runner caps processes (pids.max 1024) and other agents use most of them, so a step can die
# with "spawn EAGAIN" / "Cannot fork" through no fault of the code. Run the checks in a child and re-run
# them, after a pause, only when the failure output shows that kind of error; any other failure is final.
if [ -z "${BOSSMAN_CHECK_CHILD:-}" ]; then
  attempts="${BOSSMAN_CHECK_ATTEMPTS:-3}"
  budget="${BOSSMAN_CHECK_BUDGET_SECONDS:-1500}"  # Boss Man kills the merge check at 30 min; stay well inside it
  pause="${BOSSMAN_CHECK_RETRY_SECONDS:-30}"
  log="$(mktemp)"; began_file="$(mktemp)"; slot_at=""
  trap 'rm -f "$log" "$began_file"' EXIT

  # Only a clean checkout has a tree hash that says what was checked.
  key=""
  if [ "$STORE" != off ] && [ -z "$(git status --porcelain 2>/dev/null)" ] && key="$(git rev-parse 'HEAD^{tree}' 2>/dev/null)" && mkdir -p "$STORE" 2>/dev/null; then
    # A pass on the same tree is reused, except by Boss Man's merge gate (BOSSMAN_MERGE_CHECK): the gate always runs
    # every stage itself and never trusts a stored result. BOSSMAN_CHECK_FORCE=1 also re-runs.
    if [ -z "${BOSSMAN_MERGE_CHECK:-}" ] && [ -z "${BOSSMAN_CHECK_FORCE:-}" ] && grep -q '"status":"pass"' "$STORE/$key.json" 2>/dev/null; then
      echo "check-all: this exact content already passed ($(sed -n 's/.*"finished":"\([^"]*\)".*/\1/p' "$STORE/$key.json")); not running it again."
      echo "check-all: log $STORE/$key.log (set BOSSMAN_CHECK_FORCE=1 to run it anyway)"
      exit 0
    fi
  else
    key=""
  fi
  # A signal ends the run with a visible trace: stop the child (which frees its queue place), write the line to the
  # log and the result store, and exit non-zero. Without this a killed check just vanished and the agent waited for nothing.
  child=""
  on_signal() {
    local name=$1
    trap '' TERM INT HUP
    if [ -n "$child" ]; then kill -TERM "$child" 2>/dev/null || true; wait "$child" 2>/dev/null || true; fi
    sleep 0.2  # let tee drain before the line is added
    echo "check-all: killed by signal $name" | tee -a "$log"
    record killed "$((128 + $2))"
    exit "$((128 + $2))"
  }
  trap 'on_signal TERM 15' TERM
  trap 'on_signal INT 2' INT
  trap 'on_signal HUP 1' HUP
  # record <status> <exit code>: keep the result and the full log; a pass is what later runs reuse.
  record() {
    [ -n "$key" ] || return 0
    local dur=0
    [ -s "$began_file" ] && dur=$(( $(date +%s) - $(cat "$began_file") ))
    cp "$log" "$STORE/$key.log" 2>/dev/null || return 0
    printf '{"status":"%s","exit":%s,"tree":"%s","commit":"%s","finished":"%s","duration_seconds":%s,"merge_check":%s}\n' \
      "$1" "$2" "$key" "$(git rev-parse HEAD)" "$(date -u +%FT%TZ)" "$dur" "$([ -n "${BOSSMAN_MERGE_CHECK:-}" ] && echo true || echo false)" >"$STORE/$key.json" || return 0
    # keep the newest 50 results
    local old
    while read -r old; do rm -f "$old" "${old%.json}.log"; done < <(find "$STORE" -maxdepth 1 -name '*.json' -printf '%T@ %p\n' | sort -rn | tail -n +51 | cut -d' ' -f2-)
  }
  [ -z "$key" ] || echo "check-all: the result and log of this run will be kept in $STORE/$key.{json,log}"
  for ((n = 1; n <= attempts; n++)); do
    # Test hook: a simulated queue wait, which the fixed budget ignores (check-all.test.sh retry-budget case).
    [ "$n" -gt 1 ] || [ -z "${CHECK_ALL_QUEUE_TEST_SLEEP:-}" ] || sleep "$CHECK_ALL_QUEUE_TEST_SLEEP"
    rc=0; : >"$began_file"; attempt_start=$SECONDS
    # The child runs in the background and we wait for it, so a signal reaches the trap at once instead of after the child.
    BOSSMAN_CHECK_CHILD=1 BOSSMAN_CHECK_STORE="$STORE" CHECK_ALL_STARTED_FILE="$began_file" bash "$self" > >(tee "$log") 2>&1 &
    child=$!
    wait "$child" || rc=$?
    wait 2>/dev/null || true  # let tee finish writing the log
    # Exit 75: nothing ran (gave up waiting for a slot), so there is no result to keep.
    if [ "$rc" -eq 0 ]; then record pass 0; exit 0; fi
    # Each retry re-runs everything, so only retry if another run of this length still fits the budget.
    # The budget counts from the slot-taken time (the first non-empty $began_file), not from before the queue wait:
    # a long wait used to use it up, so a check that then hit EAGAIN was never retried.
    took=$((SECONDS - attempt_start)); began=$(cat "$began_file")
    if [ -n "$began" ]; then [ -n "$slot_at" ] || slot_at=$began; took=$(($(date +%s) - began)); fi
    if [ "$n" -lt "$attempts" ] && [ $(( $(date +%s) - ${slot_at:-$(date +%s)} + took + pause )) -le "$budget" ] && grep -qE 'spawn(Sync)? .*EAGAIN|EAGAIN: resource|Cannot fork|Resource temporarily unavailable|fork: retry' "$log"; then
      echo "check-all: attempt $n hit the runner's process limit (exit $rc); retrying in ${pause}s" >&2
      # Run the pause in the background and wait for it, so a signal reaches on_signal at once, not up to ${pause}s later.
      sleep "$pause" & pause_pid=$!; wait "$pause_pid" 2>/dev/null || true
    else
      [ "$rc" -eq 75 ] || record fail "$rc"
      exit "$rc"
    fi
  done
fi

# BOSSMAN_CHECK_BODY replaces the checks below with a stub command (for check-all.test.sh).
if [ -n "${BOSSMAN_CHECK_BODY:-}" ]; then bash -c "$BOSSMAN_CHECK_BODY"; exit; fi

# CHECK_ALL_SLOT_COMMAND (used by check-quick.sh, with BOSSMAN_CHECK_CHILD=1): wait for a slot exactly like a hand-run check,
# run that one command while holding it, and exit with its status. None of the full checks run.
if [ -z "${CHECK_ALL_SLOT_COMMAND:-}" ]; then
  pnpm install --frozen-lockfile --prefer-offline >/dev/null
  node --test scripts/*.test.mjs
  node scripts/lint-migrations.mjs
fi
# The heavy phases below peak well above 2 GB each, so only CHECK_ALL_SLOTS checks (1 until a side-by-side pair has passed, then 2) run them at once;
# the rest queue in order, merge checks first. Each slot is a lock file held until this script exits.
# A waiter prints its place and an estimated wait. Hand-run checks never give up. A merge check keeps its place for as
# long as the queue moves, and gives up (exit 75) only when it stands still: neither its place nor who holds a slot has
# changed for CHECK_ALL_STUCK_AFTER seconds (default 1 h, longer than a check runs); it then says so ("made no progress").
# CHECK_ALL_LOCK_WAIT, when set, is a hard cap on the whole wait for a merge check (exit 75, which Boss Man retries).
# The merge check queues like the rest but goes ahead of waiting hand-run checks; one already running is never interrupted.
# fd 9 is inherited by pnpm/vitest: if a timed-out check leaves children behind they keep the slot until
# they exit (tracked in the runner-cleanup ticket). Skipped where flock is missing (macOS).
# BOSSMAN_CHECK_NO_LOCK=1 (set by the runner for a server-queued job, DR-003): the server holds the slots, so this script
# touches no lock file and does not queue; it still keeps the result store.
if [ -n "${BOSSMAN_CHECK_NO_LOCK:-}" ]; then
  echo "check-all: slot taken, running the checks (the server holds the slots; no lock files)"
elif command -v flock >/dev/null; then
  LOCK=${CHECK_ALL_LOCK:-/tmp/bossman-check-all}
  # One check at a time until a measured side-by-side pair has passed: that run writes the proof file below
  # (see the Build and test note). CHECK_ALL_PAIR_TRIAL=1 lets the two measuring runs use more slots.
  PROOF=${CHECK_ALL_PAIR_PROOF:-/var/tmp/bossman-check-pair-passed}
  SLOTS=1
  if [ -s "$PROOF" ] || [ -n "${CHECK_ALL_PAIR_TRIAL:-}" ]; then SLOTS=${CHECK_ALL_SLOTS:-2}
  elif [ "${CHECK_ALL_SLOTS:-1}" -gt 1 ]; then echo "check-all: CHECK_ALL_SLOTS=$CHECK_ALL_SLOTS ignored, no passed side-by-side pair recorded in $PROOF; running one at a time"
  fi
  QDIR="$LOCK.queue"  # one file per waiting check, "<0 merge | 1 hand-run>-<time>-<pid>"; names sort into serving order
  WAIT=${CHECK_ALL_LOCK_WAIT:-0}; STUCK=0; prio=1
  if [ -n "${BOSSMAN_MERGE_CHECK:-}" ]; then prio=0; STUCK=${CHECK_ALL_STUCK_AFTER:-3600}; fi
  AGEREF="$LOCK.age.$$"  # an empty file dated 2 h ago, to tell stale queue entries by their modification time
  # An unreachable lock folder (for example outside a fenced session's grant) fails at once with a clear message,
  # never a silent wait: a slot file that cannot be opened would otherwise read as "busy" forever.
  lock_unusable() { echo "check-all: cannot use the check lock folder: $1 (set CHECK_ALL_LOCK to a writable path)" >&2; exit 2; }
  mkdir -p "$QDIR" 2>/dev/null || lock_unusable "cannot create $QDIR"
  qfile="$QDIR/$prio-$(date +%s%N)-$$"
  { : >"$qfile"; } 2>/dev/null || lock_unusable "cannot write $qfile"
  trap 'rm -f "$qfile" "$AGEREF"' EXIT
  # Killed while waiting: leave the queue and free the place for the next one at once. The parent's TERM/INT/HUP
  # trap (on_signal) then writes the "killed by signal" line and stops this child. Sleeping in the background and
  # waiting on it makes a signal act immediately instead of after the sleep ends (up to CHECK_ALL_QUEUE_REPORT).
  # A signal here runs the EXIT trap above, which removes the queue entry, then exits 143 so the parent records it.
  wait_signal() { sleep "$1" & sleep_pid=$!; wait "$sleep_pid" 2>/dev/null || true; }
  trap '[ -z "${BOSSMAN_CHECK_CHILD:-}" ] || exit 143' TERM INT HUP
  take_slot() {
    local k
    for ((k = 1; k <= SLOTS; k++)); do
      { exec 9>"$LOCK.slot.$k"; } 2>/dev/null || lock_unusable "cannot open $LOCK.slot.$k"
      # Note who holds the slot in a file of its own (every waiter's open truncates the slot file): a waiter
      # sees the queue move when this line changes. Best effort; a holder from an older script leaves none.
      if flock -n 9; then echo "$$ $(date +%s)" >"$LOCK.holder.$k" 2>/dev/null || true; return 0; fi
    done
    exec 9>&-
    return 1
  }
  # Prints "<my place> <checks waiting>", dropping queue entries whose process is gone.
  # Agents can write this folder, so it is read defensively: no subprocess per entry (5000 planted entries
  # took 13.6 s a pass with them), and only the first CHECK_ALL_QUEUE_SCAN entries in serving order count.
  # A waiter further back sees a place past the scan and keeps waiting.
  queue_place() {
    local f base qts qpid mine=0 total=0 scan=${CHECK_ALL_QUEUE_SCAN:-200} now stale=0; now=$(date +%s)
    # A live waiter touches its entry every report, so age is read from the file's modification time (a bash test,
    # no subprocess per entry), not from the name: a check that has waited more than 2 h in a long queue keeps its place.
    touch -d "@$((now - 7200))" "$AGEREF" 2>/dev/null && stale=1
    for f in "$QDIR"/*; do
      [ -e "$f" ] || continue
      # Drop malformed entries first: the folder is shared, so a name is never used in arithmetic unless it is
      # digits only, and short enough not to overflow. Then drop entries whose process is gone, older than 2 h
      # (a killed waiter whose pid was reused), or dated more than a minute ahead (planted to jump the queue).
      # "Gone" is read from /proc, not kill -0: a fenced agent may not signal other sessions (BOS-321).
      base=${f##*/}
      if ! [[ $base =~ ^[01]-([0-9]{1,19})-([0-9]{1,9})$ ]]; then rm -f "$f"; continue; fi
      qts=$((10#${BASH_REMATCH[1]} / 1000000000)); qpid=$((10#${BASH_REMATCH[2]}))
      if [ ! -d "/proc/$qpid" ] || [ $((qts - now)) -gt 60 ] || { [ "$stale" = 1 ] && [ "$f" -ot "$AGEREF" ]; }; then rm -f "$f"; continue; fi
      total=$((total + 1)); [ "$f" != "$qfile" ] || mine=$total
      if [ "$total" -ge "$scan" ]; then
        [ "$mine" -gt 0 ] || mine=$((scan + 1))
        break
      fi
    done
    echo "$mine $total"
  }
  # Average length of the last passed runs, for the wait estimate (10 minutes when there are none).
  typical_run() {
    local sum=0 n=0 d f
    if [ -d "${BOSSMAN_CHECK_STORE:-off}" ]; then
      while read -r f; do
        grep -q '"status":"pass"' "$f" || continue
        d=$(sed -n 's/.*"duration_seconds":\([0-9]*\).*/\1/p' "$f")
        if [ -n "$d" ] && [ "$((10#$d))" -gt 0 ]; then sum=$((sum + 10#$d)); n=$((n + 1)); fi
      done < <(find "$BOSSMAN_CHECK_STORE" -maxdepth 1 -name '*.json' -printf '%T@ %p\n' | sort -rn | head -n 10 | cut -d' ' -f2-)
    fi
    if [ "$n" -gt 0 ]; then echo $((sum / n)); else echo 600; fi
  }
  waited_from=$SECONDS; last_said=-1000; got=no; typical=""; stuck=no; seen=""; moved_at=$SECONDS
  while :; do
    read -r place total < <(queue_place)
    if [ "$place" -le 1 ] && take_slot; then got=yes; break; fi
    if [ "$WAIT" -gt 0 ] && [ $((SECONDS - waited_from)) -ge "$WAIT" ]; then break; fi
    # The queue moves when my place changes or a slot gets a new holder; one that stands still too long is stuck.
    if [ "$STUCK" -gt 0 ]; then
      holders=""
      for h in "$LOCK".holder.*; do
        [ -f "$h" ] || continue
        line=""; read -r line <"$h" 2>/dev/null || true
        holders="$holders|$line"
      done
      if [ "$place|$holders" != "$seen" ]; then seen="$place|$holders"; moved_at=$SECONDS; fi
      if [ $((SECONDS - moved_at)) -ge "$STUCK" ]; then stuck=yes; break; fi
    fi
    if [ $((SECONDS - last_said)) -ge "${CHECK_ALL_QUEUE_REPORT:-30}" ]; then
      { : >"$qfile"; } 2>/dev/null || true  # keep my queue entry fresh (and put it back if someone removed it)
      [ -n "$typical" ] || typical=$(typical_run)
      rounds=$(((place + SLOTS - 1) / SLOTS))
      echo "check-all: waiting for a free check slot (place $place of $total, $SLOTS run at once); about $(((rounds * typical + 59) / 60)) min to go"
      last_said=$SECONDS
    fi
    wait_signal 1
  done
  if [ "$got" = no ]; then
    # Exit 75 (EX_TEMPFAIL) and this exact wording tell Boss Man nothing ran: it retries the merge instead of sending the ticket back.
    if [ "$stuck" = yes ]; then
      echo "check-all: gave up waiting for the heavy-phase lock $LOCK: the queue made no progress for $(((STUCK + 59) / 60)) min (place $place of $total; the check holding the slot has not changed)" >&2; exit 75
    fi
    echo "check-all: gave up waiting for the heavy-phase lock $LOCK" >&2; exit 75
  fi
  rm -f "$qfile" "$AGEREF"; trap - EXIT
  echo "check-all: slot taken, running the checks"
else
  echo "check-all: flock not found, running without the heavy-phase lock"
fi
[ -z "${CHECK_ALL_STARTED_FILE:-}" ] || date +%s >"$CHECK_ALL_STARTED_FILE"
# Test hook: scripts/check-all.test.sh stops here once the lock is held.
[ -z "${CHECK_ALL_STOP_AFTER_LOCK:-}" ] || { echo "check-all: lock held"; exit 0; }
if [ -n "${CHECK_ALL_SLOT_COMMAND:-}" ]; then rc=0; bash -c "$CHECK_ALL_SLOT_COMMAND" || rc=$?; exit "$rc"; fi
node scripts/check-in-memory-state.mjs
# Memory-safe on a shared runner (a 12 GB cgroup shared with other agents, two checks at once): one package at a time,
# at most 2 PGlite workers (fewer when the cgroup has less free; see apps/server/vitest.config.ts),
# and a capped heap for tsc only. Callers can override any of these.
export BOSSMAN_TEST_MAX_WORKERS="${BOSSMAN_TEST_MAX_WORKERS:-2}"
NODE_OPTIONS="${NODE_OPTIONS:---max-old-space-size=2048}" pnpm -r --workspace-concurrency=1 typecheck
pnpm -r --workspace-concurrency=1 test
pnpm build
scripts/check-shell.sh
scripts/test-shell.sh
echo "check-all: everything passed"
