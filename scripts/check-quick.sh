#!/usr/bin/env bash
# A 2-5 minute check of what this branch changed, for authors and reviewers. Only the merge gate runs the full
# scripts/check-all.sh. Prints one PASS/FAIL line per step (output of a failed step follows it) and exits 1 on any failure,
# or 75 when nothing failed but the heavy phase never got a check slot (check-all exit 75; the merge gate retries).
# BASE (default origin/main) is the branch to compare with. Tests stub the commands through PATH.
# Typecheck and vitest are heavy (1-1.5 GB, up to an hour), so they run only while holding the merge gate's one-slot check lock
# (scripts/check-all.sh does the waiting and prints "waiting for a free check slot (place N ...)"); the gate keeps priority.
# BOSSMAN_FULL_CHECK_NEXT (set by the merge gate when check-all.sh runs next): only the merge check, migration lint and script tests run.
# Never skipped in a merge-gate run (BOSSMAN_MERGE_CHECK set). A broad related-test list (over CHECK_QUICK_BROAD_FILES files, default 15, or app.ts/main.ts/mcp.ts) is skipped unless CHECK_QUICK_FORCE_RELATED=1.
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.." || exit 1
base="${BASE:-origin/main}"

changed="$(git diff --name-only "$base"...HEAD)" || { echo "FAIL  diff against $base"; exit 1; }
if [ -z "$changed" ]; then echo "PASS  nothing changed against $base"; exit 0; fi

failed=0 skipped=0
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

  if [ "${CHECK_QUICK_PHASE:-}" != heavy ]; then
  step "merge with $base is clean" git merge-tree --write-tree "$base" HEAD
  if has '^apps/server/drizzle/|^scripts/lint-migrations'; then step "migration lint" node scripts/lint-migrations.mjs; fi
if has '^scripts/.*\.mjs$'; then step "script tests" node --test scripts/*.test.mjs; fi
fi

# Related test files of a package: source or test files changed in it (vitest follows imports); an apps/site change runs its whole small suite.
related_files() { # related_files <dir>
  grep -E "^$1/.*\.(ts|tsx)$" <<<"$changed" | grep -v '\.d\.ts$' | while IFS= read -r f; do [ -f "$f" ] && echo "${f#"$1"/}"; done || true
}
broad() { # broad <files>: too many files, or one that most of the suite imports
  # The merge gate runs this script as its check (BOSSMAN_MERGE_CHECK=1): it must never skip tests, or merges go in untested.
  [ -z "${CHECK_QUICK_FORCE_RELATED:-}" ] && [ -z "${BOSSMAN_MERGE_CHECK:-}" ] || return 1
  [ "$(grep -c . <<<"$1")" -gt "${CHECK_QUICK_BROAD_FILES:-15}" ] || grep -Eq '(^|/)(app|main|mcp)\.ts$' <<<"$1"
}

if [ "${CHECK_QUICK_PHASE:-}" = heavy ]; then
  # Runs inside the check slot (started by check-all.sh below): exits non-zero when a step failed, with no summary line.
  export NODE_OPTIONS="${NODE_OPTIONS:---max-old-space-size=2048}"
  for d in "${pkgs[@]}"; do
    name="$(node -p "require('./$d/package.json').name")"
    step "typecheck $name" pnpm --filter "$name" typecheck
  done
  for d in "${pkgs[@]}" apps/site; do
    files="$(related_files "$d")"
    [ -n "$files" ] || continue
    ! broad "$files" || continue
    name="$(node -p "require('./$d/package.json').name")"
    # shellcheck disable=SC2086  # one argument per file; paths have no spaces
    step "tests related to $name changes" pnpm --filter "$name" exec vitest related --run $files
  done
  exit "$failed"
fi

if [ -n "${BOSSMAN_FULL_CHECK_NEXT:-}" ]; then
  # The merge gate runs the full check (check-all.sh) straight after this one on the same tree, for high and critical
  # tickets (BOS-665). It repeats everything below (typecheck, tests, ShellCheck, web build), so only the cheap steps above
  # run here, and a broken merge or migration still fails before the long check starts.
  echo "SKIP  typecheck, related tests, ShellCheck, web build: the full check runs next (BOSSMAN_FULL_CHECK_NEXT)"
  if [ "$failed" -ne 0 ]; then echo "check-quick: FAILED"; exit 1; fi
  echo "check-quick: cheap steps passed; the full check runs the rest"
  exit 0
fi

need_slot=0
[ "${#pkgs[@]}" -eq 0 ] || need_slot=1
for d in "${pkgs[@]}" apps/site; do
  files="$(related_files "$d")"
  [ -n "$files" ] || continue
  if broad "$files"; then echo "SKIP related tests: too broad for a hand run, the merge gate runs them ($d; CHECK_QUICK_FORCE_RELATED=1 runs them anyway)"
  else need_slot=1; fi
done
if [ "$need_slot" -eq 1 ]; then
  # The slot wait streams through, so the agent sees "waiting for a free check slot (place N of M ...)".
  rc=0
  BOSSMAN_CHECK_CHILD=1 CHECK_ALL_SLOT_COMMAND="CHECK_QUICK_PHASE=heavy '$PWD/scripts/check-quick.sh'" "$PWD/scripts/check-all.sh" || rc=$?
  # The heavy phase prints its own PASS/FAIL lines; two outcomes print none, so name them here. Exit 75 means nothing ran
  # (check-all gave up waiting for a slot): check-quick exits 75 too unless another step failed, so the merge gate
  # retries instead of sending an approved ticket back. check-all's own "gave up waiting" line streams through above.
  if [ "$rc" -eq 75 ]; then echo "SKIP  heavy phase (typecheck, related tests): gave up waiting for a check slot (nothing ran)"; skipped=1
  elif [ "$rc" -gt 128 ]; then echo "FAIL  heavy phase (typecheck, related tests): killed by signal $(kill -l "$((rc - 128))" 2>/dev/null || echo "$((rc - 128))") (exit $rc)"; failed=1
  elif [ "$rc" -ne 0 ]; then failed=1; fi
fi
if has '\.sh$'; then step "ShellCheck" scripts/check-shell.sh; fi
if has '^apps/web/|^packages/shared/'; then step "build web" pnpm --filter @boss-man/web build; fi

if [ "$failed" -ne 0 ]; then echo "check-quick: FAILED"; exit 1; fi
if [ "$skipped" -eq 1 ]; then echo "check-quick: nothing failed, but typecheck and related tests did not run (no check slot); run it again (exit 75)"; exit 75; fi
echo "check-quick: all steps passed (the merge gate still runs the full check)"
exit 0
