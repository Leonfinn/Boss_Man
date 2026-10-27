#!/usr/bin/env bash
# Everything in CI's "check" job that runs without Docker or a real Postgres, for Boss Man's
# "Before merging" command. CI still runs leader.test.ts (real Postgres) and the image job
# on pushes that touch those areas, every night, and on every pull request.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
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
pnpm typecheck
pnpm test
pnpm build
scripts/check-shell.sh
scripts/test-shell.sh
echo "check-all: everything passed"
