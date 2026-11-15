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
  began=$SECONDS; rc=0
  env -i PATH="$PATH" HOME="$HOME" TMPDIR="${TMPDIR:-/tmp}" LANG=C.UTF-8 "${extra[@]}" "$t" || rc=$?
  # BOSSMAN_SHELL_TIMES_FILE (set by check-all.sh): one "<script>\t<seconds>\t<exit>" line per test, for the result store (BOS-654).
  [ -z "${BOSSMAN_SHELL_TIMES_FILE:-}" ] || printf '%s\t%s\t%s\n' "$t" "$((SECONDS - began))" "$rc" >>"$BOSSMAN_SHELL_TIMES_FILE" 2>/dev/null || true
  [ "$rc" -eq 0 ] || exit "$rc"
done
