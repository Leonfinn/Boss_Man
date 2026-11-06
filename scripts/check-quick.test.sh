#!/usr/bin/env bash
# Checks check-quick.sh in a scratch repo with stub pnpm/node/shellcheck commands that log what they were asked to run.
set -euo pipefail
# The merge gate runs this with BOSSMAN_MERGE_CHECK set; the cases below set it themselves where they need it.
unset BOSSMAN_MERGE_CHECK CHECK_QUICK_FORCE_RELATED
here="$(cd "$(dirname "$0")" && pwd)"
t="$(mktemp -d)"; trap 'rm -rf "$t"' EXIT
fail() { echo "FAIL: $*"; exit 1; }

repo="$t/repo"; mkdir -p "$repo/scripts" "$t/bin"
cp "$here/check-quick.sh" "$here/check-all.sh" "$repo/scripts/"
cat >"$repo/scripts/check-shell.sh" <<'S'
#!/usr/bin/env bash
echo "check-shell" >>"$LOG"
S
chmod +x "$repo/scripts/check-shell.sh"
# Stubs: pnpm and node log their arguments; FAIL_ON makes a matching call exit 1.
cat >"$t/bin/pnpm" <<'S'
#!/usr/bin/env bash
echo "pnpm $*" >>"$LOG"
if [ -n "${FAIL_ON:-}" ] && [[ "$*" == *"$FAIL_ON"* ]]; then echo "boom"; exit 1; fi
S
cat >"$t/bin/node" <<'S'
#!/usr/bin/env bash
if [ "$1" = "-p" ]; then
  case "$2" in *apps/web*) echo @boss-man/web;; *apps/server*) echo @boss-man/server;; *apps/site*) echo @boss-man/site;; *packages/shared*) echo @boss-man/shared;; *) echo @boss-man/other;; esac
  exit 0
fi
echo "node $*" >>"$LOG"
S
chmod +x "$t/bin/pnpm" "$t/bin/node"
unset BOSSMAN_MERGE_CHECK CHECK_QUICK_FORCE_RELATED CHECK_QUICK_BROAD_FILES CHECK_ALL_FORCE
export PATH="$t/bin:$PATH" LOG="$t/log" CHECK_ALL_LOCK="$t/lock" CHECK_ALL_PAIR_PROOF="$t/proof" CHECK_ALL_QUEUE_REPORT=1

g() { git -C "$repo" -c user.name=t -c user.email=t@t "$@"; }
g init -q -b main; echo a >"$repo/README"; g add -A; g commit -q -m init
g update-ref refs/remotes/origin/main HEAD
g checkout -q -b feature

commit() { # commit <file>...: add or modify files
  local f; for f in "$@"; do mkdir -p "$repo/$(dirname "$f")"; echo "$RANDOM" >>"$repo/$f"; done
  g add -A; g commit -q -m change
}
# run <expected rc> <label> [env VAR=value ...]
run() {
  local want=$1 label=$2 rc=0; shift 2
  : >"$LOG"
  (cd "$repo" && env "$@" ./scripts/check-quick.sh >"$t/out" 2>&1) || rc=$?
  [ "$rc" -eq "$want" ] || fail "$label: rc $rc, want $want: $(cat "$t/out")"
}
logged() { grep -qF -- "$1" "$LOG" || fail "$2: expected '$1' in: $(cat "$LOG") / $(cat "$t/out")"; }
notlogged() { ! grep -qF -- "$1" "$LOG" || fail "$2: unexpected '$1' in: $(cat "$LOG")"; }

run 0 "no changes" env; grep -q "nothing changed" "$t/out" || fail "no changes message"

commit apps/web/src/a.ts
run 0 "web change" env
logged "pnpm --filter @boss-man/web typecheck" "web"
logged "pnpm --filter @boss-man/web exec vitest related --run src/a.ts" "web"
logged "pnpm --filter @boss-man/web build" "web"
notlogged "@boss-man/server" "web"
notlogged "check-shell" "web"
grep -q "^PASS  typecheck @boss-man/web" "$t/out" || fail "PASS line"

commit apps/server/drizzle/0099_x.sql apps/server/src/b.ts
run 0 "server and migration change" env
logged "node scripts/lint-migrations.mjs" "migration"
logged "pnpm --filter @boss-man/server typecheck" "server"
logged "vitest related --run src/b.ts" "server"

commit scripts/x.sh
run 0 "shell change" env
logged "check-shell" "shell"

commit packages/shared/src/c.ts
run 0 "shared change touches every package" env
logged "pnpm --filter @boss-man/server typecheck" "shared"
logged "pnpm --filter @boss-man/other typecheck" "shared"

run 1 "typecheck fails" env FAIL_ON=typecheck
grep -q "^FAIL  typecheck" "$t/out" || fail "FAIL line: $(cat "$t/out")"
grep -q boom "$t/out" || fail "failure output not shown"
logged "build" "later steps still run after a failure"

# The heavy steps wait for the check slot: hold it here, and check-quick must queue (and say so) instead of running.
if command -v flock >/dev/null; then
  g checkout -q -B slot origin/main; commit apps/web/src/s.ts
  : >"$LOG"
  (exec 8>"$t/lock.slot.1"; flock 8; sleep 8) & holder=$!
  sleep 1
  (cd "$repo" && ./scripts/check-quick.sh >"$t/out" 2>&1) & cq=$!
  sleep 4
  grep -q "waiting for a free check slot (place" "$t/out" || fail "no slot wait message: $(cat "$t/out")"
  ! grep -q typecheck "$LOG" || fail "typecheck ran without the slot: $(cat "$LOG")"
  rc=0; wait "$cq" || rc=$?; wait "$holder" || true
  [ "$rc" -eq 0 ] || fail "queued run rc $rc: $(cat "$t/out")"
  logged "pnpm --filter @boss-man/web typecheck" "ran after the slot freed"
  grep -q "^PASS  typecheck @boss-man/web" "$t/out" || fail "queued PASS line: $(cat "$t/out")"

  # A lost slot wait (check-all exit 75, nothing ran) is not a failure: check-quick says so and exits 75, which the
  # merge gate retries, keeping check-all's "gave up waiting" line it matches on. A real failure elsewhere still wins (exit 1).
  (exec 8>"$t/lock.slot.1"; flock 8; sleep 6) & holder=$!
  sleep 1
  run 75 "lost slot wait" CHECK_ALL_LOCK_WAIT=2
  grep -q "^SKIP  heavy phase (typecheck, related tests): gave up waiting for a check slot (nothing ran)" "$t/out" || fail "no SKIP line: $(cat "$t/out")"
  grep -q "check-all: gave up waiting for the heavy-phase lock" "$t/out" || fail "gate wording lost: $(cat "$t/out")"
  ! grep -q "check-quick: FAILED" "$t/out" || fail "lost wait reported as FAILED: $(cat "$t/out")"
  notlogged "typecheck" "lost slot wait"
  logged "pnpm --filter @boss-man/web build" "steps after a lost wait still run"
  run 1 "lost slot wait plus a failed build" CHECK_ALL_LOCK_WAIT=2 FAIL_ON=build
  grep -q "^SKIP  heavy phase" "$t/out" || fail "no SKIP line with a failure: $(cat "$t/out")"
  grep -q "^FAIL  build web" "$t/out" || fail "build FAIL line: $(cat "$t/out")"
  grep -q "check-quick: FAILED" "$t/out" || fail "no FAILED summary: $(cat "$t/out")"
  wait "$holder" || true

  # check-all killed by a signal while it waits: a FAIL line names the signal (it used to be a bare "check-quick: FAILED").
  (exec 8>"$t/lock.slot.1"; flock 8; sleep 8) & holder=$!
  sleep 1
  : >"$LOG"
  (cd "$repo" && ./scripts/check-quick.sh >"$t/out" 2>&1) & cq=$!
  for _ in 1 2 3 4 5 6 7 8 9 10; do grep -q "waiting for a free check slot" "$t/out" && break; sleep 0.5; done
  kill -TERM $(pgrep -f "$repo/scripts/check-all.sh") || fail "no check-all to signal: $(cat "$t/out")"
  rc=0; wait "$cq" || rc=$?; wait "$holder" || true
  [ "$rc" -eq 1 ] || fail "signalled run rc $rc: $(cat "$t/out")"
  grep -q "^FAIL  heavy phase (typecheck, related tests): killed by signal TERM (exit 143)" "$t/out" || fail "no signal FAIL line: $(cat "$t/out")"
  notlogged "typecheck" "signalled run"
fi

# A broad related-test list is skipped (exit 0), typecheck still runs; CHECK_QUICK_FORCE_RELATED=1 runs it.
g checkout -q -B broad origin/main; commit apps/server/src/mcp.ts
run 0 "mcp.ts is broad" env
grep -qF "SKIP related tests: too broad for a hand run, the merge gate runs them" "$t/out" || fail "no SKIP line: $(cat "$t/out")"
notlogged "vitest related" "broad skip"
logged "pnpm --filter @boss-man/server typecheck" "broad skip keeps typecheck"
run 0 "forced related" env CHECK_QUICK_FORCE_RELATED=1
logged "vitest related --run src/mcp.ts" "forced"
# The merge gate runs check-quick with BOSSMAN_MERGE_CHECK=1: it must still run the related tests for mcp.ts.
run 0 "merge check runs broad tests" env BOSSMAN_MERGE_CHECK=1
logged "vitest related --run src/mcp.ts" "merge check"
! grep -q "SKIP related" "$t/out" || fail "merge check skipped: $(cat "$t/out")"
g checkout -q -B many origin/main
many=(); for i in $(seq 1 16); do many+=("apps/server/src/m$i.ts"); done; commit "${many[@]}"
run 0 "16 files is broad" env
notlogged "vitest related" "16 files"
g checkout -q -B few origin/main
many=(); for i in $(seq 1 15); do many+=("apps/server/src/m$i.ts"); done; commit "${many[@]}"
run 0 "15 files is not broad" env
logged "vitest related" "15 files"

# A branch that conflicts with the base
g checkout -q main; echo main >"$repo/README"; g add -A; g commit -q -m m; g update-ref refs/remotes/origin/main HEAD
g checkout -q feature; echo feature >"$repo/README"; g add -A; g commit -q -m f
run 1 "merge conflict" env
grep -q "^FAIL  merge with origin/main" "$t/out" || fail "conflict not reported: $(cat "$t/out")"
echo "check-quick.test.sh: ok"
