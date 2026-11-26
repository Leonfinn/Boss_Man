#!/usr/bin/env bash
# The shell tests (*.test.sh) whose subject changed (BOS-2286), for a list of changed repo paths on stdin, one per line.
# Prints the tracked shell tests that count as touched, one per line. Run from the repo root. Two users share this one rule:
#   - scripts/check-quick.sh runs these tests in a queued check and at the merge gate;
#   - the merge gate's re-run of a shell test GitHub CI failed (apps/server/src/services/ci-flake.ts, gateRerunCommand) asks
#     it whether the branch touches the test: a touched test is the branch's failure and goes back, an untouched one is
#     re-run as a possible one-off.
# A test counts as touched when
#   - it changed, or it names a changed file by its repo path (deploy/ntfy.yml, docker-compose.yml, .github/workflows/ci.yml),
#   - or it names a changed file of its own folder by file name (scripts/x.test.sh runs "$here/x.sh" and the helpers beside it),
#   - or it reads the whole repo's file list (a `git ls-files` code line with no `cd` into a temp repo: negated-redirect and
#     shell-tests-needed, 1 and 3 s), whatever changed. host-deployer.test.sh lists files of its own temp repo (cd "$T/src")
#     and takes 7 minutes, so it counts only for its own subject.
# An empty list prints nothing.
set -euo pipefail
changed="$(grep -v '^$' || true)"
[ -n "$changed" ] || exit 0
git ls-files '*.test.sh' | while IFS= read -r t; do
  # A whole-repo line runs git ls-files as code: not in a comment or a quoted string (check-quick.test.sh writes such lines
  # into its fixtures), and not after a cd into a temp repo.
  if grep -qxF -- "$t" <<<"$changed" || { grep -E "^[^'#]*git( -C \"[^\"]*\")? ls-files" "$t" | grep -qv 'cd '; } \
    || grep -qF -f <(printf '%s\n' "$changed") "$t"; then
    echo "$t"
    continue
  fi
  dir="$(dirname "$t")"
  while IFS= read -r c; do
    [ "$(dirname "$c")" = "$dir" ] || continue
    base="$(basename "$c")"
    # The file name as a whole word: x.sh must not match check-x.sh.
    if grep -qE "(^|[^A-Za-z0-9_.-])${base//./\\.}([^A-Za-z0-9_.-]|$)" "$t"; then
      echo "$t"
      break
    fi
  done <<<"$changed"
done
