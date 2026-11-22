#!/usr/bin/env bash
# Checks request-ceo-ticket.sh: it prints one RAISE-CEO-TICKET line naming the failure, exits non-zero (so the agent
# acts on it), and does nothing else — no hand-made request to Boss Man, no token, no curl (BOS-2070).
set -euo pipefail
# The hook itself runs under `sh` (the publish step supplies it that way, BOS-2070); this test is a bash script
# ([[ ]] below), so it keeps bash's own safety options.
here="$(cd "$(dirname "$0")" && pwd)"
t="$(mktemp -d)"; trap 'rm -rf "$t"' EXIT
fail() { echo "FAIL: $*"; exit 1; }
s="$here/request-ceo-ticket.sh"

# A fake curl and a fake node that record any use: the hook must reach for neither. If it does, the test fails, which
# is what would have caught the hand-made /mcp call.
mkdir -p "$t/bin"
printf '#!/bin/sh\necho "curl was called: $*" >>"%s/called"\nexit 0\n' "$t" >"$t/bin/curl"
printf '#!/bin/sh\necho "node was called: $*" >>"%s/called"\nexit 0\n' "$t" >"$t/bin/node"
chmod +x "$t/bin/curl" "$t/bin/node"
export PATH="$t/bin:$PATH"

# 1. A real failure: one line starting RAISE-CEO-TICKET, the reason in it, a non-zero exit, nothing else touched.
set +e
out="$(INDEXNOW_FAILURE='IndexNow answered HTTP 403 (a "quoted" bit, a \ backslash)' "$s" 2>"$t/err")"
status=$?
set -e
[ "$status" -ne 0 ] || fail "the hook should exit non-zero so the agent notices: status $status"
lines="$(printf '%s\n' "$out" | grep -c . || true)"
[ "$lines" -eq 1 ] || fail "the hook should print one line, got $lines: $out"
printf '%s\n' "$out" | grep -q '^RAISE-CEO-TICKET: ' || fail "the line should start RAISE-CEO-TICKET: $out"
printf '%s\n' "$out" | grep -qF 'HTTP 403' || fail "the reason is not in the line: $out"
printf '%s\n' "$out" | grep -qi 'create_ticket' || fail "the line should say how to report it (create_ticket): $out"
grep -qF 'HTTP 403' "$t/err" || fail "the same line should be on stderr too: $(cat "$t/err")"
[ -e "$t/called" ] && fail "the hook must not call curl or node: $(cat "$t/called")"

# 2. No reason: nothing to report, exit 0, nothing printed.
set +e
out="$(env -u INDEXNOW_FAILURE "$s" 2>&1)"; status=$?
set -e
[ "$status" -eq 0 ] || fail "no reason should exit 0: status $status"
printf '%s\n' "$out" | grep -q 'RAISE-CEO-TICKET' && fail "no reason should print no request: $out"
[ -e "$t/called" ] && fail "the hook must not call curl or node: $(cat "$t/called")"

# 3. The hook is written for `sh` (no bash-only syntax), so the shell the publish step supplies runs it cleanly.
sh -n "$s" || fail "request-ceo-ticket.sh is not a clean POSIX sh script"

echo "request-ceo-ticket.test.sh: all passed"
