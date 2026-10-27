#!/usr/bin/env bash
# Everything in CI's "check" job that runs without Docker or a real Postgres, for Boss Man's
# "Before merging" command. CI still runs leader.test.ts (real Postgres) and the image job
# on pushes that touch those areas, every night, and on every pull request.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
pnpm install --frozen-lockfile --prefer-offline >/dev/null
node --test scripts/*.test.mjs
node scripts/lint-migrations.mjs
node scripts/check-in-memory-state.mjs
# The heavy phases peak well above 4 GB each. Several checks share one runner, so take turns (the lock is
# released when this script exits). The wait counts against the merge check's own timeout, hence the cap.
LOCK=${CHECK_ALL_LOCK:-/tmp/bossman-check-all.lock}
exec 9>"$LOCK"
if ! flock -n 9; then
  echo "check-all: another check is in its heavy phase; waiting for it (up to ${CHECK_ALL_LOCK_WAIT:-900}s)"
  flock -w "${CHECK_ALL_LOCK_WAIT:-900}" 9 || { echo "check-all: gave up waiting for the heavy-phase lock $LOCK" >&2; exit 1; }
fi
pnpm typecheck
pnpm test
pnpm build
scripts/check-shell.sh
scripts/test-shell.sh
echo "check-all: everything passed"
