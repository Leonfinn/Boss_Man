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

# A ticket's kept scratch (BOSSMAN_SCRATCH, BOS-592, set by the runner): keep the whole output of this run there too,
# so a failed step can be read back after the runner restarted. Best effort, and for the outer run only: the heavy
# phase (CHECK_QUICK_PHASE=heavy) runs inside check-all.sh, which keeps its own log. scripts/sweep-tmp.sh never
# touches this folder, unlike /tmp.
SCRATCH_LOG="" SCRATCH_NAME=""
if [ -n "${BOSSMAN_SCRATCH:-}" ] && [ -d "${BOSSMAN_SCRATCH:-}" ] && [ "${CHECK_QUICK_PHASE:-}" != heavy ]; then
  SCRATCH_LOG="$BOSSMAN_SCRATCH/check-quick.log"
  # A fenced agent may not write the scratch folder: keep it under a name in /tmp the runner moves into the scratch.
  if [ ! -w "$BOSSMAN_SCRATCH" ] && [ -n "${BOSSMAN_TICKET:-}" ] && [ -d /tmp ] && [ -w /tmp ]; then
    SCRATCH_LOG="/tmp/bossman-scratch-$BOSSMAN_TICKET-quick.log"
  fi
fi
finish() { # finish <exit code>: put this run's whole output into the kept log, marked with how it ended
  local rc=$1 text
  [ -n "$SCRATCH_LOG" ] || exit "$rc"
  # The tee below is this run's only copy of its output: this finishes it (the one stream already drained, no second tee).
  text="$(dirname "$SCRATCH_LOG")/bossman-scratch-$(basename "$SCRATCH_LOG").$$.done"
  { printf 'check-quick: finished %s (exit %s)\n' "$(date -u +%FT%TZ)" "$rc"; cat "$SCRATCH_NAME" 2>/dev/null; } >"$text" 2>/dev/null || exit "$rc"
  [ ! -s "$SCRATCH_LOG" ] || mv -f "$SCRATCH_LOG" "$SCRATCH_LOG.previous" 2>/dev/null || true
  mv -f "$text" "$SCRATCH_LOG" 2>/dev/null || rm -f "$text" 2>/dev/null
  exit "$rc"
}

main() {
changed="$(git diff --name-only "$base"...HEAD)" || { echo "FAIL  diff against $base"; return 1; }
if [ -z "$changed" ]; then echo "PASS  nothing changed against $base"; return 0; fi

failed=0 skipped=0 partial=0

# Reuse (BOS-666): a pass is written to the slot log as a "quick-pass" line naming the git tree, the base commit and whether
# every related test ran (coverage=all) or a broad list was skipped (coverage=partial). A later hand run on a clean folder with
# the same tree and base reuses it instead of running again; any change to the files or to the base runs it again.
# A FORCE_RELATED run reuses only a coverage=all pass. The merge gate (BOSSMAN_MERGE_CHECK) never reuses, and
# CHECK_QUICK_RERUN=1 runs anyway. The slot log is shared and writable by every agent, so a reused pass is a convenience,
# not evidence: the merge gate's own full check is what decides a merge.
slotlog=${CHECK_ALL_SLOT_LOG:-${CHECK_ALL_LOCK:-/tmp/bossman-check-all}.slotlog}
clean_tree() { [ -z "$(git status --porcelain 2>/dev/null)" ] && git rev-parse 'HEAD^{tree}' 2>/dev/null; }
tree="" base_commit=""
if [ "${CHECK_QUICK_PHASE:-}" != heavy ]; then
  tree=$(clean_tree) || tree=""
  base_commit=$(git rev-parse --verify -q "$base^{commit}") || base_commit=""
  [ -n "$base_commit" ] || tree=""
fi
quick_log() { # quick_log <event> <coverage>
  [ -n "$tree" ] || return 0
  printf '%s %s pid=%s kind=%s check=quick tree=%s base=%s coverage=%s folder=%s\n' "$(date -u +%FT%TZ)" "$1" "$$" \
    "$([ -n "${BOSSMAN_MERGE_CHECK:-}" ] && echo merge || echo hand)" "$tree" "$base_commit" "$2" "$PWD" >>"$slotlog" 2>/dev/null || true
}
if [ -n "$tree" ] && [ -z "${BOSSMAN_MERGE_CHECK:-}" ] && [ -z "${CHECK_QUICK_RERUN:-}" ] && [ -f "$slotlog" ]; then
  want=" coverage=(all|partial) "; [ -z "${CHECK_QUICK_FORCE_RELATED:-}" ] || want=" coverage=all "
  prev=$(grep -E "^[0-9TZ:-]+ quick-pass pid=[0-9]+ kind=[a-z]+ check=quick tree=$tree base=$base_commit$want" "$slotlog" 2>/dev/null | tail -n 1) || prev=""
  if [ -n "$prev" ]; then
    cov=${prev#* coverage=}; cov=${cov%% *}
    echo "PASS  reused: this exact tree ($tree) already passed check-quick against $base at ${prev%% *} (coverage=$cov); not running it again (CHECK_QUICK_RERUN=1 runs it anyway)"
    quick_log quick-reuse "$cov"
    echo "check-quick: all steps passed (the merge gate still runs the full check)"
    exit 0
  fi
fi

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
  finish "$failed"
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
  if broad "$files"; then echo "SKIP related tests: too broad for a hand run, the merge gate runs them ($d; CHECK_QUICK_FORCE_RELATED=1 runs them anyway)"; partial=1
  else need_slot=1; fi
done
if [ "$need_slot" -eq 1 ]; then
  # The slot wait streams through, so the agent sees "waiting for a free check slot (place N of M ...)".
  rc=0
  BOSSMAN_CHECK_CHILD=1 CHECK_ALL_CHECK_KIND=quick CHECK_ALL_SLOT_COMMAND="CHECK_QUICK_PHASE=heavy '$PWD/scripts/check-quick.sh'" "$PWD/scripts/check-all.sh" || rc=$?
  # The heavy phase prints its own PASS/FAIL lines; two outcomes print none, so name them here. Exit 75 means nothing ran
  # (check-all gave up waiting for a slot): check-quick exits 75 too unless another step failed, so the merge gate
  # retries instead of sending an approved ticket back. check-all's own "gave up waiting" line streams through above.
  if [ "$rc" -eq 75 ]; then echo "SKIP  heavy phase (typecheck, related tests): gave up waiting for a check slot (nothing ran)"; skipped=1
  elif [ "$rc" -gt 128 ]; then echo "FAIL  heavy phase (typecheck, related tests): killed by signal $(kill -l "$((rc - 128))" 2>/dev/null || echo "$((rc - 128))") (exit $rc)"; failed=1
  elif [ "$rc" -ne 0 ]; then failed=1; fi
fi
if has '\.sh$'; then step "ShellCheck" scripts/check-shell.sh; fi
if has '^apps/web/|^packages/shared/'; then step "build web" pnpm --filter @boss-man/web build; fi

if [ "$failed" -ne 0 ]; then echo "check-quick: FAILED"; finish 1; fi
if [ "$skipped" -eq 1 ]; then echo "check-quick: nothing failed, but typecheck and related tests did not run (no check slot); run it again (exit 75)"; finish 75; fi
echo "check-quick: all steps passed (the merge gate still runs the full check)"
# Recorded only when the files are still exactly the tree the run started on (nothing edited while it ran).
[ -z "$tree" ] || [ "$(clean_tree)" != "$tree" ] || quick_log quick-pass "$([ "$partial" = 1 ] && echo partial || echo all)"
finish 0
}

# One tee for the whole outer run (which is what the kept log holds), or a plain run when there is nowhere to keep it.
# The exit code comes back through finish either way, so the skipped (75) and failed outcomes keep their codes.
if [ -n "$SCRATCH_LOG" ] && command -v tee >/dev/null; then
  SCRATCH_NAME="$(mktemp)"
  echo "check-quick: the full output of this run is kept in $SCRATCH_LOG"
  main 2>&1 | tee "$SCRATCH_NAME"
  finish "${PIPESTATUS[0]}"
else
  main
  exit $?
fi
