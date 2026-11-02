#!/usr/bin/env bash
# Checks browser-check.sh with a stub in place of Chromium (BOSSMAN_CHROMIUM); needs no browser or Docker.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
t="$(mktemp -d)"; trap 'rm -rf "$t"' EXIT
fail() { echo "FAIL: $*"; exit 1; }
unset BOSSMAN_CHECK_HOST BOSSMAN_CHROMIUM
cat >"$t/chromium" <<'STUB'
#!/usr/bin/env bash
echo "$*" >>"$STUB_LOG"
for a in "$@"; do case $a in --screenshot=*) : >"${a#--screenshot=}" ;; esac; done
echo "<html></html>"
STUB
chmod +x "$t/chromium"
export STUB_LOG="$t/log"

# loopback is refused, whatever spelling
for h in localhost 127.0.0.1 ::1; do
  rc=0; BOSSMAN_CHECK_HOST=$h "$here/browser-check.sh" --print-url >/dev/null 2>&1 || rc=$?
  [ "$rc" -eq 1 ] || fail "loopback $h gave rc $rc, want 1"
done

# an explicit host is used as is, with port and path
[ "$(BOSSMAN_CHECK_HOST=10.1.2.3 "$here/browser-check.sh" --print-url --port 8080 --path x)" = "http://10.1.2.3:8080/x" ] || fail "url"
[ "$(BOSSMAN_CHECK_HOST=fd00::5 "$here/browser-check.sh" --print-url)" = "http://[fd00::5]:3100/" ] || fail "ipv6 url"

# discovery never answers with a loopback address
if got=$("$here/browser-check.sh" --print-url 2>/dev/null); then
  case $got in http://127.* | http://localhost*) fail "discovered loopback: $got" ;; esac
fi

# both profiles run, the phone one with touch and a small window
BOSSMAN_CHECK_HOST=10.1.2.3 BOSSMAN_CHROMIUM="$t/chromium" "$here/browser-check.sh" --out "$t/out" >/dev/null
for f in desktop.png phone.png desktop.html phone.html; do [ -e "$t/out/$f" ] || fail "missing $f"; done
grep -q -- '--window-size=1280,800' "$t/log" || fail "no desktop size"
grep -q -- '--window-size=390,844.*--touch-events=enabled' "$t/log" || fail "no phone profile"
grep -q 'http://10.1.2.3:3100/' "$t/log" || fail "browser not pointed at the address"
echo "browser-check tests passed"
