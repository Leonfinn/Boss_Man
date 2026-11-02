#!/usr/bin/env bash
# A 2-5 minute check of what this branch changed, for authors and reviewers. Only the merge gate runs the full
# scripts/check-all.sh. Prints one PASS/FAIL line per step (output of a failed step follows it) and exits non-zero on any failure.
# BASE (default origin/main) is the branch to compare with. Tests stub the commands through PATH.
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.." || exit 1
base="${BASE:-origin/main}"

changed="$(git diff --name-only "$base"...HEAD)" || { echo "FAIL  diff against $base"; exit 1; }
if [ -z "$changed" ]; then echo "PASS  nothing changed against $base"; exit 0; fi

failed=0
step() { # step <label> <command...>
  local label=$1 out rc=0; shift
  out="$("$@" 2>&1)" || rc=$?
  if [ "$rc" -eq 0 ]; then echo "PASS  $label"; else echo "FAIL  $label (exit $rc)"; printf '%s\n' "$out" | tail -n 40 | sed 's/^/      /'; failed=1; fi
}
has() { grep -Eq "$1" <<<"$changed"; }

# Packages with changed files; a change to the root config (lockfile, tsconfig, package.json) or to shared code touches all of them.
pkgs=()
for d in apps/launcher apps/runner apps/server apps/web packages/shared; do
  has "^$d/" && pkgs+=("$d")
done
if has '^(package\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml|tsconfig[^/]*\.json)$' || has '^packages/shared/'; then
  pkgs=(apps/launcher apps/runner apps/server apps/web packages/shared)
fi

step "merge with $base is clean" git merge-tree --write-tree "$base" HEAD
if has '^apps/server/drizzle/|^scripts/lint-migrations'; then step "migration lint" node scripts/lint-migrations.mjs; fi
if has '^scripts/.*\.mjs$'; then step "script tests" node --test scripts/*.test.mjs; fi

export NODE_OPTIONS="${NODE_OPTIONS:---max-old-space-size=2048}"
for d in "${pkgs[@]}"; do
  name="$(node -p "require('./$d/package.json').name")"
  step "typecheck $name" pnpm --filter "$name" typecheck
done
# Tests related to the changed source or test files (vitest follows imports); an apps/site change runs its whole small suite.
for d in "${pkgs[@]}" apps/site; do
  files="$(grep -E "^$d/.*\.(ts|tsx)$" <<<"$changed" | grep -v '\.d\.ts$' | while IFS= read -r f; do [ -f "$f" ] && echo "${f#"$d"/}"; done || true)"
  [ -n "$files" ] || continue
  name="$(node -p "require('./$d/package.json').name")"
  # shellcheck disable=SC2086  # one argument per file; paths have no spaces
  step "tests related to $name changes" pnpm --filter "$name" exec vitest related --run $files
done
if has '\.sh$'; then step "ShellCheck" scripts/check-shell.sh; fi
if has '^apps/web/|^packages/shared/'; then step "build web" pnpm --filter @boss-man/web build; fi

if [ "$failed" -eq 0 ]; then echo "check-quick: all steps passed (the merge gate still runs the full check)"; else echo "check-quick: FAILED"; fi
exit "$failed"
