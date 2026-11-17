#!/usr/bin/env bash
# Run ONE vitest file on a slow, busy CPU, to show a time-limit flake "fails before the fix, passes after it" (BOS-1759).
#
#   scripts/squeeze-test.sh <test file> [busy loops] [runs]
#
# The test file runs with one vitest worker, pinned to one CPU that N busy loops share, so it runs several times slower
# (GitHub's machines are 2.5 to 5 times slower than ours). Each run is stopped after 200 s and reported as "no answer"
# (neither a pass nor a fail). Defaults, as measured in BOS-1730: busy loops web 9, runner 19, anything else 4; 2 runs.
# Run it on the old test file and on the fixed one, and paste both results on the ticket.
#
# Exit code: 0 every run passed, 1 a run failed, 3 no run failed but one gave no answer, 2 bad use or no `taskset`.
# The busy loops and the test process are always stopped again, also on Ctrl-C, kill or the 200 s stop.
# It needs no BOSSMAN_VITEST_NO_SLOT: it names one file and one worker, so vitest-guard's quick lane takes it.
#
# Only a time-limit flake is shown this way: a real race between two processes, or a fixed sleep that is merely too short,
# may not fail. A file with its own GitHub limit (hot-path-budget) fails the squeeze whether repaired or not.
# Settings for the tests of this script (not for use by hand):
#   SQUEEZE_STOP_SECONDS  the stop (default 200)
#   SQUEEZE_COMMAND       command that runs the file, given the file path as its last argument (default: npx vitest run)
#   SQUEEZE_ROOT          the repo folder (default: the one this script is in)
#   SQUEEZE_CPU          the CPU to pin to (default: the first CPU this shell may use)
#   SQUEEZE_MARK          a word put on the busy loops' command line so a test can find them (default: squeeze-busy)
set -uo pipefail

usage() { echo "usage: scripts/squeeze-test.sh <test file> [busy loops] [runs]" >&2; exit 2; }
if [ $# -lt 1 ] || [ $# -gt 3 ]; then usage; fi
FILE=$1
LOOPS_ARG=${2:-}
RUNS=${3:-2}
STOP=${SQUEEZE_STOP_SECONDS:-200}
MARK=${SQUEEZE_MARK:-squeeze-busy}

command -v taskset >/dev/null 2>&1 || {
  echo "squeeze-test: 'taskset' is not installed, so the test cannot be pinned to one CPU. Not running it unpinned." >&2
  exit 2
}
for n in "$RUNS" "$STOP" ${LOOPS_ARG:+"$LOOPS_ARG"}; do
  case "$n" in '' | *[!0-9]*) echo "squeeze-test: '$n' is not a whole number" >&2; usage ;; esac
done
if [ "$RUNS" -lt 1 ] || [ "$STOP" -lt 1 ]; then usage; fi

ROOT=$(cd "${SQUEEZE_ROOT:-$(dirname "${BASH_SOURCE[0]}")/..}" && pwd -P)
case "$FILE" in /*) abs=$FILE ;; *) abs=$PWD/$FILE ;; esac
[ -f "$abs" ] || { echo "squeeze-test: no such file: $FILE" >&2; exit 2; }
abs=$(cd "$(dirname "$abs")" && pwd -P)/$(basename "$abs")
case "$abs" in "$ROOT"/apps/* | "$ROOT"/packages/*) ;; *) echo "squeeze-test: $FILE is not under apps/ or packages/" >&2; exit 2 ;; esac
rel=${abs#"$ROOT"/}
pkg=$(echo "$rel" | cut -d/ -f1-2)
inpkg=${rel#"$pkg"/}
case "$pkg" in apps/web) default=9 ;; apps/runner) default=19 ;; *) default=4 ;; esac
LOOPS=${LOOPS_ARG:-$default}

if [ -n "${SQUEEZE_CPU:-}" ]; then
  CPU=$SQUEEZE_CPU
else
  allowed=$(sed -n 's/^Cpus_allowed_list:[[:space:]]*//p' /proc/self/status)
  CPU=${allowed%%[-,]*}
fi
case "${CPU:-}" in '' | *[!0-9]*) echo "squeeze-test: cannot tell which CPU to use; set SQUEEZE_CPU" >&2; exit 2 ;; esac

OUT=${BOSSMAN_SCRATCH:-${TMPDIR:-/tmp}}
LOGDIR=$(mktemp -d "$OUT/squeeze-test.XXXXXX") || exit 2

# Each loop and the test run in their own process group (setsid), so one kill of the group takes everything under it.
pids=()
testpid=
# shellcheck disable=SC2317  # runs from the traps below
stop_all() {
  local p
  for p in ${pids[@]+"${pids[@]}"} ${testpid:+"$testpid"}; do kill -KILL -- "-$p" 2>/dev/null || true; done
  for p in ${pids[@]+"${pids[@]}"} ${testpid:+"$testpid"}; do wait "$p" 2>/dev/null || true; done
  pids=()
  testpid=
}
trap 'stop_all' EXIT
trap 'stop_all; exit 130' INT
trap 'stop_all; exit 143' TERM HUP

for ((i = 0; i < LOOPS; i++)); do
  setsid taskset -c "$CPU" bash -c 'while :; do :; done' "$MARK" &
  pids+=("$!")
done

echo "squeeze-test: $rel on CPU $CPU with $LOOPS busy loops, $RUNS run(s), stop after $STOP s"
cmd=${SQUEEZE_COMMAND:-npx vitest run}
passed=0; failed=0; noanswer=0
for ((r = 1; r <= RUNS; r++)); do
  log=$LOGDIR/run-$r.log
  start=$SECONDS
  # shellcheck disable=SC2086  # the command is a word list on purpose
  (cd "$ROOT/$pkg" && exec setsid taskset -c "$CPU" timeout -k 5 "$STOP" $cmd "$inpkg") >"$log" 2>&1 &
  testpid=$!
  wait "$testpid"
  code=$?
  secs=$((SECONDS - start))
  kill -KILL -- "-$testpid" 2>/dev/null || true # a test that left children behind
  testpid=
  if [ "$code" -eq 124 ] || [ "$code" -eq 137 ]; then
    noanswer=$((noanswer + 1))
    echo "run $r/$RUNS: no answer (over $STOP s)"
  elif [ "$code" -eq 0 ] && grep -qE '(^|[[:space:]])Tests[[:space:]]+[0-9]+ (skipped|todo)' "$log"; then
    # Only skipped tests: nothing ran, so this is no proof either way (a web test without a build or a browser does this).
    echo "run $r/$RUNS: ERROR, every test was skipped, so nothing ran (exit $code)"
    tail -n 8 "$log" | sed 's/^/    /'
    exit 2
  elif [ "$code" -eq 0 ]; then
    passed=$((passed + 1))
    echo "run $r/$RUNS: pass (${secs} s)"
  elif grep -q "Startup Error" "$log"; then
    # vitest never ran the file (missing install, bad config): not a flake, so it is not counted as a failed run.
    echo "run $r/$RUNS: ERROR, vitest did not start (exit $code)"
    tail -n 15 "$log" | sed 's/^/    /'
    exit 2
  else
    failed=$((failed + 1))
    echo "run $r/$RUNS: FAIL (exit $code, ${secs} s)"
    tail -n 15 "$log" | sed 's/^/    /'
  fi
done
echo "squeeze-test: $passed pass, $failed fail, $noanswer no answer. Output of each run: $LOGDIR"
if [ "$failed" -gt 0 ]; then exit 1; fi
if [ "$noanswer" -gt 0 ]; then exit 3; fi
exit 0
