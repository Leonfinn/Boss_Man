#!/usr/bin/env bash
# A 2-5 minute check of what this branch changed, for authors and reviewers. What runs at the merge gate depends on the
# ticket's risk (deepChecks in packages/shared/src/risk.ts): high and critical get the full scripts/check-all.sh after this
# script (BOSSMAN_FULL_CHECK_NEXT); trivial, low and medium get only this script, with BOSSMAN_MERGE_CHECK set, which adds the
# whole-repo tests of each touched package (BOS-1732) and never skips related tests. GitHub CI is the first full run for those.
# A shared-code change also runs the other packages' tests that use the names it changed (BOS-2334, see shared_consumer_tests).
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
  local label=$1 out rc=0 f pid began next took n naps=0 every; shift
  # BOS-2219: a step's output is held until it ends, so the server tests printed nothing for 14 to 16 minutes on a slow check
  # host, against the queue's 20-minute no-output limit (a slow run looked like a hang). While a step runs, a line every
  # CHECK_QUICK_PROGRESS_SECONDS (default 180) says it is still going, with the test files vitest has finished so far.
  # The command runs in the background with its output in a file, and this shell polls it with short sleeps it waits for:
  # a separate ticker process would outlive the step in its last sleep and keep the check slot's lock fd open.
  every="${CHECK_QUICK_PROGRESS_SECONDS:-180}"; [[ "$every" =~ ^[1-9][0-9]*$ ]] || every=180
  if ! f="$(mktemp 2>/dev/null)"; then out="$("$@" 2>&1)" || rc=$?
  else
    "$@" >"$f" 2>&1 </dev/null &
    pid=$! began=$SECONDS next=$every
    while kill -0 "$pid" 2>/dev/null; do
      # Quick steps (most of them) end within the first short naps; a long one is looked at once a second.
      if [ "$naps" -lt 20 ]; then naps=$((naps + 1)); sleep 0.1; else sleep 1; fi
      took=$((SECONDS - began))
      [ "$took" -ge "$next" ] || continue
      next=$((next + every))
      # vitest prints one " ✓ test/x.test.ts (n tests)" line per finished file (❯ or × when it failed, ↓ when skipped).
      n=$(grep -cE '^ *(✓|×|❯|↓) [^ ]+\.(test|spec)\.' "$f" 2>/dev/null) || n=0
      echo "      $label: $([ "$took" -ge 60 ] && echo "$((took / 60))m" || echo "${took}s"), still running$([ "$n" -gt 0 ] && echo " ($n test files done)")"
    done
    wait "$pid" || rc=$?
    out="$(cat "$f")"; rm -f "$f"
  fi
  if [ "$rc" -eq 0 ]; then echo "PASS  $label"; else echo "FAIL  $label (exit $rc)"; printf '%s\n' "$out" | tail -n 40 | sed 's/^/      /'; failed=1; fi
}
has() { grep -Eq "$1" <<<"$changed"; }

# BOS-1628: install_packages (retry on a machine fault, exit 75 plus the marker) is shared with check-all.sh.
# shellcheck source=scripts/install-packages.sh
. "$(dirname "${BASH_SOURCE[0]}")/install-packages.sh"
env_fault=0
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
    before=$failed failed=0 irc=0
    iout="$(install_packages 2>&1)" || irc=$?
    if [ "$irc" -eq 0 ]; then echo "PASS  install packages (fresh tree, no node_modules)"
    else
      echo "FAIL  install packages (fresh tree, no node_modules) (exit $irc)"; printf '%s\n' "$iout" | tail -n 40 | sed 's/^/      /'; failed=1
      [ "$irc" -ne 75 ] || [ "$before" -ne 0 ] || env_fault=1
    fi
    install_failed=$failed failed=$((before | failed))
    install_tried=1 install_tried_failed=$install_failed
    [ "$install_failed" -eq 0 ] || { g_wake=0 g_owner=0 g_screen=0; echo "SKIP  list guards: the install failed"; }
  fi
  [ "$g_wake" -eq 0 ] || step "guard: wake classes (every wake reason has a class)" scripts/check-guards.sh wake-classes
  # BOS-2058: same trigger (any server source): every update wait has a rule, and no new file reads an update hold.
  [ "$g_wake" -eq 0 ] || step "guard: update waits (every wait has an end and words)" scripts/check-guards.sh update-waits
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
# BOS-2286: a whole-repo test also runs when its text (or its helpers') names a changed file outside the packages by its repo
# path: web's check-worker-compose.test.ts reads "../../../deploy/check-worker/compose.yaml", and BOS-2161 changed that file
# with no web change, so the test did not run and GitHub failed on it. This is every changed file outside the five package
# folders (deploy/, docker-compose*.yml, docs/, scripts/, .github/ ...), one per line; a file inside a package already
# touches that package. Known limit: a path built from pieces ("deploy", file) never names the file and is missed.
wr_outside="$(grep -vE '^(apps/(launcher|runner|server|web)|packages/shared)/' <<<"$changed" || true)"
whole_repo_tests() { # whole_repo_tests <package dir> [<touched dir>...]: its whole-repo test files to run, relative to the package, sorted
  # A test runs when its package is touched, when a package it reads is, or when it names a changed file in $wr_outside.
  local d=$1 all cands helpers new f t h reads p want out="" closure
  shift
  local touched=("$@")
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
    # shellcheck disable=SC2086  # one argument per file; paths have no spaces
    closure="$(whole_repo_closure "$t" $helpers)"
    # shellcheck disable=SC2086
    reads="$d $(whole_repo_pkgs_in $closure)"
    for p in $reads; do
      case " ${touched[*]-} " in *" $p "*) out="$out$t"$'\n'; continue 2 ;; esac
    done
    # shellcheck disable=SC2086
    if [ -n "$wr_outside" ] && grep -qF -f <(printf '%s\n' "$wr_outside") $closure 2>/dev/null; then out="$out$t"$'\n'; fi
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
# BOS-2334: a change to shared code also runs the tests of the other packages that use what it changed. related_files above
# passes a package only its own changed files, so BOS-2327's change to packages/shared/src/owner-controls.ts never reached
# apps/server/test/owner-screens.test.ts (it imports src/services/owner-screens.ts, which uses OWNER_TABS from
# @boss-man/shared), and GitHub was the first to fail on it. Passing the shared file itself to the server's `vitest related`
# does not work: @boss-man/shared is one barrel (src/index.ts, export * of every file), so every test that reaches the
# barrel (most of the server, through app.ts) counts as related to any shared file: the whole suite on every shared change.
# So the tests are picked by the names the change exports:
#   1. the changed shared files (not tests, not index.ts, which only re-exports), and every shared file that imports one of
#      them, until no new one turns up;
#   2. the value names they export (function, const, let, class, enum, export { ... }); types are left out: the typecheck of
#      every package, which runs on any shared change, catches those;
#   3. in launcher, runner, server and web, the files that import @boss-man/shared and use one of those names as a word;
#   4. the test files among them, and the test files that import one of the others directly (by file name, as whole_repo_imports),
#      unless that file is a hub, imported by more than CHECK_QUICK_HUB_TESTS (default 50) test files.
# Known limit: a test that reaches the user only through a hub (test -> app.ts -> ... -> user, or a hub that uses the name
# itself) is not picked; those are what made the plain related run the whole suite. The full check (high and critical) and
# GitHub (the rest) still run them.
# A short name (plan, rank) picks extra tests: too many is safe, too few is the risk.
test_file_re='\.(test|spec)\.(ts|tsx|mts)$'
shared_src_changed="$(grep -E '^packages/shared/src/.*\.(ts|tsx)$' <<<"$changed" | grep -vE "$test_file_re|\.d\.ts$|^packages/shared/src/index\.ts$" || true)"
shared_names=""
if [ -n "$shared_src_changed" ]; then
  shared_seen=" " shared_queue=""
  for f in $shared_src_changed; do [ ! -f "$f" ] || { shared_seen="$shared_seen$f "; shared_queue="$shared_queue $f"; }; done
  shared_all="$(find packages/shared/src -type f \( -name '*.ts' -o -name '*.tsx' \) ! -name '*.test.*' ! -name '*.d.ts' ! -name index.ts -print 2>/dev/null | sort)" || shared_all=""
  while [ -n "$shared_queue" ]; do
    shared_next=""
    for f in $shared_all; do
      case "$shared_seen" in *" $f "*) continue ;; esac
      for q in $shared_queue; do
        if whole_repo_imports "$f" "$q"; then shared_seen="$shared_seen$f "; shared_next="$shared_next $f"; break; fi
      done
    done
    shared_queue=$shared_next
  done
  # shellcheck disable=SC2086  # one argument per file; paths have no spaces
  shared_names="$({
    sed -nE 's/^export +(declare +)?(async +)?(function\*?|const|let|var|class|abstract +class|enum|const +enum) +([A-Za-z_][A-Za-z0-9_]*).*/\4/p' $shared_seen
    sed -nE 's/^export +\{([^}]*)\}.*/\1/p' $shared_seen | tr ',' '\n' | sed -E 's/^[[:space:]]*(type[[:space:]]+)?//; s/.*[[:space:]]as[[:space:]]+//; s/[[:space:]]*$//'
  } 2>/dev/null | grep -E '^[A-Za-z_][A-Za-z0-9_]*$' | sort -u | tr '\n' '|' | sed 's/|$//')" || shared_names=""
fi
shared_consumer_tests() { # shared_consumer_tests <package dir>: its test files that use what the shared change exports, relative to it
  local d=$1 users mods tests="" all m b hits
  [ -n "$shared_names" ] || return 0
  case "$d" in apps/launcher | apps/runner | apps/server | apps/web) ;; *) return 0 ;; esac
  users="$({ grep -rlE --include='*.ts' --include='*.tsx' --include='*.mts' "[\"']@boss-man/shared(/[^\"']*)?[\"']" "$d/src" "$d/test" 2>/dev/null || true; } \
    | { xargs -r grep -lwE "($shared_names)" 2>/dev/null || true; })"
  [ -n "$users" ] || return 0
  tests="$(grep -E "$test_file_re" <<<"$users" || true)"
  mods="$(grep -vE "$test_file_re" <<<"$users" || true)"
  if [ -n "$mods" ]; then
    all="$(find "$d/src" "$d/test" -type f \( -name '*.test.ts' -o -name '*.test.tsx' -o -name '*.test.mts' -o -name '*.spec.ts' -o -name '*.spec.tsx' \) -print 2>/dev/null || true)"
    for m in $mods; do
      b="$(basename "$m")"; b="${b%.*}"; b="${b//./\\.}"
      # The import pattern of whole_repo_imports.
      hits="$({ xargs -r grep -lE "(from|import|require)[[:space:](]*[\"']([^\"']*[/#])?$b(\.(js|jsx|ts|tsx|mjs|mts))?[\"']" 2>/dev/null || true; } <<<"$all")"
      # A hub (the server's app.ts, mcp.ts and db/schema.ts, web's api.ts: each imported by 115 to 330 tests on 23 Nov, where
      # every other file has at most 37) is the known limit above: its tests are not picked through it, or a change to
      # risk.ts picked 362 server tests and 129 web tests (BOS-2334 measurements).
      [ "$(grep -c . <<<"$hits")" -gt "${CHECK_QUICK_HUB_TESTS:-50}" ] || tests="$tests"$'\n'"$hits"
    done
  fi
  { grep . <<<"$tests" || true; } | sed "s#^$d/##" | sort -u
}
# The related-test list of a package: its own changed files (vitest follows their imports) and the tests above. A test file
# passed to vitest related runs itself, so this stays one run per package.
related_list() { # related_list <dir>
  { related_files "$1"; shared_consumer_tests "$1"; } | { grep . || true; } | sort -u
}
broad() { # broad <files>: too many files, or one that most of the suite imports
  # The merge gate runs this script as its check (BOSSMAN_MERGE_CHECK=1): it must never skip tests, or merges go in untested.
  [ -z "${CHECK_QUICK_FORCE_RELATED:-}" ] && [ -z "${BOSSMAN_MERGE_CHECK:-}" ] || return 1
  [ "$(grep -c . <<<"$1")" -gt "${CHECK_QUICK_BROAD_FILES:-15}" ] || grep -Eq '(^|/)(app|main|mcp)\.ts$' <<<"$1"
}

# BOS-2386: tests in any package that still name a string the branch removed or renamed. BOS-2326 renamed the Ctrl+K box
# (aria-label "Search tickets, wiki and chats") and apps/web/test/keyboard-shortcuts.test.tsx, which imports neither changed
# file, still looked for the old name: only the merge found it. So:
#   1. the string literals ("...", '...', `...` with no ${}) and one-line JSX text (>...<) on the lines the diff removes,
#      of JS/TS source (not tests: shell and YAML quoting is mostly code), minus the ones the diff adds back (a line edited
#      around a kept string); at least CHECK_QUICK_REMOVED_MIN (default 8) characters with a letter, and a space, / or → in
#      it unless it has 12 or more (a label or path, not a key like "typecheck"); no import paths, no code (&&, ||, =>);
#   2. one grep -F of those over every tracked test file of every package (an untouched package too);
#   3. a string found in more than CHECK_QUICK_REMOVED_COMMON (default 10) test files is too common to mean anything: left out,
#      and the log says so; a test already in its package's related list is left out (it runs anyway);
#   4. at most CHECK_QUICK_REMOVED_MAX (default 15) files, the ones naming the most removed strings first; the log says when
#      the cap cut some. They run in the slot, one named vitest run per package, on a hand run and at the gate alike.
# Known limits: a string the test builds from pieces, a regex in the test (/Search tickets/), and an added label a test says
# must not exist (BOS-2327 added Notifications to the Settings tabs: BOS-2334's shared-name pick covers that one).
removed_test_pkgs="apps/launcher apps/runner apps/server apps/web apps/site packages/shared"
removed_lits() { # removed_lits: the string literals and JSX text in the code lines on stdin, one per line
  local min="${CHECK_QUICK_REMOVED_MIN:-8}"
  [[ "$min" =~ ^[1-9][0-9]?$ ]] || min=8
  { grep -oE "\"[^\"\\\\]{$min,200}\"|'[^'\\\\]{$min,200}'|\`[^\`\\\\\$]{$min,200}\`|>[^<>{}\"'\`]{$min,200}<" || true; } \
    | sed -E 's/^.(.*).$/\1/; s/^[[:space:]]+//; s/[[:space:]]+$//' \
    | { grep -E '[A-Za-z]' || true; } | { grep -vE '^(\.\.?/|@|node:|#!)|&&|\|\||=>' || true; } \
    | awk -v n="$min" 'length($0) >= n && (/[[:space:]\/→]/ || length($0) >= 12)' | sort -u
}
removed_pick() { # sets removed_tests ("<file>\t<string>" per line, repo paths) and removed_notes (lines for the log)
  local diff gone kept tests hits common grouped skip d rel total
  removed_tests="" removed_notes=""
  diff="$(git diff -U0 --no-color --no-ext-diff "$base"...HEAD -- . ':(exclude)pnpm-lock.yaml' ':(exclude)apps/server/drizzle' 2>/dev/null \
    | awk '/^diff --git /{ f = $3; sub(/^a\//, "", f); hunk = 0; skip = (f ~ /(^|\/)test\// || f ~ /\.(test|spec)\.[a-z]+$/ || f !~ /\.(ts|tsx|mts|js|jsx|mjs)$/); next }
      /^@@/ { hunk = 1; next }
      !hunk || skip { next }
      /^[-+]/ { print }')" || diff=""
  [ -n "$diff" ] || return 0
  gone="$(grep '^-' <<<"$diff" | cut -c2- | removed_lits)"
  [ -n "$gone" ] || return 0
  kept="$(grep '^+' <<<"$diff" | cut -c2- | removed_lits)"
  gone="$(comm -23 <(printf '%s\n' "$gone") <(printf '%s\n' "$kept") | { grep . || true; })"
  [ -n "$gone" ] || return 0
  # shellcheck disable=SC2086  # one argument per package dir
  tests="$(git ls-files -- $removed_test_pkgs 2>/dev/null | { grep -E "$test_file_re" || true; })"
  [ -n "$tests" ] || return 0
  # shellcheck disable=SC2086  # one argument per file; tracked test paths have no spaces
  hits="$({ grep -oHF -f <(printf '%s\n' "$gone") $tests 2>/dev/null || true; } | sort -u)"
  [ -n "$hits" ] || return 0
  common="$(cut -d: -f2- <<<"$hits" | sort | uniq -c | awk -v n="${CHECK_QUICK_REMOVED_COMMON:-10}" '$1 > n { c = $1; sub(/^ *[0-9]+ /, ""); print c "\t" $0 }')"
  if [ -n "$common" ]; then
    removed_notes="$removed_notes$(while IFS=$'\t' read -r n s; do printf 'left out as too common: "%s" (in %s test files)\n' "$s" "$n"; done <<<"$common")"$'\n'
    hits="$(awk -F'\t' 'NR == FNR { drop[$2] = 1; next } { s = substr($0, index($0, ":") + 1) } !(s in drop)' <(printf '%s\n' "$common") - <<<"$hits")"
  fi
  # The tests each package's related run already names.
  skip=""
  for d in $removed_test_pkgs; do
    rel="$(related_list "$d")"
    [ -n "$rel" ] || continue
    ! broad "$rel" || continue
    skip="$skip$d/${rel//$'\n'/$'\n'$d/}"$'\n'
  done
  # One line per file: how many removed strings it names, the file, the first of them; most first, then by path.
  grouped="$({ grep . <<<"$hits" || true; } | awk -F'\t' 'NR == FNR { if ($0 != "") have[$0] = 1; next }
      { f = substr($0, 1, index($0, ":") - 1); s = substr($0, index($0, ":") + 1); if (f in have) next
        n[f]++; if (!(f in first)) first[f] = s }
      END { for (f in n) printf "%d\t%s\t%s\n", n[f], f, first[f] }' <(printf '#\n%s' "$skip") - | sort -t$'\t' -k1,1nr -k2,2)"
  [ -n "$grouped" ] || return 0
  total="$(grep -c . <<<"$grouped")"
  removed_tests="$(head -n "${CHECK_QUICK_REMOVED_MAX:-15}" <<<"$grouped" | cut -f2-)"
  [ "$total" -le "${CHECK_QUICK_REMOVED_MAX:-15}" ] \
    || removed_notes="${removed_notes}cap hit: $total test files name a removed string, running the first ${CHECK_QUICK_REMOVED_MAX:-15} (CHECK_QUICK_REMOVED_MAX)"$'\n'
  return 0
}
removed_tests_in() { # removed_tests_in <package dir>: its picked files, relative to it
  { grep "^$1/" <<<"$removed_tests" || true; } | cut -f1 | sed "s#^$1/##"
}
removed_tests="" removed_notes=""
[ -n "${BOSSMAN_FULL_CHECK_NEXT:-}" ] || removed_pick

if [ "${CHECK_QUICK_PHASE:-}" = heavy ]; then
  # Runs inside the check slot (started by check-all.sh below): exits non-zero when a step failed, with no summary line.
  export NODE_OPTIONS="${NODE_OPTIONS:---max-old-space-size=2048}"
  for d in "${pkgs[@]}"; do
    name="$(node -p "require('./$d/package.json').name")"
    step "typecheck $name" pnpm --filter "$name" typecheck
  done
  for d in "${pkgs[@]}" apps/site; do
    files="$(related_list "$d")"
    [ -n "$files" ] || continue
    ! broad "$files" || continue
    name="$(node -p "require('./$d/package.json').name")"
    # shellcheck disable=SC2086  # one argument per file; paths have no spaces
    step "tests related to $name changes" pnpm --filter "$name" exec vitest related --run $files
  done
  # BOS-2386: the tests that name a string the branch removed (listed with their strings before the slot wait).
  for d in $removed_test_pkgs; do
    files="$(removed_tests_in "$d")"
    [ -n "$files" ] || continue
    name="$(node -p "require('./$d/package.json').name")"
    # shellcheck disable=SC2086  # one argument per file; paths have no spaces
    step "tests naming a string the branch removed ($d, $(grep -c . <<<"$files") files)" pnpm --filter "$name" exec vitest run $files
  done
  # Whole-repo tests (BOS-1732) the related list can't reach: one vitest run per package, from its package folder (same slot,
  # its setup files apply). Named files, so vitest-guard accepts it inside the slot.
  if whole_repo_on; then
    # BOS-1789: every package is looked at, not only the touched ones: a test that reads a touched package runs too.
    for d in apps/launcher apps/runner apps/server apps/web packages/shared; do
      [ "${#pkgs[@]}" -gt 0 ] || [ -n "$wr_outside" ] || break
      files="$(whole_repo_tests "$d" "${pkgs[@]}")"
      [ -n "$files" ] || continue
      name="$(node -p "require('./$d/package.json').name")"
      # The browser tests of apps/web open the built app (apps/web/dist) and skip when it is missing: build it first, here in
      # the slot, so they really run. The build step after the slot wait is then left out (web_built_early). A browser test
      # picked only because it names a changed file outside the packages (BOS-2286) needs the build too.
      # shellcheck disable=SC2086  # one argument per file; paths have no spaces
      if [ "$d" = apps/web ] && { [[ " ${pkgs[*]-} " == *" apps/web "* ]] || (cd apps/web && grep -qlE "$whole_repo_browser" $files); }; then step "build web (before the browser tests)" pnpm --filter @boss-man/web build; fi
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
  files="$(related_list "$d")"
  [ -n "$files" ] || continue
  if broad "$files"; then echo "SKIP related tests: too broad for a hand run, the merge gate runs them ($d; CHECK_QUICK_FORCE_RELATED=1 runs them anyway)"; partial=1
  else need_slot=1; fi
done
# BOS-2386: name each test picked for a removed string, and the string that picked it; they run in the slot.
if [ -n "$removed_tests" ] || [ -n "$removed_notes" ]; then
  echo "INFO  tests that name a string the branch removed or renamed: $(grep -c . <<<"$removed_tests") to run"
  [ -z "$removed_tests" ] || while IFS=$'\t' read -r f s; do printf '      %s  ("%s")\n' "$f" "$s"; done <<<"$removed_tests"
  [ -z "$removed_notes" ] || { grep . <<<"$removed_notes" | sed 's/^/      /'; }
  [ -z "$removed_tests" ] || need_slot=1
fi
# BOS-2286: a change outside the packages only (a compose or deploy file) touches no package, but a whole-repo test that names
# the changed file must still run, in the slot like the others.
if [ "$need_slot" -eq 0 ] && [ -n "$wr_outside" ] && whole_repo_on; then
  for d in apps/launcher apps/runner apps/server apps/web packages/shared; do
    [ -z "$(whole_repo_tests "$d")" ] || { need_slot=1; break; }
  done
fi
# A fresh tree has no packages (BOS-952): the server-owned check queue runs this script in a new detached worktree, and
# typecheck, vitest and the web build then fail with "tsc: not found". Install them first, here before the slot wait so
# the install never holds a check slot. The queue job sets the shared pnpm store (BOS-655), so this is quick when warm.
# A tree that already has node_modules (an agent's checkout) is left as it is.
web_build=0; ! has '^apps/web/|^packages/shared/' || web_build=1
if { [ "$need_slot" -eq 1 ] || [ "$web_build" -eq 1 ]; } && [ -n "${install_tried:-}" ] && [ ! -d node_modules ]; then
  # The list guards above already tried the install on this tree: do not try (and retry) it a second time.
  if [ "$install_tried_failed" -ne 0 ]; then
    echo "SKIP  typecheck, related tests, web build: the install failed"; need_slot=0 web_build=0
  fi
elif { [ "$need_slot" -eq 1 ] || [ "$web_build" -eq 1 ]; } && [ ! -d node_modules ]; then
  before=$failed failed=0 irc=0
  iout="$(install_packages 2>&1)" || irc=$?
  if [ "$irc" -eq 0 ]; then echo "PASS  install packages (fresh tree, no node_modules)"
  else
    echo "FAIL  install packages (fresh tree, no node_modules) (exit $irc)"; printf '%s\n' "$iout" | tail -n 40 | sed 's/^/      /'; failed=1
    # A machine fault with nothing else wrong so far: say so, so the check is retried, not blamed on the branch.
    [ "$irc" -ne 75 ] || [ "$before" -ne 0 ] || env_fault=1
  fi
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
# BOS-2286: the shell tests (*.test.sh) whose subject changed. Before this only the full check and GitHub ran them, so a queued
# check passed where GitHub then failed (negated-redirect.test.sh, BOS-2176). A test runs when
#   - it changed, or it names a changed file by its repo path (deploy/ntfy.yml, docker-compose.yml, .github/workflows/ci.yml),
#   - or it names a changed file of its own folder by file name (scripts/x.test.sh runs "$here/x.sh" and the helpers beside it),
#   - or it reads the whole repo's file list (a `git ls-files` code line with no `cd` into a temp repo: negated-redirect and
#     shell-tests-needed, 1 and 3 s), whatever changed. host-deployer.test.sh lists files of its own temp repo (cd "$T/src")
#     and takes 7 minutes, so it runs only for its own subject.
# Through scripts/test-shell.sh, so each runs in the same scrubbed environment as in the full check and on GitHub. Only where
# the whole-repo tests run (queued checks and the gate; CHECK_QUICK_WHOLE_REPO=1 on a hand run). Not for BOSSMAN_FULL_CHECK_NEXT:
# that full check runs every shell test itself.
shell_tests_for_changes() { # prints the tracked shell tests to run for $changed, one per line
  local t dir c base
  git ls-files '*.test.sh' | while IFS= read -r t; do
    # A whole-repo line runs git ls-files as code: not in a comment or a quoted string (check-quick.test.sh writes such lines
    # into its fixtures), and not after a cd into a temp repo.
    if grep -qxF -- "$t" <<<"$changed" || { grep -E "^[^'#]*git( -C \"[^\"]*\")? ls-files" "$t" | grep -qv 'cd '; } \
      || grep -qF -f <(printf '%s\n' "$changed") "$t"; then echo "$t"; continue; fi
    dir="$(dirname "$t")"
    while IFS= read -r c; do
      [ "$(dirname "$c")" = "$dir" ] || continue
      base="$(basename "$c")"
      # The file name as a whole word: x.sh must not match check-x.sh.
      if grep -qE "(^|[^A-Za-z0-9_.-])${base//./\\.}([^A-Za-z0-9_.-]|$)" "$t"; then echo "$t"; break; fi
    done <<<"$changed"
  done
}
if whole_repo_on; then
  shell_tests="$(shell_tests_for_changes)"
  # shellcheck disable=SC2086  # one argument per file; tracked shell test paths have no spaces
  [ -z "$shell_tests" ] || step "shell tests ($(grep -c . <<<"$shell_tests"): $(tr '\n' ' ' <<<"$shell_tests" | sed 's/ $//'))" scripts/test-shell.sh $shell_tests
fi
# At the gate the heavy phase already built the web app when apps/web has whole-repo tests (web_built_early).
web_built_early=0
if [ "$need_slot" -eq 1 ] && whole_repo_on && [ -n "$(whole_repo_tests apps/web "${pkgs[@]}")" ]; then
  for d in "${pkgs[@]}"; do [ "$d" != apps/web ] || web_built_early=1; done
fi
if [ "$web_build" -eq 1 ] && [ "$web_built_early" -eq 0 ]; then step "build web" pnpm --filter @boss-man/web build; fi

# BOS-2484: the report-only squeeze. Each new or changed vitest file (web, server, shared, launcher, updater; not the runner, and
# not scripts/squeeze-skip.txt) runs on one slow, busy CPU (scripts/squeeze-test.sh). In BOS-1754 that showed 4 of 6 new tests
# that later failed only on GitHub and none of 23 good files. It runs here, after the check slot was released, only when every
# step above passed, for at most 3 files (the rest are counted). A finding is a SQUEEZE line and a closing note, never a FAIL:
# the run's exit code does not change. CHECK_QUICK_SQUEEZE=0 switches it off.
squeeze_note=""
squeeze_files() { # prints the added or changed test files to squeeze (added first), one per line
  local f skip="" kind
  [ ! -f scripts/squeeze-skip.txt ] || skip="$(sed -e 's/[[:space:]]*#.*//' -e '/^[[:space:]]*$/d' scripts/squeeze-skip.txt)"
  for kind in A M; do
    git diff --name-only --diff-filter="$kind" "$base"...HEAD | grep -E '^(apps/(web|server|launcher|updater)|packages/shared)/.*\.(test|spec)\.[cm]?[jt]sx?$' | while IFS= read -r f; do
      [ -f "$f" ] || continue
      grep -qxF -- "$f" <<<"$skip" || echo "$f"
    done
  done
}
if [ "${CHECK_QUICK_SQUEEZE:-}" != 0 ] && [ "$failed" -eq 0 ] && [ "$skipped" -eq 0 ] && [ "$env_fault" -eq 0 ] && [ -x scripts/squeeze-test.sh ]; then
  sq_all="$(squeeze_files | { grep . || true; })"
  if [ -n "$sq_all" ]; then
    sq_total=$(grep -c . <<<"$sq_all"); sq_run=0 sq_bad=0 sq_none=0 sq_err=0
    # BOS-2603: the report must never push a passing check past the job's time limit. CHECK_QUICK_BUDGET_SECONDS (default 1800,
    # a check job's default limit) is counted from the start of this script; a file is squeezed only when its own stop
    # (SQUEEZE_STOP_SECONDS, default 200) plus CHECK_QUICK_SQUEEZE_MARGIN (default 300) still fits in what is left.
    sq_budget="${CHECK_QUICK_BUDGET_SECONDS:-1800}"; [[ "$sq_budget" =~ ^[0-9]+$ ]] || sq_budget=1800
    sq_margin="${CHECK_QUICK_SQUEEZE_MARGIN:-300}"; [[ "$sq_margin" =~ ^[0-9]+$ ]] || sq_margin=300
    sq_stop="${SQUEEZE_STOP_SECONDS:-200}"; [[ "$sq_stop" =~ ^[0-9]+$ ]] || sq_stop=200
    sq_skip=0
    while IFS= read -r sq_f; do
      [ "$sq_run" -lt 3 ] || break
      sq_left_s=$((sq_budget - SECONDS))
      if [ "$sq_left_s" -lt $((sq_stop + sq_margin)) ]; then sq_skip=$(( (sq_total < 3 ? sq_total : 3) - sq_run )); break; fi
      sq_run=$((sq_run + 1)); sq_rc=0
      sq_out="$(scripts/squeeze-test.sh "$sq_f" 2>&1 </dev/null)" || sq_rc=$?
      case "$sq_rc" in
        0) echo "SQUEEZE  pass: $sq_f" ;;
        1) sq_bad=$((sq_bad + 1)); echo "SQUEEZE  FAILED on a slow, busy CPU (report only, does not fail this check): $sq_f"
           echo "      GitHub's machines are 2.5 to 5 times slower: look for a time limit or a short fixed sleep. Rerun: scripts/squeeze-test.sh $sq_f"
           printf '%s\n' "$sq_out" | tail -n 12 | sed 's/^/      /' ;;
        3) sq_none=$((sq_none + 1)); echo "SQUEEZE  no answer (stopped before it finished; neither pass nor fail): $sq_f" ;;
        *) sq_err=$((sq_err + 1)); echo "SQUEEZE  could not run (exit $sq_rc; not a finding): $sq_f"; printf '%s\n' "$sq_out" | tail -n 4 | sed 's/^/      /' ;;
      esac
    done <<<"$sq_all"
    if [ "$sq_skip" -gt 0 ]; then
      echo "SQUEEZE  skipped: $sq_skip files, not enough time left ($((sq_budget - SECONDS))s)"
    fi
    sq_left=$((sq_total - sq_run - sq_skip)); [ "$sq_left" -ge 0 ] || sq_left=0
    [ "$sq_left" -le 0 ] || [ "$sq_skip" -gt 0 ] || echo "SQUEEZE  $sq_left more changed test file(s) were not squeezed (at most 3 a check)"
    squeeze_note="squeeze (report only): $sq_run of $sq_total test files run on a slow CPU, $sq_bad failed, $sq_none no answer, $sq_err could not run, $sq_skip skipped for lack of time, $((sq_total - sq_run - sq_skip)) left out"
  else
    squeeze_note="squeeze (report only): no new or changed test file to run"
  fi
fi

if [ "$failed" -ne 0 ] && [ "$env_fault" -eq 1 ]; then echo "$ENV_FAULT_MARKER: nothing of the branch was checked (exit 75)"; return 75; fi
if [ "$failed" -ne 0 ]; then echo "check-quick: FAILED"; return 1; fi
if [ "$skipped" -eq 1 ]; then echo "check-quick: nothing failed, but typecheck and related tests did not run (no check slot); run it again (exit 75)"; return 75; fi
echo "check-quick: all steps passed (the merge gate also runs the whole-repo tests of the packages you touched; high and critical tickets get the full check too)"
[ -z "$squeeze_note" ] || echo "check-quick: $squeeze_note"
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
