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
  budget="${BOSSMAN_CHECK_BUDGET_SECONDS:-3000}"  # Boss Man kills the merge check 60 min after its slot is taken (VERIFY_TIMEOUT_MS); stay well inside it
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
    # Per-step times ("check-all: step <name> took <s>s"), as {"name":seconds,...} in order, so the result shows where the time went.
    local steps
    steps=$(sed -n 's/^check-all: step \([A-Za-z0-9:._-]*\) took \([0-9]*\)s.*/"\1":\2/p' "$log" | paste -sd, -)
    printf '{"status":"%s","exit":%s,"tree":"%s","commit":"%s","finished":"%s","duration_seconds":%s,"merge_check":%s,"steps":{%s}}\n' \
      "$1" "$2" "$key" "$(git rev-parse HEAD)" "$(date -u +%FT%TZ)" "$dur" "$([ -n "${BOSSMAN_MERGE_CHECK:-}" ] && echo true || echo false)" "$steps" >"$STORE/$key.json" || return 0
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

# The slot wait lives in check-slot.sh (BOS-614), which runs this script again while it holds a slot. It marks that run by
# setting BOSSMAN_CHECK_SLOT_HELD to the private lock path it gives the run as CHECK_ALL_LOCK; the two must match, so a
# nested check-all with a lock of its own (the script tests) still queues. CHECK_ALL_PRE_DONE says the light steps below
# already ran before the wait. Both are cleared here so nothing this run starts inherits them.
held=${BOSSMAN_CHECK_SLOT_HELD:-}; pre_done=${CHECK_ALL_PRE_DONE:-}
unset BOSSMAN_CHECK_SLOT_HELD CHECK_ALL_PRE_DONE
in_slot=no
if [ -n "$held" ] && [ "$held" = "${CHECK_ALL_LOCK:-/tmp/bossman-check-all}" ]; then in_slot=yes; fi

if [ -z "$pre_done" ]; then
  # Clear old test scratch out of /tmp (older than 6 h, held by no process); best effort, never fails the check.
  "$(dirname "${BASH_SOURCE[0]}")/sweep-tmp.sh" || true
  # CHECK_ALL_SLOT_COMMAND (used by check-quick.sh, with BOSSMAN_CHECK_CHILD=1): wait for a slot exactly like a hand-run check,
  # run that one command while holding it, and exit with its status. None of the full checks run.
  if [ -z "${CHECK_ALL_SLOT_COMMAND:-}" ]; then
    pnpm install --frozen-lockfile --prefer-offline >/dev/null
    node --test scripts/*.test.mjs
    node scripts/lint-migrations.mjs
  fi
fi

# Not in a slot yet: wait in the line. The runner's shared copy (BOSSMAN_CHECK_SLOT, shipped in its image) wins over the one
# beside this script, so every waiter on the runner follows one copy of the queue rules, whatever branch it checks.
# BOSSMAN_CHECK_NO_LOCK=1 (set by the runner for a server-queued job, DR-003): the server holds the slots, so this script
# touches no lock file and does not queue; it still keeps the result store.
if [ -n "${BOSSMAN_CHECK_NO_LOCK:-}" ]; then
  echo "check-all: slot taken, running the checks (the server holds the slots; no lock files)"
elif [ "$in_slot" = no ]; then
  if [ -n "$pre_done" ]; then echo "check-all: ${BOSSMAN_CHECK_SLOT_USED:-the slot script} ran the checks without holding a check slot; stopping" >&2; exit 2; fi
  slot_script="$(dirname "$self")/check-slot.sh"
  if [ -n "${BOSSMAN_CHECK_SLOT:-}" ] && [ -f "$BOSSMAN_CHECK_SLOT" ]; then slot_script=$BOSSMAN_CHECK_SLOT; fi
  CHECK_ALL_PRE_DONE=1 BOSSMAN_CHECK_SLOT_USED="$slot_script" exec bash "$slot_script" bash "$self"
fi
[ -z "${CHECK_ALL_STARTED_FILE:-}" ] || date +%s >"$CHECK_ALL_STARTED_FILE"
# Nested check-all runs (the script tests inside the full check) inherit this variable and would overwrite the start time, so the
# recorded duration came out as seconds: only the run that owns the file may write it (BOS-545).
unset CHECK_ALL_STARTED_FILE
# Test hook: scripts/check-all.test.sh stops here once the lock is held.
[ -z "${CHECK_ALL_STOP_AFTER_LOCK:-}" ] || { echo "check-all: lock held"; exit 0; }
if [ -n "${CHECK_ALL_SLOT_COMMAND:-}" ]; then rc=0; bash -c "$CHECK_ALL_SLOT_COMMAND" || rc=$?; exit "$rc"; fi
# step <name> <command...>: runs one stage and prints how long it took, so a slow host shows which stage slowed down (BOS-523).
step() { local name=$1 began=$SECONDS rc=0; shift; "$@" || rc=$?; echo "check-all: step $name took $((SECONDS - began))s (exit $rc, at $(date -u +%H:%M:%S) UTC)"; return "$rc"; }
step in-memory-state node scripts/check-in-memory-state.mjs
# Memory-safe on a shared runner (a 12 GB cgroup shared with other agents, two checks at once): one package at a time,
# at most 2 PGlite workers (fewer when the cgroup has less free; see apps/server/vitest.config.ts),
# and a capped heap for tsc only. Callers can override any of these.
export BOSSMAN_TEST_MAX_WORKERS="${BOSSMAN_TEST_MAX_WORKERS:-2}"
# Typecheck and tests run one package at a time (the same order and limits as `pnpm -r --workspace-concurrency=1`), each as its own
# timed step, so the time shows which package is slow (BOS-415). Packages come from pnpm in dependency order.
pkg_dirs=(); while IFS= read -r d; do pkg_dirs+=("$d"); done < <(pnpm -r --workspace-concurrency=1 exec pwd 2>/dev/null | grep '^/' || true)
[ "${#pkg_dirs[@]}" -gt 0 ] || { echo "check-all: could not list the workspace packages" >&2; exit 1; }
export NODE_OPTIONS="${NODE_OPTIONS:---max-old-space-size=2048}"
for d in "${pkg_dirs[@]}"; do
  grep -q '"typecheck"' "$d/package.json" || continue
  step "typecheck:${d##*/}" pnpm --dir "$d" run typecheck
done
unset NODE_OPTIONS  # the heap cap is for tsc only
for d in "${pkg_dirs[@]}"; do
  grep -q '"test"' "$d/package.json" || continue
  step "test:${d##*/}" pnpm --dir "$d" run test
done
step build pnpm build
step shellcheck scripts/check-shell.sh
step shell-tests scripts/test-shell.sh
echo "check-all: everything passed"
