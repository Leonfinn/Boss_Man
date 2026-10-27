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
