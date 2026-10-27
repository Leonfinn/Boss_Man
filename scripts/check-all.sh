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
node scripts/check-in-memory-state.mjs
pnpm typecheck
pnpm test
pnpm build
scripts/check-shell.sh
scripts/test-shell.sh
echo "check-all: everything passed"
