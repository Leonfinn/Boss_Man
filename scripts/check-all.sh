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
pnpm typecheck
pnpm test
pnpm build
scripts/check-shell.sh
scripts/test-shell.sh
echo "check-all: everything passed"
