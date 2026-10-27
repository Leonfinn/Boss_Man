#!/usr/bin/env bash
# Everything in CI's "check" job that runs without Docker or a real Postgres, for Boss Man's
# "Before merging" command. CI still runs leader.test.ts (real Postgres) and the image job
# on pushes that touch those areas, every night, and on every pull request.
set -euo pipefail
self="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/$(basename "${BASH_SOURCE[0]}")"
cd "$(dirname "$self")/.."

# The shared runner caps processes (pids.max 1024) and other agents use most of them, so a step can die
# with "spawn EAGAIN" / "Cannot fork" through no fault of the code. Run the checks in a child and re-run
# them, after a pause, only when the failure output shows that kind of error; any other failure is final.
if [ -z "${BOSSMAN_CHECK_CHILD:-}" ]; then
  attempts="${BOSSMAN_CHECK_ATTEMPTS:-3}"
  budget="${BOSSMAN_CHECK_BUDGET_SECONDS:-1500}"  # Boss Man kills the merge check at 30 min; stay well inside it
  pause="${BOSSMAN_CHECK_RETRY_SECONDS:-30}"
  start=$SECONDS
  log="$(mktemp)"
  trap 'rm -f "$log"' EXIT
  for ((n = 1; n <= attempts; n++)); do
    rc=0; began=$SECONDS
    BOSSMAN_CHECK_CHILD=1 bash "$self" 2>&1 | tee "$log" || rc=${PIPESTATUS[0]}
    [ "$rc" -eq 0 ] && exit 0
    # Each retry re-runs everything, so only retry if another run of this length still fits the budget.
    took=$((SECONDS - began))
    if [ "$n" -lt "$attempts" ] && [ $((SECONDS - start + took + pause)) -le "$budget" ] && grep -qE 'spawn(Sync)? .*EAGAIN|EAGAIN: resource|Cannot fork|Resource temporarily unavailable|fork: retry' "$log"; then
      echo "check-all: attempt $n hit the runner's process limit (exit $rc); retrying in ${pause}s" >&2
      sleep "$pause"
    else
      exit "$rc"
    fi
  done
fi

# BOSSMAN_CHECK_BODY replaces the checks below with a stub command (for check-all.test.sh).
if [ -n "${BOSSMAN_CHECK_BODY:-}" ]; then bash -c "$BOSSMAN_CHECK_BODY"; exit; fi

pnpm install --frozen-lockfile --prefer-offline >/dev/null
node --test scripts/*.test.mjs
node scripts/lint-migrations.mjs
# The heavy phases below peak well above 4 GB each. Several checks share one runner, so take turns (the lock
# is released when this script exits). The wait counts against the merge check's 30-minute timeout, hence
# the 600s cap. fd 9 is inherited by pnpm/vitest: if a timed-out check leaves children behind they keep the
# lock until they exit (tracked in the runner-cleanup ticket). Skipped where flock is missing (macOS).
if command -v flock >/dev/null; then
  LOCK=${CHECK_ALL_LOCK:-/tmp/bossman-check-all.lock}
  WAIT=${CHECK_ALL_LOCK_WAIT:-600}
  exec 9>"$LOCK"
  if ! flock -n 9; then
    echo "check-all: another check is in its heavy phase; waiting for it (up to ${WAIT}s)"
    flock -w "$WAIT" 9 || { echo "check-all: gave up waiting for the heavy-phase lock $LOCK" >&2; exit 1; }
  fi
else
  echo "check-all: flock not found, running without the heavy-phase lock"
fi
# Test hook: scripts/check-all.test.sh stops here once the lock is held.
[ -z "${CHECK_ALL_STOP_AFTER_LOCK:-}" ] || { echo "check-all: lock held"; exit 0; }
node scripts/check-in-memory-state.mjs
# Memory-safe on a shared runner (8 GB cgroup, other agents beside us): one package at a time,
# at most 2 PGlite workers (fewer when the cgroup has less free; see apps/server/vitest.config.ts),
# and a capped heap for tsc only. Callers can override any of these.
export BOSSMAN_TEST_MAX_WORKERS="${BOSSMAN_TEST_MAX_WORKERS:-2}"
NODE_OPTIONS="${NODE_OPTIONS:---max-old-space-size=2048}" pnpm -r --workspace-concurrency=1 typecheck
pnpm -r --workspace-concurrency=1 test
pnpm build
scripts/check-shell.sh
scripts/test-shell.sh
echo "check-all: everything passed"
