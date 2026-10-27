#!/usr/bin/env bash
# Checks penpot.sh with a fake curl (and the real jq): the ungranted-agent message, the missing-tools
# message, that the export logs in and sends a Transit body with the session cookie, and that the
# token, password and session never land on a command line, in output or in the saved file.
set -euo pipefail
unset PENPOT_URL PENPOT_TOKEN PENPOT_EMAIL PENPOT_PASSWORD
here="$(cd "$(dirname "$0")" && pwd)"
t="$(mktemp -d)"; trap 'rm -rf "$t"' EXIT
mkdir "$t/bin"
# Wrapper that logs jq's arguments, then runs the real jq.
realjq="$(command -v jq)"
printf '#!/usr/bin/env bash\necho "jq $*" >>"$FAKE_JQ_LOG"\nexec %s "$@"\n' "$realjq" >"$t/bin/jq"
chmod +x "$t/bin/jq"
cat >"$t/bin/curl" <<'FAKE'
#!/usr/bin/env bash
echo "curl $*" >>"$FAKE_CURL_LOG"
stdin=""
if [[ "$*" == *" -K -"* || "$*" == *"--data @-"* ]]; then stdin="$(cat)"; echo "stdin: $stdin" >>"$FAKE_CURL_LOG"; fi
if [[ ${FAKE_HTTP_FAIL:-0} == 1 ]]; then exit 7; fi
out=""; wc=""; dump=""
a=("$@")
for i in "${!a[@]}"; do
  [[ ${a[i]} == -o ]] && out="${a[i+1]:-}"
  [[ ${a[i]} == -w ]] && wc="${a[i+1]:-}"
  [[ ${a[i]} == -D ]] && dump="${a[i+1]:-}"
done
code=200; body=""
if [[ "$*" == *"login-with-password"* ]]; then
  [[ ${FAKE_LOGIN_FAIL:-} == 1 ]] && code=400
  body='{"id":"11111111-1111-1111-1111-111111111111"}'
  [[ -n $dump ]] && printf 'HTTP/1.1 200 OK\r\nSet-Cookie: auth-token=SESSIONVALUE9; Path=/; HttpOnly\r\n\r\n' >"$dump"
elif [[ "$*" == *"/api/export"* ]]; then
  [[ ${FAKE_NO_URI:-} == 1 ]] || body="$(printf '{"~:uri":{"~#uri":"%s"}}' "$FAKE_EXPORT_URI")"
elif [[ "$*" == *"/api/rpc/command/"* ]]; then
  body='{"fullname":"Agent"}'
else
  body="$(printf '%b' "$FAKE_FILE_BYTES")"
fi
if [[ -n $out ]]; then printf '%s' "$body" >"$out"; else printf '%s' "$body"; fi
if [[ -n $wc ]]; then printf '%s' "$code"; fi
FAKE
chmod +x "$t/bin/curl"
U="7dcd82a7-396d-80be-8008-d9d70fcdf1df"
export PATH="$t/bin:$PATH" FAKE_CURL_LOG="$t/curl.log" FAKE_JQ_LOG="$t/jq.log" FAKE_FILE_BYTES=''
fail() { echo "FAIL: $*"; exit 1; }
run() { bash "$here/penpot.sh" "$@" 2>"$t/err"; }

# Ungranted agent: no env vars, clear message, non-zero, nothing asked to curl.
if run check >/dev/null; then fail "should fail without env vars"; fi
grep -q "Penpot is not set up for you" "$t/err" || fail "unclear message for an ungranted agent"
grep -q "grant both secrets to you" "$t/err" || fail "message doesn't tell the agent what to do"
if [[ -e $t/curl.log ]]; then fail "called curl without a token"; fi

# Missing curl or jq: the script says so instead of a cryptic "command not found".
system_bash="$(command -v bash)" system_grep="$(command -v grep)"
mkdir -p "$t/empty"; oldPATH="$PATH"
PATH="$t/empty" "$system_bash" "$here/penpot.sh" check >"$t/inner.out" 2>"$t/inner.err" || true
"$system_grep" -q "not installed here" "$t/inner.err" || fail "missing-tools case unclear"
PATH="$oldPATH"

# Token only ever goes in via stdin.
export PENPOT_URL="http://10.9.9.9:9001" PENPOT_TOKEN="SUPERSECRET123"
run check >/dev/null
grep -q 'header = "Authorization: Token SUPERSECRET123"' "$t/curl.log" || fail "no auth header reached curl"

# Export without the login secrets: a plain message, no curl.
: >"$t/curl.log"
if run export $U $U $U "$t/board.png" >/dev/null; then fail "exported without a login"; fi
grep -q "PENPOT_EMAIL and PENPOT_PASSWORD" "$t/err" || fail "no message about the login secrets"
[[ ! -s $t/curl.log ]] || fail "called curl without a login"

# Granted export: logs in, sends Transit with the session cookie, saves a PNG.
export PENPOT_EMAIL="agent@penpot.local" PENPOT_PASSWORD="PWSECRET456" FAKE_EXPORT_URI="http://10.9.9.9:9001/assets/by-id/x" FAKE_FILE_BYTES='\x89PNG\r\n\x1a\n12345'
: >"$t/curl.log"
run export $U $U $U "$t/board.png" >"$t/out"
grep -q 'application/transit+json' "$t/curl.log" || fail "export not sent as Transit"
grep -q '~:export-shapes' "$t/curl.log" || fail "no export-shapes command"
grep -q 'header = "Cookie: auth-token=SESSIONVALUE9"' "$t/curl.log" || fail "session cookie not sent"
[[ "$(head -c 8 "$t/board.png" | od -An -tx1 | tr -d ' \n')" == "89504e470d0a1a0a" ]] || fail "PNG magic not written"
for s in SUPERSECRET123 PWSECRET456 SESSIONVALUE9; do
  if grep -q "$s" <(grep '^curl ' "$t/curl.log"); then fail "$s on curl's command line"; fi
  if grep -q "$s" "$t/err" "$t/out"; then fail "$s printed"; fi
  if grep -q "$s" "$t/jq.log"; then fail "$s on jq's command line"; fi
done
grep -q '^jq ' "$t/jq.log" || fail "jq arguments were not logged"
grep -q 'api/rpc/command/logout' "$t/curl.log" || fail "no logout after export"

# Wrong password.
FAKE_LOGIN_FAIL=1 run export $U $U $U "$t/board.png" >/dev/null && fail "accepted a failed login"
grep -q "refused the agent account" "$t/err" || fail "login failure unexplained"

# Ids must be UUID-looking (they go into the Transit body).
if run export 'x"y' $U $U "$t/board.png" >/dev/null; then fail "accepted a bad id"; fi
grep -q "ids must be UUIDs" "$t/err" || fail "bad id unexplained"

# Not a PNG: the file is removed and the failure is explained.
export FAKE_FILE_BYTES='\x00\x01\x02'
if run export $U $U $U "$t/board.png" >/dev/null; then fail "accepted a non-PNG"; fi
[[ ! -e $t/board.png ]] || fail "left the non-PNG file"

# Exporter gave no uri.
: >"$t/curl.log"
export FAKE_NO_URI=1
if run export $U $U $U "$t/board.png" >/dev/null; then fail "accepted a missing uri"; fi
grep -q "gave no image link" "$t/err" || fail "no fallback message"
grep -q 'api/rpc/command/logout' "$t/curl.log" || fail "no logout after a failed export"

# A relative /assets/ link is accepted.
export FAKE_NO_URI=0 FAKE_EXPORT_URI="/assets/by-id/x" FAKE_FILE_BYTES='\x89PNG\r\n\x1a\n12345'
run export $U $U $U "$t/board.png" >/dev/null || fail "rejected a relative /assets/ link"

# Export link spelled with another host but an /assets/ path: fetched from our own base.
export FAKE_NO_URI=0 FAKE_EXPORT_URI="http://penpot.example/assets/by-id/x" FAKE_FILE_BYTES='\x89PNG\r\n\x1a\n12345'
: >"$t/curl.log"
run export $U $U $U "$t/board.png" >/dev/null || fail "rejected an /assets/ link with another spelling"
if grep '^curl ' "$t/curl.log" | grep -q 'penpot.example'; then fail "contacted the link's own host"; fi

# Export link that is not an asset path: refused, the session is never sent there.
export FAKE_EXPORT_URI="http://other.example/x.png" FAKE_FILE_BYTES='\x89PNG\r\n\x1a\n12345'
if run export $U $U $U "$t/board.png" >/dev/null; then fail "followed a foreign link"; fi

# Unreachable Penpot: a plain error, no token leaked.
export FAKE_HTTP_FAIL=1
if run check >/dev/null; then fail "should fail when Penpot is down"; fi
grep -q "can't reach Penpot" "$t/err" || fail "unreachable case not explained"
if grep -q 'SUPERSECRET123' "$t/err"; then fail "token leaked when unreachable"; fi

echo "penpot.test.sh: ok"
