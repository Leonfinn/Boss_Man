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

# A fenced check job on a runner that predates the home-folder fix has a HOME that doesn't exist and can't be created. Chrome
# (its crash handler and profile folder), git, npm and others then fail in whichever step needs them (BOS-1095: web tests, then
# the shell tests' Chrome demo). When HOME isn't a writable folder, the whole run gets a home of its own under the temp folder,
# with XDG folders, removed when the run ends. The child run inherits it, so this happens once, before any step.
check_home=""
if ! [ -d "${HOME:-}" ] || ! [ -w "$HOME" ]; then
  check_home="$(mktemp -d)"
  echo "check-all: HOME ${HOME:-unset} is not usable; this run uses $check_home"
  export HOME="$check_home" XDG_CONFIG_HOME="$check_home/.config" XDG_CACHE_HOME="$check_home/.cache" XDG_DATA_HOME="$check_home/.local/share"
  mkdir -p "$XDG_CONFIG_HOME" "$XDG_CACHE_HOME" "$XDG_DATA_HOME"
  trap 'rm -rf "$check_home"' EXIT
fi

# Where finished runs are kept (result + full log), keyed by the git tree of the checked-out files, so a check that
# already passed on identical content is not run again. /var/tmp survives between runs; "off" switches the store off.
STORE="${BOSSMAN_CHECK_STORE:-/var/tmp/bossman-check-results}"

# A ticket's kept scratch (BOSSMAN_SCRATCH, BOS-592, set by the runner): the full log of every run goes there too,
# under its own name, so a failed check's whole output can be read back after the runner restarted. Best effort: a check
# that can't write a log still checks. scripts/sweep-tmp.sh never touches it, unlike /tmp.
SCRATCH=${BOSSMAN_SCRATCH:-}
SCRATCH_LOG="$SCRATCH/check-all.log"
# scratch_log <file> <exit code>: put this run's completed log in the ticket's kept scratch, so it can be read after a
# restart wiped /tmp. Written as .next then moved into place, so a half-written log is never read, and the previous
# run is kept as .previous. Best effort: a check that can't keep a log still checks. A fenced agent may not write the
# scratch folder itself, so a copy is first made somewhere this run surely can (/tmp, under a name the tmp sweep clears
# after 6 h), and the runner moves that into the scratch at the next start.
scratch_log() {
  local rc=$2 tmp="" out=""
  [ -n "$SCRATCH" ] && [ -d "$SCRATCH" ] || return 0
  # Written to a scratch file, then moved in: a half-written log is never read. A folder the run may not write (a
  # fenced agent's) takes the log through /tmp under a kept name instead, and the runner moves that in at its next start.
  if out="$( { : >"$SCRATCH_LOG.next"; } 2>/dev/null && echo "$SCRATCH_LOG.next")" && [ -n "$out" ]; then
    { printf 'check-all: finished %s (exit %s)\n' "$(date -u +%FT%TZ)" "$rc"; cat "$1" 2>/dev/null; } >"$out" 2>/dev/null || out=""
  fi
  if [ -z "$out" ]; then
    [ -n "${BOSSMAN_TICKET:-}" ] && [ -d /tmp ] && [ -w /tmp ] || return 0
    tmp="/tmp/bossman-scratch-$BOSSMAN_TICKET.log"; out=$tmp
    if ! { printf 'check-all: finished %s (exit %s)\n' "$(date -u +%FT%TZ)" "$rc"; cat "$1" 2>/dev/null; } 2>/dev/null >"$tmp"; then
      # The kept name is taken by a file this run may not write (another user's, in sticky /tmp): keep the log under a
      # name of its own so it is not lost. The runner only moves the exact name in; this one is for a person to read.
      tmp="/tmp/bossman-scratch-$BOSSMAN_TICKET.$$.log"
      { printf 'check-all: finished %s (exit %s)\n' "$(date -u +%FT%TZ)" "$rc"; cat "$1" 2>/dev/null; } 2>/dev/null >"$tmp" || return 0
      echo "check-all: $SCRATCH_LOG not writable and the kept /tmp name is taken; log kept at $tmp" >&2
    fi
  fi
  if [ -z "$tmp" ]; then
    [ ! -s "$SCRATCH_LOG" ] || mv -f "$SCRATCH_LOG" "$SCRATCH_LOG.previous" 2>/dev/null || true
    mv -f "$out" "$SCRATCH_LOG" 2>/dev/null || true
  fi
}
# The shared runner caps processes (pids.max 1024) and other agents use most of them, so a step can die
# with "spawn EAGAIN" / "Cannot fork" through no fault of the code. Run the checks in a child and re-run
# them, after a pause, only when the failure output shows that kind of error; any other failure is final.
if [ -z "${BOSSMAN_CHECK_CHILD:-}" ]; then
  attempts="${BOSSMAN_CHECK_ATTEMPTS:-3}"
  budget="${BOSSMAN_CHECK_BUDGET_SECONDS:-3000}"  # Boss Man kills the merge check 60 min after its slot is taken (VERIFY_TIMEOUT_MS); stay well inside it
  pause="${BOSSMAN_CHECK_RETRY_SECONDS:-30}"
  log="$(mktemp)"; began_file="$(mktemp)"; slot_at=""
  # The child leaves per-file test times here (vitest JSON reports, shell test times); record() folds them into $STORE/<tree>.test-times (BOS-654).
  times_dir="$(mktemp -d)"
  trap 'rm -f "$log" "$began_file"; rm -rf "$times_dir"; [ -z "$check_home" ] || rm -rf "$check_home"' EXIT

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
    scratch_log "$log" "$((128 + $2))"
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
    # Per-file test times of this run (best effort): the slowest server test files and shell tests, in seconds, for the next speed-up.
    if [ -n "$(ls -A "$times_dir" 2>/dev/null)" ]; then
      if node "$(dirname "$self")/test-times.mjs" "$times_dir" >"$STORE/$key.test-times.tmp" 2>/dev/null; then
        mv "$STORE/$key.test-times.tmp" "$STORE/$key.test-times"
      else
        rm -f "$STORE/$key.test-times.tmp"
      fi
    else
      rm -f "$STORE/$key.test-times"
    fi
    # keep the newest 50 results
    local old
    while read -r old; do rm -f "$old" "${old%.json}.log" "${old%.json}.test-times"; done < <(find "$STORE" -maxdepth 1 -name '*.json' -printf '%T@ %p\n' | sort -rn | tail -n +51 | cut -d' ' -f2-)
  }
  [ -z "$key" ] || echo "check-all: the result and log of this run will be kept in $STORE/$key.{json,log}"
  for ((n = 1; n <= attempts; n++)); do
    # Test hook: a simulated queue wait, which the fixed budget ignores (check-all.test.sh retry-budget case).
    [ "$n" -gt 1 ] || [ -z "${CHECK_ALL_QUEUE_TEST_SLEEP:-}" ] || sleep "$CHECK_ALL_QUEUE_TEST_SLEEP"
    rc=0; : >"$began_file"; attempt_start=$SECONDS; rm -rf "${times_dir:?}"/* 2>/dev/null || true
    # The child runs in the background and we wait for it, so a signal reaches the trap at once instead of after the child.
    # tee runs on its own descriptor so we can wait for it: a bare `wait` doesn't wait for a process substitution that
    # isn't $!, so the EAGAIN grep below could read the log before tee wrote it and skip a retry (CI: "ran 2 times, want 3").
    # The child closes that descriptor, so a process it leaves behind can't hold tee open; the wait is bounded anyway.
    exec {log_fd}> >(tee "$log")
    tee_pid=$!
    BOSSMAN_CHECK_CHILD=1 BOSSMAN_CHECK_STORE="$STORE" BOSSMAN_CHECK_TIMES_DIR="$times_dir" CHECK_ALL_STARTED_FILE="$began_file" bash "$self" >&"$log_fd" 2>&1 {log_fd}>&- &
    child=$!
    wait "$child" || rc=$?
    exec {log_fd}>&-
    for _ in $(seq 100); do kill -0 "$tee_pid" 2>/dev/null || break; sleep 0.1; done  # let tee finish writing the log (at most 10 s)
    # Exit 75: nothing ran (gave up waiting for a slot), so there is no result to keep.
    if [ "$rc" -eq 0 ]; then record pass 0; scratch_log "$log" 0; exit 0; fi
    # Each retry re-runs everything, so only retry if another run of this length still fits the budget.
    # The budget counts from the slot-taken time (the first non-empty $began_file), not from before the queue wait:
    # a long wait used to use it up, so a check that then hit EAGAIN was never retried.
    took=$((SECONDS - attempt_start)); began=$(cat "$began_file")
    if [ -n "$began" ]; then [ -n "$slot_at" ] || slot_at=$began; took=$(($(date +%s) - began)); fi
    if [ "$n" -lt "$attempts" ] && [ $(( $(date +%s) - ${slot_at:-$(date +%s)} + took + pause )) -le "$budget" ] && grep -qE 'spawn(Sync)? .*EAGAIN|EAGAIN: resource|Cannot fork|Resource temporarily unavailable|fork: retry|The run ended with an error: .*(EAGAIN|pthread_create|ENOMEM|Cannot allocate memory|exited \(code (null|137)\))' "$log"; then
      echo "check-all: attempt $n hit the runner's process limit (exit $rc); retrying in ${pause}s" >&2
      # Run the pause in the background and wait for it, so a signal reaches on_signal at once, not up to ${pause}s later.
      sleep "$pause" & pause_pid=$!; wait "$pause_pid" 2>/dev/null || true
    else
      [ "$rc" -eq 75 ] || record fail "$rc"
      scratch_log "$log" "$rc"
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
# One CPU budget for every step of this check, slot-command runs included (BOS-674; see scripts/check-threads.mjs): this slot's
# share of the container's CPUs, at most 4, or BOSSMAN_CHECK_THREADS if set. Vitest configs read it as their worker cap; tsc
# (Go) and the web build (Rolldown, Rust) get it as their thread-pool sizes. Callers can override any of these.
BOSSMAN_CHECK_THREADS="${BOSSMAN_CHECK_THREADS:-$(BOSSMAN_CHECK_SLOTS="${SLOTS:-${BOSSMAN_CHECK_SLOTS:-}}" node "$(dirname "${BASH_SOURCE[0]}")/check-threads.mjs" 2>/dev/null || true)}"
[[ "$BOSSMAN_CHECK_THREADS" =~ ^[1-9][0-9]{0,3}$ ]] || BOSSMAN_CHECK_THREADS=2
export BOSSMAN_CHECK_THREADS GOMAXPROCS="${GOMAXPROCS:-$BOSSMAN_CHECK_THREADS}" RAYON_NUM_THREADS="${RAYON_NUM_THREADS:-$BOSSMAN_CHECK_THREADS}" TOKIO_WORKER_THREADS="${TOKIO_WORKER_THREADS:-$BOSSMAN_CHECK_THREADS}"
echo "check-all: CPU budget $BOSSMAN_CHECK_THREADS threads per step (BOSSMAN_CHECK_THREADS)"
if [ -n "${CHECK_ALL_SLOT_COMMAND:-}" ]; then rc=0; bash -c "$CHECK_ALL_SLOT_COMMAND" || rc=$?; exit "$rc"; fi
# step <name> <command...>: runs one stage and prints how long it took, so a slow host shows which stage slowed down (BOS-523).
step() { local name=$1 began=$SECONDS rc=0; shift; "$@" || rc=$?; echo "check-all: step $name took $((SECONDS - began))s (exit $rc, at $(date -u +%H:%M:%S) UTC)"; return "$rc"; }
step in-memory-state node scripts/check-in-memory-state.mjs
# Memory-safe on a shared runner (a 12 GB cgroup shared with other agents, two checks at once): one package at a time,
# at most 2 PGlite workers (fewer when the cgroup has less free; see apps/server/vitest.config.ts),
# and a capped heap for tsc only. Callers can override any of these.
export BOSSMAN_TEST_MAX_WORKERS="${BOSSMAN_TEST_MAX_WORKERS:-2}"
# /tmp fills with the tests' own scratch (BOS-568), and a check that starts on a full one fails oddly. Say so up front,
# in the kept log, instead: 64 MB written and read back once per check. A probe that can't finish in 20 s is left as is.
if [ -n "${TMPDIR:-}" ] && [ -d "$TMPDIR" ] && [ -z "${BOSSMAN_SKIP_TMP_PROBE:-}" ]; then
  probe="$TMPDIR/.bossman-probe.$$"
  if mkdir -p "$probe" 2>/dev/null && dd if=/dev/zero of="$probe/blob" bs=1M count=64 conv=fsync 2>/dev/null; then
    wrote=$(date +%s%N)
    if timeout 20 dd if="$probe/blob" of=/dev/null bs=1M iflag=fullblock 2>/dev/null; then
      elapsed=$(( ($(date +%s%N) - wrote) / 1000000 ))
      [ "$elapsed" -lt 3000 ] || echo "check-all: note: $TMPDIR is slow (read 64 MB in ${elapsed} ms), so tests that scratch there are slow too"
    fi
  else
    echo "check-all: note: $TMPDIR may be full (couldn't write 64 MB there), so a check that needs temp space may fail"
  fi
  rm -rf "$probe" 2>/dev/null || true
fi
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
# The build runs before the tests (BOS-1071): the web tests that load the built page (wrap-up-layout, settings-walk, ...)
# skip when apps/web/dist is missing, so with the build after them a change that broke them passed this gate and only GitHub CI saw it.
step build pnpm build
# The web suite must not skip anything at the gate (CI's web-browser job applies the same rule): a missing build, browser or Vite
# fails here instead of passing quietly. BOSSMAN_SCRATCH points at a throwaway folder so the opt-in screenshot tests run too.
web_tests() {
  local d=$1 report shots rc=0 out
  report="${BOSSMAN_CHECK_TIMES_DIR:+$BOSSMAN_CHECK_TIMES_DIR/vitest-web.json}"
  [ -n "$report" ] || report="$(mktemp)"
  shots="$(mktemp -d)"
  out="$(mktemp)"
  # Playwright is a global npm tool. A fenced check job on a runner that predates the NODE_PATH pass-through gets no NODE_PATH, so
  # the real-browser tests skip (BOS-1095). With none set, use npm's own global folder when it exists; no host path is assumed.
  if [ -z "${NODE_PATH:-}" ] && command -v npm >/dev/null 2>&1; then
    gnm="$(npm root -g 2>/dev/null || true)"
    if [ -n "$gnm" ] && [ -d "$gnm/playwright" ]; then export NODE_PATH="$gnm"; fi
  fi
  # tee keeps the live output; the copy lets a failure repeat the "real-page:" reasons last, where the log tail shows them (BOS-1095).
  # PIPESTATUS must be read straight after the pipeline (an "|| true" would make it describe "true", so a red suite passed).
  set +e
  env BOSSMAN_SCRATCH="$shots" pnpm --dir "$d" exec vitest run --reporter=default --reporter=json --outputFile.json="$report" 2>&1 | tee "$out"
  rc=${PIPESTATUS[0]}
  set -e
  rm -rf "$shots"
  if [ "$rc" -eq 0 ]; then
    node "$(dirname "$self")/check-no-skips.mjs" "$report" || rc=$?
  fi
  if [ "$rc" -ne 0 ]; then
    echo "check-all: web test reasons (real-page lines, env):"
    grep -h "real-page:" "$out" | sort | uniq -c | head -20 || true
    echo "check-all: HOME=${HOME:-unset} TMPDIR length=${#TMPDIR} user=$(id -un 2>/dev/null) uid=$(id -u)"
  fi
  rm -f "$out"
  return "$rc"
}
for d in "${pkg_dirs[@]}"; do
  grep -q '"test"' "$d/package.json" || continue
  if [ "${d##*/}" = web ]; then step "test:web" web_tests "$d"; continue; fi
  # BOSSMAN_TEST_TIMES_FILE makes vitest also write a JSON report, which the parent folds into the result store (BOS-654).
  step "test:${d##*/}" env ${BOSSMAN_CHECK_TIMES_DIR:+BOSSMAN_TEST_TIMES_FILE="$BOSSMAN_CHECK_TIMES_DIR/vitest-${d##*/}.json"} pnpm --dir "$d" run test
done
step shellcheck scripts/check-shell.sh
step shell-tests env ${BOSSMAN_CHECK_TIMES_DIR:+BOSSMAN_SHELL_TIMES_FILE="$BOSSMAN_CHECK_TIMES_DIR/shell.tsv"} scripts/test-shell.sh
echo "check-all: everything passed"
