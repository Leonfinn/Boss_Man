#!/usr/bin/env bash
# Checks check-quick.sh in a scratch repo with stub pnpm/node/shellcheck commands that log what they were asked to run.
set -euo pipefail
# The merge gate runs this with BOSSMAN_MERGE_CHECK set; the cases below set it themselves where they need it.
unset BOSSMAN_MERGE_CHECK CHECK_QUICK_FORCE_RELATED
# Test this branch's slot wait, not the runner's shared check-slot.sh (BOS-614).
unset BOSSMAN_CHECK_SLOT BOSSMAN_CHECK_SLOT_HELD CHECK_ALL_PRE_DONE
here="$(cd "$(dirname "$0")" && pwd)"
t="$(mktemp -d)"; holder=""; trap '[ -z "$holder" ] || kill "$holder" 2>/dev/null; rm -rf "$t"' EXIT
fail() { echo "FAIL: $*"; exit 1; }

repo="$t/repo"; mkdir -p "$repo/scripts" "$t/bin"
cp "$here/check-quick.sh" "$here/check-all.sh" "$here/check-slot.sh" "$here/check-guards.sh" "$here/install-packages.sh" "$repo/scripts/"
cat >"$repo/scripts/check-shell.sh" <<'S'
#!/usr/bin/env bash
echo "check-shell" >>"$LOG"
S
chmod +x "$repo/scripts/check-shell.sh"
# Stubs: pnpm and node log their arguments; FAIL_ON makes a matching call exit 1.
cat >"$t/bin/pnpm" <<'S'
#!/usr/bin/env bash
echo "pnpm $*" >>"$LOG"
echo "threads=${BOSSMAN_CHECK_THREADS:-} go=${GOMAXPROCS:-} rayon=${RAYON_NUM_THREADS:-} tokio=${TOKIO_WORKER_THREADS:-} for $*" >>"$LOG"
# FAIL_ONCE=<file>: the first matching call fails (and makes the file), later ones pass (BOS-1628).
if [ -n "${FAIL_ONCE:-}" ] && [[ "$*" == *install* ]] && [ ! -e "$FAIL_ONCE" ]; then : >"$FAIL_ONCE"; echo "${FAIL_MSG:-boom}"; exit 1; fi
if [ -n "${FAIL_ON:-}" ] && [[ "$*" == *"$FAIL_ON"* ]]; then echo "${FAIL_MSG:-boom}"; exit 1; fi
S
cat >"$t/bin/node" <<'S'
#!/usr/bin/env bash
if [ "$1" = "-p" ]; then
  case "$2" in *apps/web*) echo @boss-man/web;; *apps/server*) echo @boss-man/server;; *apps/site*) echo @boss-man/site;; *packages/shared*) echo @boss-man/shared;; *) echo @boss-man/other;; esac
  exit 0
fi
echo "node $*" >>"$LOG"
# scripts/rebase-migrations.mjs: REBASE_OUT is what it prints, REBASE_RC its exit code (BOS-1048).
if [[ "$1" == *rebase-migrations.mjs ]]; then printf '%s\n' "${REBASE_OUT:-none: nothing to renumber.}"; exit "${REBASE_RC:-0}"; fi
if [ -n "${FAIL_ON:-}" ] && [[ "$*" == *"$FAIL_ON"* ]]; then echo "boom"; exit 1; fi
S
chmod +x "$t/bin/pnpm" "$t/bin/node"
unset BOSSMAN_MERGE_CHECK CHECK_QUICK_FORCE_RELATED CHECK_QUICK_BROAD_FILES CHECK_ALL_FORCE
unset CHECK_ALL_SLOT_LOG
# Most cases re-run one tree with different settings, so they switch off reuse; the reuse cases below set CHECK_QUICK_RERUN= .
export PATH="$t/bin:$PATH" LOG="$t/log" CHECK_ALL_LOCK="$t/lock" CHECK_ALL_PAIR_PROOF="$t/proof" CHECK_ALL_QUEUE_REPORT=1 CHECK_QUICK_RERUN=1

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
# BOS-1727: the list guards run first, each only for the files it reads, and a failure names the file and the line to add.
logged "pnpm --filter @boss-man/web exec vitest run test/screen-inventory.test.ts" "guard: screen inventory for a web change"
notlogged "test/owner-control-list.test.ts" "guard: owner controls not for a change outside pages and components"
notlogged "test/wake-classes.test.ts" "guard: wake classes not for a web-only change"
[ "$(grep -n 'PASS  guard: screen inventory' "$t/out" | cut -d: -f1)" -lt "$(grep -n 'PASS  merge with' "$t/out" | cut -d: -f1)" ] || fail "guards must print before the merge step: $(cat "$t/out")"
run 1 "screen inventory guard fails" env FAIL_ON=screen-inventory.test
grep -q "^FAIL  guard: screen inventory" "$t/out" || fail "guard FAIL line: $(cat "$t/out")"
grep -qF "screen-inventory.txt is out of date" "$t/out" || fail "guard hint names the file: $(cat "$t/out")"
grep -qF "vitest run test/screen-inventory.test.ts -u" "$t/out" || fail "guard hint gives the command: $(cat "$t/out")"
commit apps/web/src/pages/P.tsx
run 0 "a page change" env
logged "pnpm --filter @boss-man/server exec vitest run test/owner-control-list.test.ts" "guard: owner controls for a page change"
run 1 "owner controls guard fails" env FAIL_ON=owner-control-list.test
grep -qF "packages/shared/src/owner-controls.ts" "$t/out" || fail "owner-controls hint names the file: $(cat "$t/out")"
# BOS-979: the secrets scan runs only when the branch has the script, and a finding fails the check.
notlogged "scan-added-lines" "no scan script, no scan step"
mkdir -p "$repo/scripts"; echo "// stub" >"$repo/scripts/scan-added-lines.mjs"; g add -A; g commit -q -m "scan script"
run 0 "scan step" env
logged "node scripts/scan-added-lines.mjs origin/main" "scan step"
grep -q "^PASS  secrets scan" "$t/out" || fail "scan PASS line"
run 1 "scan finding" env FAIL_ON=scan-added-lines
grep -q "^FAIL  secrets scan" "$t/out" || fail "scan FAIL line"
# The owner's list is never handled here (the runner scans with its own copy): a stray variable is not turned into a file.
run 0 "scan list" env BOSSMAN_SCAN_DENYLIST="ip	192.0.2.77"
notlogged "scanenv" "no list handling in this script"
grep -q "^PASS  typecheck @boss-man/web" "$t/out" || fail "PASS line"
# One CPU budget (BOS-674) reaches every step, inside the slot and out: the stub node prints nothing, so the fallback 2 applies;
# BOSSMAN_CHECK_THREADS sets it.
logged "threads=2 go=2 rayon=2 tokio=2 for --filter @boss-man/web typecheck" "default budget in the slot"
logged "threads=2 go=2 rayon=2 tokio=2 for --filter @boss-man/web build" "default budget for the build"
run 0 "set budget" env BOSSMAN_CHECK_THREADS=3
logged "threads=3 go=3 rayon=3 tokio=3 for --filter @boss-man/web exec vitest related" "set budget in the slot"
logged "threads=3 go=3 rayon=3 tokio=3 for --filter @boss-man/web build" "set budget for the build"

commit apps/server/drizzle/0099_x.sql apps/server/src/b.ts
run 0 "server and migration change" env
logged "node scripts/lint-migrations.mjs" "migration"
logged "pnpm --filter @boss-man/server typecheck" "server"
logged "vitest related --run src/b.ts" "server"
logged "pnpm --filter @boss-man/server exec vitest run test/wake-classes.test.ts" "guard: wake classes for a server change"
run 1 "wake classes guard fails" env FAIL_ON=wake-classes.test
grep -qF "WAKE_CLASS in apps/server/src/services/wake-classes.ts" "$t/out" || fail "wake hint names the file: $(cat "$t/out")"

commit scripts/x.sh
run 0 "shell change" env
logged "check-shell" "shell"

commit packages/shared/src/c.ts
run 0 "shared change touches every package" env
logged "pnpm --filter @boss-man/server typecheck" "shared"
logged "pnpm --filter @boss-man/other typecheck" "shared"

# The full check runs next (merge gate, high/critical, BOS-665): only the cheap steps run, and they still fail the run.
commit apps/server/drizzle/0100_y.sql apps/web/src/d.ts scripts/y.sh scripts/z.mjs
run 0 "full check next" env BOSSMAN_MERGE_CHECK=1 BOSSMAN_FULL_CHECK_NEXT=1
grep -q "^PASS  merge with origin/main is clean" "$t/out" || fail "full check next: no merge step: $(cat "$t/out")"
logged "node scripts/lint-migrations.mjs" "full check next keeps migration lint"
logged "node --test" "full check next keeps script tests"
for s in typecheck "vitest related" build check-shell; do notlogged "$s" "full check next"; done
grep -q "^SKIP  typecheck, related tests, ShellCheck, web build: the full check runs next" "$t/out" || fail "no SKIP line: $(cat "$t/out")"
run 1 "full check next, migration lint fails" env BOSSMAN_FULL_CHECK_NEXT=1 FAIL_ON=lint-migrations
grep -q "^FAIL  migration lint" "$t/out" || fail "lint failure not reported: $(cat "$t/out")"
grep -q "check-quick: FAILED" "$t/out" || fail "no FAILED summary: $(cat "$t/out")"
notlogged "typecheck" "full check next, failing"

run 1 "typecheck fails" env FAIL_ON=typecheck
grep -q "^FAIL  typecheck" "$t/out" || fail "FAIL line: $(cat "$t/out")"
grep -q boom "$t/out" || fail "failure output not shown"
logged "build" "later steps still run after a failure"

# The heavy steps wait for the check slot: hold it here, and check-quick must queue (and say so) instead of running.
# No fixed sleeps: on a loaded runner check-quick can take many seconds to reach the heavy phase (BOS-607 review).
if command -v flock >/dev/null; then
  # hold_slot: take the check slot and keep it until release_slot. The subshell execs into the sleep, so $holder is the
  # process that owns the lock; returns once the lock is really held.
  hold_slot() {
    (exec 8>"$t/lock.slot.1"; flock 8; exec sleep 600) & holder=$!
    local _; for _ in $(seq 1 600); do flock -n "$t/lock.slot.1" true || return 0; sleep 0.1; done
    fail "slot holder never took the lock"
  }
  release_slot() { kill "$holder" 2>/dev/null || true; wait "$holder" 2>/dev/null || true; holder=""; }
  # wait_for_slot_wait: up to 60 s for the background check-quick ($cq) to say it is queued.
  wait_for_slot_wait() {
    local _; for _ in $(seq 1 600); do
      grep -q "waiting for a free check slot (place" "$t/out" && return 0
      kill -0 "$cq" 2>/dev/null || break; sleep 0.1
    done
    fail "$1: no 'waiting for a free check slot' line within 60 s: $(cat "$t/out")"
  }

  g checkout -q -B slot origin/main; commit apps/web/src/s.ts
  : >"$LOG"
  hold_slot
  (cd "$repo" && ./scripts/check-quick.sh >"$t/out" 2>&1) & cq=$!
  wait_for_slot_wait "queued run"
  ! grep -q typecheck "$LOG" || fail "typecheck ran without the slot: $(cat "$LOG")"
  release_slot
  rc=0; wait "$cq" || rc=$?
  [ "$rc" -eq 0 ] || fail "queued run rc $rc: $(cat "$t/out")"
  logged "pnpm --filter @boss-man/web typecheck" "ran after the slot freed"
  grep -q "^PASS  typecheck @boss-man/web" "$t/out" || fail "queued PASS line: $(cat "$t/out")"

  # A lost slot wait (check-all exit 75, nothing ran) is not a failure: check-quick says so and exits 75, which the
  # merge gate retries, keeping check-all's "gave up waiting" line it matches on. A real failure elsewhere still wins (exit 1).
  hold_slot
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
  release_slot

  # check-all killed by a signal while it waits: a FAIL line names the signal (it used to be a bare "check-quick: FAILED").
  hold_slot
  : >"$LOG"
  (cd "$repo" && ./scripts/check-quick.sh >"$t/out" 2>&1) & cq=$!
  wait_for_slot_wait "signalled run"
  mapfile -t pids < <(pgrep -f "$repo/scripts/check-all.sh" || true)
  [ "${#pids[@]}" -gt 0 ] || fail "no check-all process to signal: $(cat "$t/out")"
  kill -TERM "${pids[@]}"
  rc=0; wait "$cq" || rc=$?
  release_slot
  [ "$rc" -eq 1 ] || fail "signalled run rc $rc: $(cat "$t/out")"
  grep -q "^FAIL  heavy phase (typecheck, related tests): killed by signal TERM (exit 143)" "$t/out" || fail "no signal FAIL line: $(cat "$t/out")"
  notlogged "typecheck" "signalled run"
fi

# Whole-repo tests (BOS-1732): at the merge gate every test of a touched package that reads repo files by path, or renders the
# built web app in a browser, runs; found by what the file contains, so new tests need no list. A hand run skips them.
# The test files live in the base commit (they are not what the branch changes), as in a real repo.
g checkout -q main
wr() { mkdir -p "$repo/$(dirname "$1")"; printf '%s\n' "$2" >"$repo/$1"; }
wr apps/server/test/ratchet.test.ts 'import { readFileSync } from "node:fs"; const root = new URL(".", import.meta.url); readFileSync(root);'
wr apps/server/test/plain.test.ts 'import { readFileSync } from "node:fs"; readFileSync("/tmp/fixture-made-by-the-test");'
wr apps/server/test/locate-only.test.ts 'const here = __dirname; it("x", () => here);'
wr apps/web/test/scan.ts 'import { readdirSync } from "node:fs"; export const SRC = new URL("..", import.meta.url); readdirSync(SRC);'
wr apps/web/test/inventory.test.ts 'import { SRC } from "./scan"; it("x", () => SRC);'
wr apps/web/test/shell-layout.test.ts 'import { launch } from "./real-page"; await launch();'
wr apps/web/test/pure.test.ts 'it("adds", () => 1 + 1);'
wr apps/runner/test/fence.test.ts '// mentions chromium only in a comment'
g add -A; g commit -q -m "test files"; g update-ref refs/remotes/origin/main HEAD
wrt() { grep -qF "$1" "$t/out" || fail "$2: expected '$1' in: $(cat "$t/out")"; }
# Not at the gate and not asked for: skipped.
g checkout -q -B wr1 origin/main; commit apps/server/src/other.ts
run 0 "a hand run leaves whole-repo tests out" env
notlogged "ratchet.test.ts" "hand run whole-repo"
# At the gate: the server's reading tests run, as one named-file run from the package; a test that reads only its own fixture
# and a test that only finds its folder do not.
run 0 "the gate runs the whole-repo tests of a touched package" env BOSSMAN_MERGE_CHECK=1
logged "pnpm --filter @boss-man/server exec vitest run test/ratchet.test.ts" "gate server"
notlogged "plain.test.ts" "gate server plain"
notlogged "locate-only.test.ts" "gate server locate-only"
notlogged "@boss-man/web exec vitest run" "gate untouched web package"
notlogged "@boss-man/runner exec vitest run" "gate untouched runner package"
wrt "PASS  whole-repo tests (apps/server, 1 files)" "gate PASS line"
# CHECK_QUICK_WHOLE_REPO=1 asks for them in a hand run.
run 0 "a hand run can ask for them" env CHECK_QUICK_WHOLE_REPO=1
logged "pnpm --filter @boss-man/server exec vitest run test/ratchet.test.ts" "asked for"
# A web change runs the browser tests and the tests that read through a helper; a pure test stays out.
g checkout -q -B wr2 origin/main; commit apps/web/src/lib/format.ts
run 0 "a web change at the gate" env BOSSMAN_MERGE_CHECK=1
logged "pnpm --filter @boss-man/web exec vitest run test/inventory.test.ts test/shell-layout.test.ts" "gate web"
notlogged "pure.test.ts" "gate web pure"
notlogged "@boss-man/server exec vitest run" "gate web only"
# The browser tests open apps/web/dist and skip without it: the build runs first, once, before the whole-repo run.
[ "$(grep -cF "pnpm --filter @boss-man/web build" "$LOG")" -eq 1 ] || fail "web built not exactly once: $(cat "$LOG")"
[ "$(grep -nF "pnpm --filter @boss-man/web build" "$LOG" | head -n 1 | cut -d: -f1)" -lt "$(grep -nF "pnpm --filter @boss-man/web exec vitest run test/inventory" "$LOG" | head -n 1 | cut -d: -f1)" ] || fail "web build after the browser tests: $(cat "$LOG")"
# A hand run (no whole-repo tests) still builds after the slot, as before.
run 0 "a hand run of a web change builds once" env
[ "$(grep -cF "pnpm --filter @boss-man/web build" "$LOG")" -eq 1 ] || fail "hand run: web built not exactly once: $(cat "$LOG")"
# A failing whole-repo test fails the check.
run 1 "a failing whole-repo test fails the gate" env BOSSMAN_MERGE_CHECK=1 FAIL_ON=inventory.test
grep -q "^FAIL  whole-repo tests (apps/web" "$t/out" || fail "no FAIL line: $(cat "$t/out")"
# A shared change touches every package.
g checkout -q -B wr3 origin/main; commit packages/shared/src/other.ts
run 0 "a shared change at the gate" env BOSSMAN_MERGE_CHECK=1
logged "@boss-man/server exec vitest run test/ratchet.test.ts" "gate shared server"
logged "@boss-man/web exec vitest run" "gate shared web"
g checkout -q -B feature origin/main

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

# A fresh tree with no node_modules (BOS-952: the server-owned check queue runs check-quick in a new worktree) installs the
# packages first, before typecheck, the related tests and the web build; a tree that has node_modules does not.
inst="pnpm install --frozen-lockfile --prefer-offline"
g checkout -q -B fresh origin/main; commit apps/web/src/f.ts
run 0 "fresh tree installs" env
logged "$inst" "fresh tree"
grep -q "^PASS  install packages (fresh tree, no node_modules)" "$t/out" || fail "fresh tree: no install PASS line: $(cat "$t/out")"
[ "$(grep -n "^pnpm install" "$LOG" | head -n 1 | cut -d: -f1)" -lt "$(grep -n "^pnpm --filter @boss-man/web typecheck" "$LOG" | cut -d: -f1)" ] \
  || fail "fresh tree: install did not come before typecheck: $(cat "$LOG")"
logged "pnpm --filter @boss-man/web build" "fresh tree still builds"
mkdir "$repo/node_modules"; echo node_modules >"$repo/.git/info/exclude"
run 0 "tree with node_modules does not install" env
notlogged "pnpm install" "node_modules present"
logged "pnpm --filter @boss-man/web typecheck" "node_modules present"
rm -rf "$repo/node_modules"
# The install failing is reported, and the steps that need packages are skipped rather than queued for a slot.
run 1 "failed install" env FAIL_ON=install
grep -q "^FAIL  install packages" "$t/out" || fail "failed install: no FAIL line: $(cat "$t/out")"
grep -q "^SKIP  typecheck, related tests, web build: the install failed" "$t/out" || fail "failed install: no SKIP line: $(cat "$t/out")"
for s in typecheck "vitest related" build; do notlogged "$s" "failed install"; done
grep -q "check-quick: FAILED" "$t/out" || fail "failed install: no FAILED summary: $(cat "$t/out")"
[ "$(grep -c "^pnpm install" "$LOG")" -eq 1 ] || fail "failed install (not a machine error) was retried: $(cat "$LOG")"
# BOS-1628: an install that dies of the machine (EAGAIN) is tried again with fewer files at once, and passes the second time.
eagain="ERR_PNPM_EAGAIN: resource temporarily unavailable, copyfile 'store/v10/files/ab' -> 'job/node_modules/.pnpm/ab'"
rm -f "$t/once"
run 0 "EAGAIN once" env CHECK_QUICK_INSTALL_PAUSE=0 FAIL_ONCE="$t/once" FAIL_MSG="$eagain"
grep -q "^PASS  install packages" "$t/out" || fail "EAGAIN once: no install PASS: $(cat "$t/out")"
logged "pnpm install --frozen-lockfile --prefer-offline --network-concurrency 2 --child-concurrency 1" "EAGAIN once: gentler retry"
logged "pnpm --filter @boss-man/web typecheck" "EAGAIN once: later steps still run"
# Still failing after three tries: exit 75 and the marker the server reads, never the plain FAILED line.
run 75 "EAGAIN always" env CHECK_QUICK_INSTALL_PAUSE=0 FAIL_ON=install FAIL_MSG="$eagain"
[ "$(grep -c "^pnpm install" "$LOG")" -eq 3 ] || fail "EAGAIN always: not three tries: $(cat "$LOG")"
grep -q "^check-quick: install stopped on a machine fault" "$t/out" || fail "EAGAIN always: no marker: $(cat "$t/out")"
! grep -q "check-quick: FAILED" "$t/out" || fail "EAGAIN always: said FAILED: $(cat "$t/out")"
# A change with no pnpm step (a shell script only) installs nothing.
g checkout -q -B freshsh origin/main; commit scripts/only.sh
run 0 "shell-only change does not install" env
notlogged "pnpm install" "shell only"
# The full check runs next (it installs itself): no install here.
g checkout -q fresh
run 0 "full check next does not install" env BOSSMAN_MERGE_CHECK=1 BOSSMAN_FULL_CHECK_NEXT=1
notlogged "pnpm install" "full check next"
# The install runs before the slot wait, so it never holds a check slot.
if command -v flock >/dev/null; then
  : >"$LOG"
  hold_slot
  (cd "$repo" && ./scripts/check-quick.sh >"$t/out" 2>&1) & cq=$!
  wait_for_slot_wait "install before the slot"
  logged "$inst" "install before the slot"
  notlogged "typecheck" "install before the slot"
  release_slot
  rc=0; wait "$cq" || rc=$?
  [ "$rc" -eq 0 ] || fail "install before the slot: rc $rc: $(cat "$t/out")"
fi

# Reuse (BOS-666): a pass on a clean tree is written to the slot log; the next run of the same tree and base reuses it.
sl="$t/lock.slotlog"; npass() { grep -c " quick-pass " "$sl" || true; }
g checkout -q -B reuse origin/main; commit apps/web/src/r.ts
rm -f "$sl"; tr1="$(g rev-parse 'HEAD^{tree}')"; b1="$(g rev-parse origin/main)"
run 0 "reuse: first run" CHECK_QUICK_RERUN=
logged "pnpm --filter @boss-man/web typecheck" "reuse: first run runs"
grep -Eq "^[0-9TZ:-]+ quick-pass pid=[0-9]+ kind=hand check=quick tree=$tr1 base=$b1 coverage=all folder=" "$sl" || fail "reuse: no quick-pass line: $(cat "$sl" 2>&1)"
if command -v flock >/dev/null; then
  grep -Eq " start pid=[0-9]+ kind=hand slot=1 check=quick tree=$tr1 folder=" "$sl" || fail "reuse: slot hold not named check=quick tree=: $(cat "$sl")"
fi
run 0 "reuse: same tree" CHECK_QUICK_RERUN=
notlogged "pnpm" "reuse: same tree ran again"
grep -q "^PASS  reused: this exact tree ($tr1) already passed" "$t/out" || fail "reuse: no reused line: $(cat "$t/out")"
grep -q "^check-quick: all steps passed" "$t/out" || fail "reuse: no summary: $(cat "$t/out")"
grep -Eq " quick-reuse pid=[0-9]+ kind=hand check=quick tree=$tr1 base=$b1 coverage=all " "$sl" || fail "reuse: not counted: $(cat "$sl")"
[ "$(npass)" = 1 ] || fail "reuse: a reuse wrote a second pass line: $(cat "$sl")"
# CHECK_QUICK_RERUN=1 runs anyway, and a failure records no pass.
run 1 "reuse: rerun" FAIL_ON=typecheck
[ "$(npass)" = 1 ] || fail "reuse: a failed run recorded a pass: $(cat "$sl")"
# The merge gate never reuses.
run 0 "reuse: merge gate" CHECK_QUICK_RERUN= BOSSMAN_MERGE_CHECK=1
logged "pnpm --filter @boss-man/web typecheck" "reuse: merge gate reused a pass"
# Another base commit runs again, even with the same files (here a second commit with origin/main's tree).
g update-ref refs/heads/base2 "$(g commit-tree -p origin/main -m same-files 'origin/main^{tree}')"
run 0 "reuse: other base" CHECK_QUICK_RERUN= BASE=base2
logged "pnpm --filter @boss-man/web typecheck" "reuse: other base reused"
# An uncommitted change runs again and records nothing; so does an untracked file.
echo x >>"$repo/apps/web/src/r.ts"; n0="$(npass)"
run 0 "reuse: dirty" CHECK_QUICK_RERUN=
logged "pnpm --filter @boss-man/web typecheck" "reuse: dirty tree reused"
[ "$(npass)" = "$n0" ] || fail "reuse: a dirty tree recorded a pass: $(cat "$sl")"
if command -v flock >/dev/null; then tail -n 1 "$sl" | grep -q " check=quick tree=$tr1-dirty folder=" || fail "reuse: dirty hold not marked: $(tail -n 2 "$sl")"; fi
g checkout -q -- apps/web/src/r.ts; echo y >"$repo/apps/web/src/new.ts"
run 0 "reuse: untracked" CHECK_QUICK_RERUN=
logged "pnpm --filter @boss-man/web typecheck" "reuse: untracked file reused"
rm -f "$repo/apps/web/src/new.ts"
# A new commit (any change to the tree) runs again.
commit apps/web/src/r.ts
run 0 "reuse: changed tree" CHECK_QUICK_RERUN=
logged "pnpm --filter @boss-man/web typecheck" "reuse: changed tree reused"
# A pass that skipped a broad test list (coverage=partial) is reused by a plain run, never by CHECK_QUICK_FORCE_RELATED=1.
g checkout -q -B reuse-broad origin/main; commit apps/server/src/mcp.ts
run 0 "reuse: broad first" CHECK_QUICK_RERUN=
grep -q " quick-pass .* tree=$(g rev-parse 'HEAD^{tree}') .* coverage=partial " "$sl" || fail "reuse: partial not recorded: $(cat "$sl")"
run 0 "reuse: broad again" CHECK_QUICK_RERUN=
notlogged "pnpm" "reuse: broad pass not reused"
run 0 "reuse: forced after partial" CHECK_QUICK_RERUN= CHECK_QUICK_FORCE_RELATED=1
logged "vitest related --run src/mcp.ts" "reuse: forced run reused a partial pass"
run 0 "reuse: plain after forced" CHECK_QUICK_RERUN=
notlogged "pnpm" "reuse: full pass not reused"
run 0 "reuse: forced after forced" CHECK_QUICK_RERUN= CHECK_QUICK_FORCE_RELATED=1
notlogged "pnpm" "reuse: forced run did not reuse a coverage=all pass"

# A branch that conflicts with the base
g checkout -q main; echo main >"$repo/README"; g add -A; g commit -q -m m; g update-ref refs/remotes/origin/main HEAD
g checkout -q feature; echo feature >"$repo/README"; g add -A; g commit -q -m f
run 1 "merge conflict" env
grep -q "^FAIL  merge with origin/main" "$t/out" || fail "conflict not reported: $(cat "$t/out")"

# A ticket's kept scratch (BOSSMAN_SCRATCH, BOS-592): the whole output of the run is kept there, marked with its exit,
# and the previous run is kept as .previous.
g checkout -q -B scratch origin/main; commit apps/web/src/q.ts
scratch="$t/scratch.own"; mkdir -p "$scratch"
run 0 "scratch: a passing run" env BOSSMAN_SCRATCH="$scratch"
[ -s "$scratch/check-quick.log" ] || fail "scratch: no log in the scratch: $(cat "$t/out")"
grep -q "PASS  typecheck @boss-man/web" "$scratch/check-quick.log" || fail "scratch: the log misses the run's output: $(cat "$scratch/check-quick.log")"
grep -q "check-quick: finished .* (exit 0)" "$scratch/check-quick.log" || fail "scratch: the log is not marked finished"
run 1 "scratch: a failing run" env BOSSMAN_SCRATCH="$scratch" FAIL_ON=typecheck
grep -q "(exit 1)" "$scratch/check-quick.log" || fail "scratch: a failure's log is not marked with its exit: $(cat "$scratch/check-quick.log")"
grep -q "PASS  typecheck @boss-man/web" "$scratch/check-quick.log.previous" || fail "scratch: the previous run's log is not kept: $(ls "$scratch")"

# Compose files and workflows (BOS-1036): scripts/check-compose.sh runs when one changed. Exit 3 = tools missing = SKIP, other = FAIL.
cat >"$repo/scripts/check-compose.sh" <<'S'
#!/usr/bin/env bash
echo "check-compose" >>"$LOG"
case "${COMPOSE_STUB:-}" in
  missing) echo "check-compose: docker CLI or compose plugin not installed"; exit 3;;
  bad) echo "FAIL  compose set [docker-compose.yml]"; echo "yaml: line 12: did not find expected key"; exit 1;;
esac
S
chmod +x "$repo/scripts/check-compose.sh"
# The stub belongs to the base, as the real script does: commit it on main and move origin/main with it.
g checkout -q main; g add -A; g commit -q -m "stub check-compose"; g update-ref refs/remotes/origin/main HEAD
g checkout -q -B compose origin/main; commit docker-compose.yml
run 0 "compose: valid files" env
logged "check-compose" "compose: validator runs for docker-compose.yml"
grep -q "^PASS  compose files and CI workflows" "$t/out" || fail "compose: no PASS line: $(cat "$t/out")"
run 1 "compose: invalid file" env COMPOSE_STUB=bad
{ grep -q "^FAIL  compose files and CI workflows" "$t/out" && grep -q "yaml: line 12" "$t/out"; } || fail "compose: failure not shown with its line: $(cat "$t/out")"
run 0 "compose: tools missing" env COMPOSE_STUB=missing
grep -q "^SKIP  compose and workflow validation" "$t/out" || fail "compose: no SKIP line: $(cat "$t/out")"
g checkout -q -B wf origin/main; commit .github/workflows/ci.yml
run 0 "workflow" env; logged "check-compose" "workflow change runs the validator"
g checkout -q -B depl origin/main; commit deploy/truenas.yml
run 0 "deploy yml" env; logged "check-compose" "deploy/*.yml change runs the validator"
g checkout -q -B nocompose origin/main; commit apps/web/src/q2.ts
run 0 "no compose change" env; notlogged "check-compose" "unrelated change must not run the validator"

# A migration-only clash (BOS-1048): two branches both add migration 0141, so the journal conflicts. The step accepts it as the
# gate would and lints the rebuilt tree; a real conflict (a code file as well) still fails.
mig() { # mig <branch> <start> <name> <readme text>: add migration 0141_<name> and a journal line, on a new branch off <start>
  g checkout -q -B "$1" "$2"
  mkdir -p "$repo/apps/server/drizzle/meta"
  echo "-- $3" >"$repo/apps/server/drizzle/0141_$3.sql"
  echo "{\"tag\":\"0141_$3\"}" >>"$repo/apps/server/drizzle/meta/_journal.json"
  [ -z "$4" ] || echo "$4" >>"$repo/README"
  g add -A; g commit -q -m "migration $3"
}
start="$(g rev-parse origin/main)"
mig mainside "$start" other ""; g update-ref refs/remotes/origin/main HEAD
mig mine "$start" mine ""
tree="$(g rev-parse 'HEAD^{tree}')"
run 0 "journal-only clash" env REBASE_OUT="$(printf '0141_mine -> 0142_mine\nrebuilt tree: %s' "$tree")"
grep -q "^PASS  merge with origin/main is clean" "$t/out" || fail "clash: merge step not PASS: $(cat "$t/out")"
grep -q "migration 0141 (mine) will be renumbered to 0142 by the merge gate" "$t/out" || fail "clash: no renumber line: $(cat "$t/out")"
grep -q "^PASS  migration lint (on the tree the gate will build)" "$t/out" || fail "clash: lint not run on the rebuilt tree: $(cat "$t/out")"
# BOS-1258: this tree has no node_modules, and rebase-migrations.mjs needs tsx from it: the install must come first.
[ ! -d "$repo/node_modules" ] || fail "clash fixture has node_modules"
ilines="$(grep -n '^pnpm install' "$LOG" | head -1 | cut -d: -f1)"; nline="$(grep -n '^node scripts/rebase-migrations.mjs' "$LOG" | head -1 | cut -d: -f1)"
if ! { [ -n "$ilines" ] && [ -n "$nline" ] && [ "$ilines" -lt "$nline" ]; }; then fail "clash: install must run before rebase-migrations: $(cat "$LOG")"; fi
# A failed install is named as such, not counted as a migration clash.
run 1 "clash, install fails" env FAIL_ON=install REBASE_OUT="$(printf '0141_mine -> 0142_mine\nrebuilt tree: %s' "$tree")"
grep -q "package install failed (not a clash" "$t/out" || fail "clash: failed install not named: $(cat "$t/out")"
# the old plain merge-tree step failed on exactly this tree
g merge-tree --write-tree origin/main HEAD >/dev/null 2>&1 && fail "clash fixture is not a real conflict"
start="$(g rev-parse origin/main)"
mig mainside2 "$start" other2 "main line"; g update-ref refs/remotes/origin/main HEAD
mig mine2 "$start" mine2 "my line"
run 1 "real clash" env REBASE_RC=1 REBASE_OUT="refused: real code conflicts too: README"
grep -q "^FAIL  merge with origin/main is clean" "$t/out" || fail "real clash: merge step not FAIL: $(cat "$t/out")"
grep -q "refused: real code conflicts too" "$t/out" || fail "real clash: refusal reason not shown: $(cat "$t/out")"

echo "check-quick.test.sh: ok"
