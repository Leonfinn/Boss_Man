#!/usr/bin/env bash
# Checks check-compose.sh with the real Docker CLI + compose plugin and actionlint, on this repo's files and on files with the
# slips reviewers have caught by eye (BOS-971, BOS-972). Skipped (exit 0) where the tools are not installed: a runner image from
# before BOS-1036, or a laptop. CI installs nothing extra, so the real files are checked by the runner's check-quick instead.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
if ! command -v actionlint >/dev/null 2>&1 || ! docker compose version >/dev/null 2>&1; then echo "check-compose.test.sh: skipped (docker compose or actionlint not installed)"; exit 0; fi
t="$(mktemp -d)"; trap 'rm -rf "$t"' EXIT
fail() { echo "FAIL: $*"; exit 1; }
rc=0

# This repo's own files pass.
(cd "$here/.." && ./scripts/check-compose.sh >"$t/out" 2>&1) || fail "the repo's own files fail: $(cat "$t/out")"

# A scratch tree with the script and only the files each case needs.
mk() { rm -rf "$t/r"; mkdir -p "$t/r/scripts" "$t/r/deploy" "$t/r/.github/workflows"; cp "$here/check-compose.sh" "$t/r/scripts/"; }

# BOS-972: a service indented inside the x-runner anchor instead of under services:.
mk; cat >"$t/r/docker-compose.yml" <<'Y'
x-runner: &runner
  image: example:1
  claude-pack:
    image: example:2
services:
  a:
    <<: *runner
Y
(cd "$t/r" && ./scripts/check-compose.sh >"$t/out" 2>&1) && fail "a service inside the anchor passed"
grep -q "FAIL  compose set \[docker-compose.yml\]" "$t/out" || fail "the failing set is not named: $(cat "$t/out")"

# BOS-971: a job that needs a job that does not exist, and a step with no run or uses.
mk; cat >"$t/r/.github/workflows/ci.yml" <<'Y'
name: x
on: push
jobs:
  a:
    runs-on: ubuntu-latest
    needs: [nope]
    steps:
      - name: nothing
Y
(cd "$t/r" && ./scripts/check-compose.sh >"$t/out" 2>&1) && fail "a broken workflow passed"
grep -q "ci.yml:" "$t/out" || fail "the workflow file and line are not shown: $(cat "$t/out")"

# A valid minimal pair passes, and the tools missing is exit 3, not a pass.
mk; printf 'services:\n  a:\n    image: example:1\n' >"$t/r/docker-compose.yml"
(cd "$t/r" && ./scripts/check-compose.sh >"$t/out" 2>&1) || fail "a valid file failed: $(cat "$t/out")"
(cd "$t/r" && PATH=/nonexistent /bin/bash ./scripts/check-compose.sh >"$t/out" 2>&1) || rc=$?
[ "$rc" -eq 3 ] || fail "missing tools should exit 3, got $rc: $(cat "$t/out")"

echo "check-compose.test.sh: ok"
