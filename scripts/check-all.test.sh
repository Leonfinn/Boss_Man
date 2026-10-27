#!/usr/bin/env bash
# Tests the heavy-phase lock in scripts/check-all.sh with stubbed pnpm/node (nothing real runs).
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
command -v flock >/dev/null || { echo "check-all.test: flock missing, skipped"; exit 0; }
tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT
printf '#!/bin/sh\nexit 0\n' > "$tmp/pnpm"; cp "$tmp/pnpm" "$tmp/node"; chmod +x "$tmp/pnpm" "$tmp/node"
export PATH="$tmp:$PATH" CHECK_ALL_LOCK="$tmp/lock" CHECK_ALL_STOP_AFTER_LOCK=1
fail() { echo "check-all.test: FAIL: $*" >&2; exit 1; }

out=$(scripts/check-all.sh 2>&1) || fail "free lock: expected success, got: $out"
grep -q "lock held" <<<"$out" || fail "free lock: not acquired"

# A second caller waits, then gives up with exit 1 after CHECK_ALL_LOCK_WAIT.
( exec 8>"$tmp/lock"; flock 8; sleep 5 ) & holder=$!
sleep 0.5
rc=0; out=$(CHECK_ALL_LOCK_WAIT=1 scripts/check-all.sh 2>&1) || rc=$?
[ "$rc" = 1 ] || fail "busy lock: expected exit 1, got $rc"
grep -q "waiting for it" <<<"$out" && grep -q "gave up" <<<"$out" || fail "busy lock: messages missing: $out"
kill "$holder" 2>/dev/null || true; wait "$holder" 2>/dev/null || true

# Once the holder lets go, the waiter gets in.
( exec 8>"$tmp/lock"; flock 8; sleep 1 ) & 
sleep 0.3
out=$(CHECK_ALL_LOCK_WAIT=10 scripts/check-all.sh 2>&1) || fail "released lock: expected success, got: $out"
wait
echo "check-all.test: ok"
