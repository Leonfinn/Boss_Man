#!/usr/bin/env bash
# Checks penpot.sh with fake curl and jq: the ungranted-agent message, the missing-tools
# message, and that the token never lands on a command line, in output or in the saved file.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
t="$(mktemp -d)"; trap 'rm -rf "$t"' EXIT
mkdir "$t/bin"
cat >"$t/bin/jq" <<'FAKE'
#!/usr/bin/env bash
# Stand-in jq: -r '.uri // empty' prints the fake export result; -nc builds bodies (unused).
[[ $1 == -r && $2 == *uri* ]] && { [[ ${FAKE_NO_URI:-} == 1 ]] || echo "$FAKE_EXPORT_URI"; }
exit 0
FAKE
cat >"$t/bin/curl" <<'FAKE'
#!/usr/bin/env bash
echo "curl $*" >>"$FAKE_CURL_LOG"
if [[ "$*" == *" -K -"* ]]; then # -K - reads the auth config from stdin; capture it to prove no argv token
  echo "stdin: $(cat)" >>"$FAKE_CURL_LOG"
fi
if [[ ${FAKE_HTTP_FAIL:-0} == 1 ]]; then exit 7; fi
# Honour -o FILE and -w '%{http_code}' the way the script relies on.
out=""; wc=""
a=("$@")
for i in "${!a[@]}"; do
  [[ ${a[i]} == -o ]] && out="${a[i+1]:-}"
  [[ ${a[i]} == -w ]] && wc="${a[i+1]:-}"
done
body=""
if [[ "$*" == *"/api/export"* ]]; then
  [[ ${FAKE_NO_URI:-} == 1 ]] || body="$(printf '{"uri":"%s"}' "$FAKE_EXPORT_URI")"
else
  body="$(printf '%b' "$FAKE_FILE_BYTES")"
fi
if [[ -n $out ]]; then printf '%s' "$body" >"$out"; else printf '%s' "$body"; fi
if [[ -n $wc ]]; then printf '%s' 200; fi
FAKE
chmod +x "$t/bin/jq" "$t/bin/curl"
export PATH="$t/bin:$PATH" FAKE_CURL_LOG="$t/curl.log" FAKE_EXPORT_URI="$t/board.png" FAKE_FILE_BYTES=''
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

# Granted: a token set but only ever used via stdin; it appears in no output or argv.
export PENPOT_URL="http://10.9.9.9:9001" PENPOT_TOKEN="SUPERSECRET123" FAKE_FILE_BYTES='\x89PNG\r\n\x1a\n12345'
run export F P B "$t/board.png" >/dev/null
[[ "$(grep -c 'header = "Authorization: Token SUPERSECRET123"' "$t/curl.log")" -ge 1 ]] || fail "no auth header reached curl"
if grep -rqs 'SUPERSECRET123' "$t/err"; then fail "token printed in stderr"; fi
# The token must not be visible in the process arguments: curl is called with -K -, no token on argv.
if grep -q 'SUPERSECRET123' <(grep '^curl ' "$t/curl.log"); then fail "token on curl's command line"; fi

# The saved file passes the PNG magic check.
[[ "$(head -c 8 "$t/board.png" | od -An -tx1 | tr -d ' \n')" == "89504e470d0a1a0a" ]] || fail "PNG magic not written"

# Not a PNG: the file is removed and the failure is explained.
export FAKE_FILE_BYTES='\x00\x01\x02'
if run export F P B "$t/board.png" >/dev/null; then fail "accepted a non-PNG"; fi
[[ ! -e $t/board.png ]] || fail "left the non-PNG file"

# Exporter gave no uri: the fallback message for the owner.
export FAKE_NO_URI=1
if run export F P B "$t/board.png" >/dev/null; then fail "accepted a missing uri"; fi
grep -q "Per-board PNG export is not confirmed" "$t/err" || fail "no fallback message"

# Unreachable Penpot: a plain error, no token leaked.
export FAKE_HTTP_FAIL=1
if run check >/dev/null; then fail "should fail when Penpot is down"; fi
grep -q "can't reach Penpot" "$t/err" || fail "unreachable case not explained"
if grep -rqs 'SUPERSECRET123' "$t/err"; then fail "token leaked when unreachable"; fi

# The export uri points at another host: the download must go without the token.
export FAKE_HTTP_FAIL=0 FAKE_NO_URI=0 PENPOT_URL="http://10.9.9.9:9001" FAKE_EXPORT_URI="http://other.example/x.png" FAKE_FILE_BYTES='\x89PNG\r\n\x1a\n12345'
: >"$t/curl.log"
run export F P B "$t/board.png" >/dev/null
# Two calls (the export, then the download); only the export to our base carries the auth header.
[[ "$(grep -c 'header = "Authorization: Token SUPERSECRET123"' "$t/curl.log")" == 1 ]] || fail "token sent to a foreign host on the download"

echo "penpot.test.sh: ok"