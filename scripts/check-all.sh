#!/usr/bin/env bash
# Everything in CI's "check" job that runs without Docker or a real Postgres, for Boss Man's
# "Before merging" command. CI still runs leader.test.ts (real Postgres) and the image job
# on pushes that touch those areas, every night, and on every pull request.
set -euo pipefail
self="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/$(basename "${BASH_SOURCE[0]}")"
cd "$(dirname "$self")/.."

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
  start=$SECONDS
  log="$(mktemp)"; began_file="$(mktemp)"
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
    rc=0; : >"$began_file"; attempt_start=$SECONDS
    BOSSMAN_CHECK_CHILD=1 BOSSMAN_CHECK_STORE="$STORE" CHECK_ALL_STARTED_FILE="$began_file" bash "$self" 2>&1 | tee "$log" || rc=${PIPESTATUS[0]}
    # Exit 75: nothing ran (gave up waiting for a slot), so there is no result to keep.
    if [ "$rc" -eq 0 ]; then record pass 0; exit 0; fi
    # Each retry re-runs everything, so only retry if another run of this length still fits the budget.
    took=$((SECONDS - attempt_start)); began=$(cat "$began_file"); [ -z "$began" ] || took=$(($(date +%s) - began))
    if [ "$n" -lt "$attempts" ] && [ $((SECONDS - start + took + pause)) -le "$budget" ] && grep -qE 'spawn(Sync)? .*EAGAIN|EAGAIN: resource|Cannot fork|Resource temporarily unavailable|fork: retry' "$log"; then
      echo "check-all: attempt $n hit the runner's process limit (exit $rc); retrying in ${pause}s" >&2
      sleep "$pause"
    else
      [ "$rc" -eq 75 ] || record fail "$rc"
      exit "$rc"
    fi
  done
fi

# BOSSMAN_CHECK_BODY replaces the checks below with a stub command (for check-all.test.sh).
if [ -n "${BOSSMAN_CHECK_BODY:-}" ]; then bash -c "$BOSSMAN_CHECK_BODY"; exit; fi

pnpm install --frozen-lockfile --prefer-offline >/dev/null
node --test scripts/*.test.mjs
node scripts/lint-migrations.mjs
# The heavy phases below peak well above 2 GB each, so only CHECK_ALL_SLOTS (default 1 until a clean side-by-side pair is measured) checks run them at once;
# the rest queue in order, merge checks first. Each slot is a lock file held until this script exits.
# A waiter prints its place and an estimated wait and does not give up (hand-run checks) or gives up
# after CHECK_ALL_LOCK_WAIT seconds (default 3 h, merge check only: exit 75, which Boss Man retries).
# The merge check queues like the rest but goes ahead of waiting hand-run checks; one already running is never interrupted.
# fd 9 is inherited by pnpm/vitest: if a timed-out check leaves children behind they keep the slot until
# they exit (tracked in the runner-cleanup ticket). Skipped where flock is missing (macOS).
if command -v flock >/dev/null; then
  LOCK=${CHECK_ALL_LOCK:-/tmp/bossman-check-all}
  SLOTS=${CHECK_ALL_SLOTS:-1}
  QDIR="$LOCK.queue"  # one file per waiting check, "<0 merge | 1 hand-run>-<time>-<pid>"; names sort into serving order
  if [ -n "${BOSSMAN_MERGE_CHECK:-}" ]; then WAIT=${CHECK_ALL_LOCK_WAIT:-10800}; prio=0; else WAIT=${CHECK_ALL_LOCK_WAIT:-0}; prio=1; fi
  mkdir -p "$QDIR"
  qfile="$QDIR/$prio-$(date +%s%N)-$$"
  : >"$qfile"; trap 'rm -f "$qfile"' EXIT
  take_slot() {
    local k
    for ((k = 1; k <= SLOTS; k++)); do
      exec 9>"$LOCK.slot.$k"
      if flock -n 9; then return 0; fi
    done
    exec 9>&-
    return 1
  }
  # Prints "<my place> <checks waiting>", dropping queue entries whose process is gone.
  queue_place() {
    local f base qts qpid mine=0 total=0 now; now=$(date +%s)
    for f in "$QDIR"/*; do
      [ -e "$f" ] || continue
      # Drop malformed entries first: the folder is shared, so a name is never used in arithmetic unless it is digits only.
      # Then drop entries whose process is gone, or older than 2 h (a killed waiter whose pid was reused).
      base=$(basename "$f")
      if ! [[ $base =~ ^[01]-[0-9]+-[0-9]+$ ]]; then rm -f "$f"; continue; fi
      qts=$(cut -d- -f2 <<<"$base"); qpid=${base##*-}
      if ! kill -0 "$qpid" 2>/dev/null || [ $((now - qts / 1000000000)) -gt 7200 ]; then rm -f "$f"; continue; fi
      total=$((total + 1)); [ "$f" != "$qfile" ] || mine=$total
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
        if [ -n "$d" ] && [ "$d" -gt 0 ]; then sum=$((sum + d)); n=$((n + 1)); fi
      done < <(find "$BOSSMAN_CHECK_STORE" -maxdepth 1 -name '*.json' -printf '%T@ %p\n' | sort -rn | head -n 10 | cut -d' ' -f2-)
    fi
    if [ "$n" -gt 0 ]; then echo $((sum / n)); else echo 600; fi
  }
  waited_from=$SECONDS; last_said=-1000; got=no; typical=""
  while :; do
    read -r place total < <(queue_place)
    if [ "$place" -le 1 ] && take_slot; then got=yes; break; fi
    if [ "$WAIT" -gt 0 ] && [ $((SECONDS - waited_from)) -ge "$WAIT" ]; then break; fi
    if [ $((SECONDS - last_said)) -ge "${CHECK_ALL_QUEUE_REPORT:-30}" ]; then
      [ -n "$typical" ] || typical=$(typical_run)
      rounds=$(((place + SLOTS - 1) / SLOTS))
      echo "check-all: waiting for a free check slot (place $place of $total, $SLOTS run at once); about $(((rounds * typical + 59) / 60)) min to go"
      last_said=$SECONDS
    fi
    sleep 1
  done
  if [ "$got" = no ]; then
    # Exit 75 (EX_TEMPFAIL) and this exact wording tell Boss Man nothing ran: it retries the merge instead of sending the ticket back.
    echo "check-all: gave up waiting for the heavy-phase lock $LOCK" >&2; exit 75
  fi
  rm -f "$qfile"; trap - EXIT
  echo "check-all: slot taken, running the checks"
else
  echo "check-all: flock not found, running without the heavy-phase lock"
fi
[ -z "${CHECK_ALL_STARTED_FILE:-}" ] || date +%s >"$CHECK_ALL_STARTED_FILE"
# Test hook: scripts/check-all.test.sh stops here once the lock is held.
[ -z "${CHECK_ALL_STOP_AFTER_LOCK:-}" ] || { echo "check-all: lock held"; exit 0; }
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
