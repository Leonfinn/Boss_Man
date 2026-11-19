#!/usr/bin/env bash
# A 2-5 minute check of what this branch changed, for authors and reviewers. What runs at the merge gate depends on the
# ticket's risk (deepChecks in packages/shared/src/risk.ts): high and critical get the full scripts/check-all.sh after this
# script (BOSSMAN_FULL_CHECK_NEXT); trivial, low and medium get only this script, with BOSSMAN_MERGE_CHECK set, which adds the
# whole-repo tests of each touched package (BOS-1732) and never skips related tests. GitHub CI is the first full run for those.
# Prints one PASS/FAIL line per step (output of a failed step follows it) and exits 1 on any failure,
# or 75 when nothing failed but the heavy phase never got a check slot (check-all exit 75; the merge gate retries).
# BASE (default origin/main) is the branch to compare with. Tests stub the commands through PATH.
# Typecheck and vitest are heavy (1-1.5 GB, up to an hour), so they run only while holding the merge gate's one-slot check lock
# (scripts/check-all.sh does the waiting and prints "waiting for a free check slot (place N ...)"); the gate keeps priority.
# BOSSMAN_FULL_CHECK_NEXT (set by the merge gate when check-all.sh runs next): only the merge check, migration lint and script tests run.
# Never skipped in a merge-gate run (BOSSMAN_MERGE_CHECK set). A broad related-test list (over CHECK_QUICK_BROAD_FILES files, default 15, or app.ts/main.ts/mcp.ts) is skipped unless CHECK_QUICK_FORCE_RELATED=1.
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.." || exit 1
base="${BASE:-origin/main}"
# A runner older than the jobFenceFor fix (BOS-1095) starts a check job without creating its HOME, and tests that make temp files there fail with ENOENT.
# Only create the folder; never move HOME or the XDG folders (that hid Playwright's browser cache from the web tests).
[ -z "${HOME:-}" ] || [ -d "$HOME" ] || mkdir -p "$HOME" 2>/dev/null || true
# One CPU budget for every step, the web build outside the slot included (BOS-674; see scripts/check-threads.mjs and check-all.sh).
BOSSMAN_CHECK_THREADS="${BOSSMAN_CHECK_THREADS:-$(node scripts/check-threads.mjs 2>/dev/null || true)}"
[[ "$BOSSMAN_CHECK_THREADS" =~ ^[1-9][0-9]{0,3}$ ]] || BOSSMAN_CHECK_THREADS=2
export BOSSMAN_CHECK_THREADS GOMAXPROCS="${GOMAXPROCS:-$BOSSMAN_CHECK_THREADS}" RAYON_NUM_THREADS="${RAYON_NUM_THREADS:-$BOSSMAN_CHECK_THREADS}" TOKIO_WORKER_THREADS="${TOKIO_WORKER_THREADS:-$BOSSMAN_CHECK_THREADS}"

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
# not evidence: the merge gate's own run decides a merge.
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
    echo "check-quick: all steps passed (the merge gate also runs the whole-repo tests of the packages you touched; high and critical tickets get the full check too)"
    return 0
  fi
fi

step() { # step <label> <command...>
  local label=$1 out rc=0; shift
  out="$("$@" 2>&1)" || rc=$?
  if [ "$rc" -eq 0 ]; then echo "PASS  $label"; else echo "FAIL  $label (exit $rc)"; printf '%s\n' "$out" | tail -n 40 | sed 's/^/      /'; failed=1; fi
}
has() { grep -Eq "$1" <<<"$changed"; }

# The list guards first (BOS-1727): four lists kept by hand (in-memory state notes, the owner's controls, wake classes, the screen
# inventory) failed 25 quick checks in 3 days, each only after 9 to 13 minutes. They run in the first minute, each only when a
# file it reads changed, and a failure names the file to edit and the line to add (scripts/check-guards.sh). Each still fails
# for a screen, control or wake reason changed without its record: only the order changed, nothing was loosened.
if [ "${CHECK_QUICK_PHASE:-}" != heavy ]; then
  if has '^apps/server/src/|^scripts/check-in-memory-state'; then step "in-memory-state lint" node scripts/check-in-memory-state.mjs apps/server/src; fi
  g_wake=0 g_owner=0 g_screen=0
  # The full check that runs next (BOSSMAN_FULL_CHECK_NEXT) starts with these guards itself (check-all.sh), after its own install.
  [ -n "${BOSSMAN_FULL_CHECK_NEXT:-}" ] || {
  has '^apps/server/src/|^apps/server/test/wake-classes\.test\.ts$|^scripts/check-guards\.sh$' && g_wake=1
  has '^apps/web/src/pages/|^apps/web/src/components/|^packages/shared/src/owner-controls\.ts$|^apps/server/test/owner-control-list\.test\.ts$|^scripts/check-guards\.sh$' && g_owner=1
  has '^apps/web/src/|^apps/web/test/screen-(inventory|scan)|^scripts/check-guards\.sh$' && g_screen=1
  }
  if [ $((g_wake + g_owner + g_screen)) -gt 0 ] && [ ! -d node_modules ]; then
    # A fresh tree (the queued check job) has no packages yet; install them here, as the later install step would.
    before=$failed failed=0
    step "install packages (fresh tree, no node_modules)" pnpm install --frozen-lockfile --prefer-offline
    install_failed=$failed failed=$((before | failed))
    [ "$install_failed" -eq 0 ] || { g_wake=0 g_owner=0 g_screen=0; echo "SKIP  list guards: the install failed"; }
  fi
  [ "$g_wake" -eq 0 ] || step "guard: wake classes (every wake reason has a class)" scripts/check-guards.sh wake-classes
  [ "$g_owner" -eq 0 ] || step "guard: owner controls (every button and field is listed)" scripts/check-guards.sh owner-controls
  [ "$g_screen" -eq 0 ] || step "guard: screen inventory (screen-inventory.txt is current)" scripts/check-guards.sh screen-inventory
fi

# Tests that find their source files by path (readFileSync, readdirSync) instead of importing them: vitest related can't
# see a change to those files, so only an entry here makes the test run for it (BOS-881). Add an entry when a test reads
# files by path; one line per test, its package and the path prefixes it reads:
#   "<package dir> <test file under that package> <path prefix> [<path prefix>...]"
#
# BOS-1732: the hand list that stood here (about 10 tests) is gone. At the merge gate every "whole-repo" test of each package
# the branch touches runs, found by what the test contains, so a new test of either kind is picked up with nothing to add:
#   - it reads repo files by path: a read call (readFileSync, readdirSync, ...) and a way to find the repo (import.meta.url,
#     __dirname, process.cwd()) in the same file: ratchets, inventories, lints;
#   - it renders the built app in a browser (apps/web only): the file uses real-page, playwright or chromium.
# Without that, main went red at our gate five times (BOS-1733) on tests that reach the code without importing it.
# A hand run does not run them (up to about 100 files); CHECK_QUICK_WHOLE_REPO=1 runs them anyway.
whole_repo_read='readFileSync|readdirSync|readFile\(|readdir\(|statSync|existsSync|git ls-files'
whole_repo_locate='import\.meta\.(url|dirname)|__dirname|process\.cwd\(\)'
whole_repo_browser='real-page|playwright|chromium'
whole_repo_on() { [ -n "${BOSSMAN_MERGE_CHECK:-}" ] || [ -n "${CHECK_QUICK_WHOLE_REPO:-}" ]; }
# BOS-1789: a whole-repo test also reads files of another package (the server's owner-control-list.test.ts reads apps/web, the
# runner tests read apps/runner/Dockerfile). Which packages a test reads is taken from the package paths its text names (and its
# helpers' text): "apps/web", "packages/shared", or the relative form "../../web/src". The gate then runs such a test when the
# branch changes that other package, not only its own. Known limit: a path built from pieces that never name the package is missed.
whole_repo_pkg_re='(apps|packages)/(launcher|runner|server|web|site|shared)([^A-Za-z0-9_-]|$)|\.\./(launcher|runner|server|web|site|shared)/'
whole_repo_pkgs_in() { # whole_repo_pkgs_in <file>...: the package dirs those files name by path, one per line
  { grep -ohE "$whole_repo_pkg_re" "$@" 2>/dev/null || true; } | sed -E 's#^(apps|packages)/([a-z]+).*#\1/\2#; s#^\.\./shared/#packages/shared#; s#^\.\./([a-z]+)/#apps/\1#' | sort -u
}
whole_repo_imports() { # whole_repo_imports <file> <helper>: the file imports the helper (relative, aliased, .js suffix, import() or require())
  local b
  b="$(basename "$2")"; b="${b%.*}"
  grep -qE "(from|import|require)[[:space:](]*[\"']([^\"']*[/#])?$b(\.(js|jsx|ts|tsx|mjs|mts))?[\"']" "$1" 2>/dev/null
}
whole_repo_closure() { # whole_repo_closure <file> <helper>...: the file and every helper it imports, directly or through other helpers
  local seen=" $1 " queue=$1 next f h
  shift
  while [ -n "$queue" ]; do
    next=""
    for f in $queue; do
      for h in "$@"; do
        case "$seen" in *" $h "*) continue ;; esac
        if whole_repo_imports "$f" "$h"; then seen="$seen$h "; next="$next $h"; fi
      done
    done
    queue=$next
  done
  echo "$seen"
}
whole_repo_tests() { # whole_repo_tests <package dir> [<touched dir>...]: its whole-repo test files to run, relative to the package, sorted
  # With no touched list the package itself counts as touched. A test runs when its package is touched, or when a package it reads is.
  local d=$1 all cands helpers new f t h reads p want out=""
  shift
  local touched=("$@")
  [ "${#touched[@]}" -gt 0 ] || touched=("$d")
  all="$(find "$d" -name node_modules -prune -o -type f \( -name '*.test.ts' -o -name '*.test.tsx' \) -print 2>/dev/null)" || all=""
  [ -n "$all" ] || return 0
  # A test may read through a helper in its test folder, at any depth (screen-inventory.test.ts imports screen-scan.ts): the helper
  # counts too, and so does a helper that only imports a reading helper, until no new one turns up.
  cands="$(find "$d/test" -name node_modules -prune -o -type f \( -name '*.ts' -o -name '*.tsx' -o -name '*.mts' -o -name '*.js' -o -name '*.mjs' \) ! -name '*.test.*' -print 2>/dev/null)" || cands=""
  # shellcheck disable=SC2086  # one argument per file; paths have no spaces
  helpers=" $({ grep -lE "$whole_repo_read" $cands 2>/dev/null || true; } | { xargs -r grep -lE "$whole_repo_locate" 2>/dev/null || true; } | tr '\n' ' ')"
  while :; do
    new=""
    for f in $cands; do
      case "$helpers" in *" $f "*) continue ;; esac
      for h in $helpers; do
        if whole_repo_imports "$f" "$h"; then new="$new $f"; break; fi
      done
    done
    [ -n "$new" ] || break
    helpers="$helpers$new "
  done
  # shellcheck disable=SC2086
  want="$({
    { grep -lE "$whole_repo_read" $all 2>/dev/null || true; } | xargs -r grep -lE "$whole_repo_locate" 2>/dev/null || true
    for t in $all; do
      for h in $helpers; do
        if whole_repo_imports "$t" "$h"; then echo "$t"; break; fi
      done
    done
    [ "$d" != apps/web ] || grep -lE "$whole_repo_browser" $all 2>/dev/null || true
  } | sort -u)"
  for t in $want; do
    # shellcheck disable=SC2046,SC2086  # one argument per file; paths have no spaces
    reads="$d $(whole_repo_pkgs_in $(whole_repo_closure "$t" $helpers))"
    for p in $reads; do
      case " ${touched[*]} " in *" $p "*) out="$out$t"$'\n'; break ;; esac
    done
  done
  printf '%s' "$out" | sed "s#^$d/##"
  return 0
}

# Packages with changed files; a change to the root config (lockfile, tsconfig, package.json) or to shared code touches all of them.
pkgs=()
for d in apps/launcher apps/runner apps/server apps/web packages/shared; do
  has "^$d/" && pkgs+=("$d")
done
if has '^(package\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml|tsconfig[^/]*\.json)$' || has '^packages/shared/'; then
  pkgs=(apps/launcher apps/runner apps/server apps/web packages/shared)
fi

  if [ "${CHECK_QUICK_PHASE:-}" != heavy ]; then
  # The merge gate renumbers a branch's new migration when migration bookkeeping is the only clash (BOS-690, DR-037), so
  # this step accepts that case the same way, using the same function (scripts/rebase-migrations.mjs). Real clashes still fail.
  # It notes the rebuilt tree in $rebuilt_tree_file, and the migration lint then runs on that tree.
  rebuilt_tree_file="$(mktemp)"; lint_dir=""
  # shellcheck disable=SC2317  # called through step below
  merge_clean() {
    local mout mrc=0 rout rrc=0
    mout="$(git merge-tree --write-tree "$base" HEAD 2>&1)" || mrc=$?
    if [ "$mrc" -ne 0 ] && [ "$mrc" -ne 1 ]; then printf '%s\n' "$mout"; return "$mrc"; fi
    if [ "$mrc" -eq 0 ] && ! has '^apps/server/drizzle/'; then return 0; fi
    # rebase-migrations.mjs loads tsx from the runner's packages, which a fresh tree (the queued check job) does not have yet
    # (BOS-1258). Install first, here in the light phase so it never holds a check slot; the later install step then sees
    # node_modules and skips. If the install fails, say so: that is not a migration clash.
    if [ ! -d node_modules ]; then
      echo "installing packages first: the migration renumber check needs them (fresh tree, no node_modules)"
      if ! pnpm install --frozen-lockfile --prefer-offline >"$rebuilt_tree_file.install" 2>&1; then
        tail -n 20 "$rebuilt_tree_file.install"
        echo "cannot tell whether the migration clash can be renumbered: the package install failed (not a clash; fix the install and run again)"
        return 1
      fi
    fi
    rout="$(node scripts/rebase-migrations.mjs HEAD "$base" 2>&1)" || rrc=$?
    if [ "$rrc" -eq 0 ] && [[ "$rout" == *"rebuilt tree: "* ]]; then
      printf '%s\n' "$rout" | sed -n 's/^rebuilt tree: //p' >"$rebuilt_tree_file"
      printf '%s\n' "$rout" | sed -n 's/^\([0-9][0-9]*\)_\([^ ]*\) -> \([0-9][0-9]*\)_.*$/migration \1 (\2) will be renumbered to \3 by the merge gate; do not renumber it by hand/p' >"$rebuilt_tree_file.notes"
      return 0
    fi
    # Nothing to renumber: a clean merge stays clean; a conflict stays a conflict, with the refusal reason when there is one.
    [ "$mrc" -eq 0 ] && return 0
    printf '%s\n' "$mout"
    [ "$rrc" -ne 0 ] && printf 'the merge gate cannot renumber it either: %s\n' "$rout"
    return 1
  }
  step "merge with $base is clean" merge_clean
  # step hides the output of a pass, so the renumbering notes were kept aside: show them.
  [ -s "$rebuilt_tree_file.notes" ] && sed 's/^/      /' "$rebuilt_tree_file.notes"
  rm -f "$rebuilt_tree_file.notes"
  if [ -s "$rebuilt_tree_file" ]; then
    tree_id="$(tr -d '[:space:]' <"$rebuilt_tree_file")"
    lint_dir="$(mktemp -d)"
    git archive "$tree_id" apps/server/drizzle | tar -x -C "$lint_dir" && lint_dir="$lint_dir/apps/server/drizzle"
  fi
  rm -f "$rebuilt_tree_file"
  if has '^apps/server/drizzle/|^scripts/lint-migrations'; then
    if [ -n "$lint_dir" ] && [ -d "$lint_dir" ]; then step "migration lint (on the tree the gate will build)" node scripts/lint-migrations.mjs "$lint_dir"; rm -rf "$lint_dir"
    else step "migration lint" node scripts/lint-migrations.mjs; fi
  fi
  # BOS-979: a hand run's early warning for the secret rules (it has no owner's list). Convenience only: the merge line's
  # scan is the runner's own installed copy, run before this script starts, and it does not depend on this step.
  if [ -f scripts/scan-added-lines.mjs ]; then
    step "secrets scan" node scripts/scan-added-lines.mjs "$base"
  fi
  # BOS-1549: two guides in docs/ must not share a number, counting pages main added since this branch left it. Runs on
  # every branch (it takes well under a second), since a clash can come from main even when the branch touched no doc.
  step "docs numbers are unique" node scripts/check-doc-numbers.mjs "$base"
  # BOS-1894: a secret file docker-compose.yml names must be created in step 3 of docs/00 (compose refuses to start without it).
  if has '^docker-compose\.yml$|^docs/00-first-time-install\.md$|^scripts/check-compose-secrets-docs'; then step "compose secrets are in the install guide" node scripts/check-compose-secrets-docs.mjs; fi
  # The in-memory-state lint (BOS-460, 492, 516, 702) now runs with the other list guards, first (BOS-1727).
  # BOS-1728: the ratchet for bare sleeps, elapsed-time limits, fresh Date.now() sums and fixed-length reads in test files (CLAUDE.md "Writing tests").
  if has '(^|/)test/|\.(test|spec)\.(ts|tsx|mjs|js)$|^scripts/(check-test-lines|test-lines-baseline)'; then step "test-lines ratchet" node scripts/check-test-lines.mjs; fi
if has '^scripts/.*\.mjs$'; then step "script tests" node --test scripts/*.test.mjs; fi
  # Compose files and CI workflows (BOS-1036): validated by the Docker CLI's compose plugin (no daemon, no socket) and actionlint.
  # A runner image built before they were added has neither tool: that is a SKIP naming the fix, not a failure.
  if has '^docker-compose[^/]*\.yml$|^deploy/.*\.ya?ml$|^\.github/workflows/|^scripts/check-compose\.sh$'; then
    rc=0; out="$(scripts/check-compose.sh 2>&1)" || rc=$?
    if [ "$rc" -eq 3 ]; then echo "SKIP  compose and workflow validation: ${out##*check-compose: } (a runner image from before BOS-1036; Build and update runners installs them)"
    elif [ "$rc" -eq 0 ]; then echo "PASS  compose files and CI workflows"
    else echo "FAIL  compose files and CI workflows (exit $rc)"; printf '%s\n' "$out" | tail -n 40 | sed 's/^/      /'; failed=1; fi
  fi
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
  # Whole-repo tests (BOS-1732) the related list can't reach: one vitest run per package, from its package folder (same slot,
  # its setup files apply). Named files, so vitest-guard accepts it inside the slot.
  if whole_repo_on; then
    # BOS-1789: every package is looked at, not only the touched ones: a test that reads a touched package runs too.
    for d in apps/launcher apps/runner apps/server apps/web packages/shared; do
      [ "${#pkgs[@]}" -gt 0 ] || break
      files="$(whole_repo_tests "$d" "${pkgs[@]}")"
      [ -n "$files" ] || continue
      name="$(node -p "require('./$d/package.json').name")"
      # The browser tests of apps/web open the built app (apps/web/dist) and skip when it is missing: build it first, here in
      # the slot, so they really run. The build step after the slot wait is then left out (web_built_early).
      if [ "$d" = apps/web ] && [[ " ${pkgs[*]} " == *" apps/web "* ]]; then step "build web (before the browser tests)" pnpm --filter @boss-man/web build; fi
      # shellcheck disable=SC2086  # one argument per file; paths have no spaces
      step "whole-repo tests ($d, $(grep -c . <<<"$files") files)" pnpm --filter "$name" exec vitest run $files
    done
  fi
  return "$failed"
fi

if [ -n "${BOSSMAN_FULL_CHECK_NEXT:-}" ]; then
  # The merge gate runs the full check (check-all.sh) straight after this one on the same tree, for high and critical
  # tickets (BOS-665). It repeats everything below (typecheck, tests, ShellCheck, web build), so only the cheap steps above
  # run here, and a broken merge or migration still fails before the long check starts.
  echo "SKIP  typecheck, related tests, ShellCheck, web build: the full check runs next (BOSSMAN_FULL_CHECK_NEXT)"
  if [ "$failed" -ne 0 ]; then echo "check-quick: FAILED"; return 1; fi
  echo "check-quick: cheap steps passed; the full check runs the rest"
  return 0
fi

need_slot=0
[ "${#pkgs[@]}" -eq 0 ] || need_slot=1
for d in "${pkgs[@]}" apps/site; do
  files="$(related_files "$d")"
  [ -n "$files" ] || continue
  if broad "$files"; then echo "SKIP related tests: too broad for a hand run, the merge gate runs them ($d; CHECK_QUICK_FORCE_RELATED=1 runs them anyway)"; partial=1
  else need_slot=1; fi
done
# A fresh tree has no packages (BOS-952): the server-owned check queue runs this script in a new detached worktree, and
# typecheck, vitest and the web build then fail with "tsc: not found". Install them first, here before the slot wait so
# the install never holds a check slot. The queue job sets the shared pnpm store (BOS-655), so this is quick when warm.
# A tree that already has node_modules (an agent's checkout) is left as it is.
web_build=0; ! has '^apps/web/|^packages/shared/' || web_build=1
if { [ "$need_slot" -eq 1 ] || [ "$web_build" -eq 1 ]; } && [ ! -d node_modules ]; then
  before=$failed failed=0
  step "install packages (fresh tree, no node_modules)" pnpm install --frozen-lockfile --prefer-offline
  install_failed=$failed failed=$((before | failed))
  # Without packages every later pnpm step fails too: don't take a check slot just to say so again.
  if [ "$install_failed" -ne 0 ]; then
    echo "SKIP  typecheck, related tests, web build: the install failed"; need_slot=0 web_build=0
  fi
fi
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
# At the gate the heavy phase already built the web app when apps/web has whole-repo tests (web_built_early).
web_built_early=0
if [ "$need_slot" -eq 1 ] && whole_repo_on && [ -n "$(whole_repo_tests apps/web "${pkgs[@]}")" ]; then
  for d in "${pkgs[@]}"; do [ "$d" != apps/web ] || web_built_early=1; done
fi
if [ "$web_build" -eq 1 ] && [ "$web_built_early" -eq 0 ]; then step "build web" pnpm --filter @boss-man/web build; fi

if [ "$failed" -ne 0 ]; then echo "check-quick: FAILED"; return 1; fi
if [ "$skipped" -eq 1 ]; then echo "check-quick: nothing failed, but typecheck and related tests did not run (no check slot); run it again (exit 75)"; return 75; fi
echo "check-quick: all steps passed (the merge gate also runs the whole-repo tests of the packages you touched; high and critical tickets get the full check too)"
# Recorded only when the files are still exactly the tree the run started on (nothing edited while it ran).
[ -z "$tree" ] || [ "$(clean_tree)" != "$tree" ] || quick_log quick-pass "$([ "$partial" = 1 ] && echo partial || echo all)"
return 0
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
