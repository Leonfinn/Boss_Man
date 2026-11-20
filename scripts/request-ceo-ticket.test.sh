#!/usr/bin/env bash
# Checks request-ceo-ticket.sh: it posts a ticket to Boss Man's own API with the run's token, JSON-escapes the
# reason, and never fails the publish (a missing token, address or reason only prints why). Nothing is sent.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
t="$(mktemp -d)"; trap 'rm -rf "$t"' EXIT
fail() { echo "FAIL: $*"; exit 1; }
s="$here/request-ceo-ticket.sh"

# A fake curl that records its arguments and the JSON it was given (--data's value is the second-last argument).
mkdir -p "$t/bin"
cat >"$t/bin/curl" <<'FAKE'
#!/usr/bin/env bash
printf '%s\n' "$@" >"$FAKE_ARGS"
while [ "$#" -gt 0 ]; do [ "$1" = "--data" ] && printf '%s' "$2" >"$FAKE_BODY"; shift; done
[ -z "${CURL_FAIL:-}" ] || { echo "curl: (22) The requested URL returned error: 404" >&2; exit 22; }
FAKE
chmod +x "$t/bin/curl"
export PATH="$t/bin:$PATH" FAKE_ARGS="$t/args" FAKE_BODY="$t/body"

# 1. A run with its token calls the run's MCP endpoint to create the ticket, and the reason is in the body exactly
#    (quotes and backslashes kept).
: >"$FAKE_ARGS"
BOSSMAN_TOKEN=tok BOSSMAN_API_URL="https://bossman.test/" INDEXNOW_FAILURE='IndexNow answered HTTP 403 (a "quoted" bit, a \ backslash)' \
  "$s" >"$t/out" 2>&1 || fail "should succeed with a token"
curlargs="$(cat "$FAKE_ARGS")"
[[ "$curlargs" == *"Bearer tok"* ]] || fail "token not sent: $curlargs"
[[ "$curlargs" == *"https://bossman.test/mcp"$'\n'* || "$curlargs" == *"https://bossman.test/mcp" ]] || fail "trailing slash not trimmed: $curlargs"
body="$(cat "$FAKE_BODY")"
# shellcheck disable=SC2016 # the JavaScript is single-quoted on purpose: the shell must not touch it
node -e 'const b=JSON.parse(process.argv[1]); const a=b?.params?.arguments; if(b?.params?.name!=="create_ticket"||!a?.title||!a.body.includes(String.raw`a "quoted" bit, a \ backslash`)||a.body.includes("undefined")) process.exit(1)' "$body" \
  || fail "body is not the escaped MCP call expected: $body"
[[ "$body" == *'"size":1'* ]] || fail "a one-line ticket should be size 1: $body"

# 2. A refused request does not fail the publish, and says so.
CURL_FAIL=1 BOSSMAN_TOKEN=tok BOSSMAN_API_URL="https://bossman.test" INDEXNOW_FAILURE="x" "$s" >"$t/out" 2>&1 \
  || fail "a refused ticket must not fail the publish"
grep -q "could not raise a ticket" "$t/out" || fail "a refused ticket should say so: $(cat "$t/out")"

# 3. No token, no address or no reason: nothing sent, exits 0.
: >"$FAKE_ARGS"
env -u BOSSMAN_TOKEN -u BOSSMAN_API_URL INDEXNOW_FAILURE="x" "$s" >"$t/out" 2>&1 || fail "no token should still exit 0"
[ -s "$FAKE_ARGS" ] && fail "nothing should be sent without a token"
grep -q "BOSSMAN_TOKEN or BOSSMAN_API_URL is not set" "$t/out" || fail "missing token should say why"
: >"$FAKE_ARGS"
BOSSMAN_TOKEN=tok BOSSMAN_API_URL="https://bossman.test" env -u INDEXNOW_FAILURE "$s" >"$t/out" 2>&1 || fail "no reason should still exit 0"
[ -s "$FAKE_ARGS" ] && fail "nothing should be sent without a reason"

echo "request-ceo-ticket.test.sh: all passed"
