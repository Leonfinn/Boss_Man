#!/usr/bin/env bash
# The shell scripts' own tests (none needs Docker). CI and scripts/check-all.sh both run this; every tracked *.test.sh runs.
# Each test runs in a scrubbed environment (DR-025): only PATH, HOME, TMPDIR and LANG, so a variable the merge gate
# sets (such as BOSSMAN_MERGE_CHECK) cannot change a test's result. Arguments replace the default test list (used by test-shell.test.sh).
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
# Every tracked *.test.sh runs (git ls-files); nothing needs adding to a list. Skip list: one "path  # reason" per entry.
skip=(
  # (empty: every tracked test runs)
)
tests=()
while IFS= read -r f; do
  for s in ${skip[@]+"${skip[@]}"}; do [ "$f" != "$s" ] || continue 2; done
  tests+=("$f")
done < <(git ls-files '*.test.sh')
[ "$#" -eq 0 ] || tests=("$@")
for t in "${tests[@]}"; do
  # CADDY is the one named opt-in: caddy-edge.test.sh skips without it, and CI points it at the caddy binary.
  extra=()
  [ -z "${CADDY:-}" ] || extra+=("CADDY=$CADDY")
  # The real-install opt-ins of install-images.test.sh (BOS-974): without INSTALL_RELEASE_JSON it only reads the compose file.
  [ -z "${INSTALL_RELEASE_JSON:-}" ] || extra+=("INSTALL_RELEASE_JSON=$INSTALL_RELEASE_JSON")
  [ -z "${INSTALL_REGISTRY:-}" ] || extra+=("INSTALL_REGISTRY=$INSTALL_REGISTRY")
  began=$SECONDS; rc=0
  out=$(mktemp)
  env -i PATH="$PATH" HOME="$HOME" TMPDIR="${TMPDIR:-/tmp}" LANG=C.UTF-8 "${extra[@]}" "$t" >"$out" 2>&1 || rc=$?
  cat "$out"
  # BOSSMAN_SHELL_TIMES_FILE (set by check-all.sh): one "<script>\t<seconds>\t<exit>" line per test, for the result store (BOS-654).
  [ -z "${BOSSMAN_SHELL_TIMES_FILE:-}" ] || printf '%s\t%s\t%s\n' "$t" "$((SECONDS - began))" "$rc" >>"$BOSSMAN_SHELL_TIMES_FILE" 2>/dev/null || true
  # Name the failing test: GitHub keeps only "exit code 1" for the step, so the log line is how a failure is found (BOS-1641).
  if [ "$rc" -ne 0 ]; then
    echo "test-shell: FAILED $t (exit $rc)" >&2
    # On GitHub the step log needs a sign-in, but an annotation shows on the public job page: put the test name and the last lines there.
    if [ -n "${GITHUB_ACTIONS:-}" ]; then
      tail_text=$(tail -n 15 "$out" | cut -c1-300 | sed -e 's/%/%25/g' -e ':a;N;$!ba;s/\n/%0A/g' -e 's/\r//g')
      echo "::error title=test-shell FAILED $t (exit $rc)::$tail_text"
    fi
    exit "$rc"
  fi
  rm -f "$out"
done
