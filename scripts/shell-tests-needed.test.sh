#!/usr/bin/env bash
# Tests scripts/shell-tests-needed.sh (BOS-1939): when a full merge check may skip ShellCheck and the shell tests.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
t="$(mktemp -d)"; trap 'rm -rf "$t"' EXIT
fail() { echo "FAIL: $*"; exit 1; }
unset BOSSMAN_MERGE_CHECK CHECK_ALL_FORCE BASE

# A throwaway repo: main with one commit, and a branch "feature" that changes whatever a case commits.
repo="$t/repo"; mkdir -p "$repo/scripts"
g() { git -C "$repo" -c user.email=t@example.com -c user.name=t "$@"; }
g init -q -b main; cp "$here/shell-tests-needed.sh" "$repo/scripts/"
echo a >"$repo/README"; g add -A; g commit -q -m init; g update-ref refs/remotes/origin/main HEAD
g checkout -q -b feature
commit() { local f; for f in "$@"; do mkdir -p "$repo/$(dirname "$f")"; echo "$RANDOM" >"$repo/$f"; done; g add -A; g commit -q -m "c $*"; }
reset_feature() { g checkout -q -B feature origin/main; }

# check <label> <want rc> [env ...]: run the script in the throwaway repo
check() {
  local label=$1 want=$2 rc=0; shift 2
  (cd "$repo" && env "$@" scripts/shell-tests-needed.sh >"$t/out" 2>&1) || rc=$?
  [ "$rc" -eq "$want" ] || fail "$label: rc $rc, want $want: $(cat "$t/out")"
}

commit apps/server/src/a.ts apps/web/src/b.tsx packages/shared/src/c.ts docs/d.md
check "server/web/shared/docs only: skip" 1 BOSSMAN_MERGE_CHECK=1
grep -q '^skip:' "$t/out" || fail "skip reason missing: $(cat "$t/out")"
check "a hand run (no merge check) runs them" 0
check "CHECK_ALL_FORCE runs them" 0 BOSSMAN_MERGE_CHECK=1 CHECK_ALL_FORCE=1
check "a base that does not exist runs them" 0 BOSSMAN_MERGE_CHECK=1 BASE=origin/nope
g checkout -q main; check "on main runs them" 0 BOSSMAN_MERGE_CHECK=1; g checkout -q feature
g checkout -q -B empty origin/main; check "no changed files runs them" 0 BOSSMAN_MERGE_CHECK=1; g checkout -q feature

for f in scripts/x.mjs deploy/x.yml deploy/caddy/Caddyfile apps/runner/Dockerfile apps/runner/src/x.ts apps/netguard/netguard.sh \
  apps/web/Dockerfile docker-compose.yml docker-compose.override.yml .github/workflows/ci.yml package.json pnpm-lock.yaml \
  pnpm-workspace.yaml skills/penpot/scripts/penpot.sh apps/server/src/run.sh Dockerfile; do
  reset_feature; commit apps/server/src/a.ts "$f"
  check "$f changed runs them" 0 BOSSMAN_MERGE_CHECK=1
done

# The list covers what the shell tests read: every tracked file that a *.test.sh names by path must be on it.
# (Fixture names that merely look like repo files are listed here with a reason.)
cd "$here/.."
# Not read from the repo: README.md (squeeze-test.test.sh passes it to prove a file outside apps/ and packages/ is refused) and the
# four app files check-quick.test.sh commits into a temp repo of its own and expects in hint text.
ok_unlisted=$'README.md\napps/server/package.json\napps/server/src/mcp.ts\napps/server/src/services/wake-classes.ts\npackages/shared/src/owner-controls.ts\n'
git ls-files | sort -u >"$t/tracked"
git ls-files '*.test.sh' | while IFS= read -r f; do grep -oE '[A-Za-z0-9_./-]+' "$f"; done | sed 's|^\./||' | sort -u >"$t/tokens"
missed=""
while IFS= read -r p; do
  case $'\n'"$ok_unlisted" in *$'\n'"$p"$'\n'*) continue ;; esac
  "$here/shell-tests-needed.sh" --path "$p" || missed="$missed $p"
done < <(comm -12 "$t/tracked" "$t/tokens")
[ -z "$missed" ] || fail "a shell test names these tracked files but scripts/shell-tests-needed.sh does not list them:$missed"
echo "shell-tests-needed.test.sh: ok"
