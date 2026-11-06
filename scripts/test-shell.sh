#!/usr/bin/env bash
# The shell scripts' own tests (none needs Docker). CI and scripts/check-all.sh both run this; a new *.test.sh goes here.
# Each test runs in a scrubbed environment (DR-025): only PATH, HOME, TMPDIR and LANG, so a variable the merge gate
# sets (such as BOSSMAN_MERGE_CHECK) cannot change a test's result. Arguments replace the default test list (used by test-shell.test.sh).
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
tests=(scripts/deploy.test.sh scripts/host-deployer.test.sh scripts/update-runner.test.sh scripts/rebuild-live.test.sh scripts/caddy-edge.test.sh scripts/backup-penpot.test.sh scripts/check-all.test.sh scripts/check-quick.test.sh scripts/sweep-tmp.test.sh scripts/restore-test.test.sh scripts/browser-check.test.sh scripts/test-shell.test.sh skills/penpot/scripts/penpot.test.sh skills/penpot/scripts/penpot.write.test.sh apps/netguard/netguard.test.sh)
[ "$#" -eq 0 ] || tests=("$@")
for t in "${tests[@]}"; do
  # CADDY is the one named opt-in: caddy-edge.test.sh skips without it, and CI points it at the caddy binary.
  extra=()
  [ -z "${CADDY:-}" ] || extra+=("CADDY=$CADDY")
  env -i PATH="$PATH" HOME="$HOME" TMPDIR="${TMPDIR:-/tmp}" LANG=C.UTF-8 "${extra[@]}" "$t"
done
