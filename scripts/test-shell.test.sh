#!/usr/bin/env bash
# test-shell.sh runs each test in a scrubbed environment (DR-025): a variable set in the caller must not reach the test.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
fail() { echo "test-shell.test.sh: FAIL: $*" >&2; exit 1; }
t=$(mktemp -d); trap 'rm -rf "$t"' EXIT
# shellcheck disable=SC2016  # the fake test body is meant to be written unexpanded
printf '#!/usr/bin/env bash\n[ -z "${BOSSMAN_MERGE_CHECK:-}" ] || { echo "leaked BOSSMAN_MERGE_CHECK"; exit 1; }\n[ -z "${SOME_OTHER_VAR:-}" ] || exit 1\n' >"$t/fake.test.sh"
chmod +x "$t/fake.test.sh"
rc=0; out=$(env -i PATH="$PATH" HOME="$HOME" BOSSMAN_MERGE_CHECK=1 SOME_OTHER_VAR=x scripts/test-shell.sh "$t/fake.test.sh" 2>&1) || rc=$?
[ "$rc" = 0 ] || fail "the fake test saw the caller's variables (exit $rc): $out"
# The fake test really does fail when the variable is present, so the pass above means something.
rc=0; BOSSMAN_MERGE_CHECK=1 "$t/fake.test.sh" >/dev/null 2>&1 || rc=$?
[ "$rc" = 1 ] || fail "control: the fake test should exit 1 with BOSSMAN_MERGE_CHECK set, got $rc"
echo "test-shell.test.sh: ok"
