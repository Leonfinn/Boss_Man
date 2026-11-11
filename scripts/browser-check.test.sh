#!/usr/bin/env bash
# Checks browser-check.sh with a stub in place of Chromium (BOSSMAN_CHROMIUM); needs no browser or Docker.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
srv=""; t="$(mktemp -d)"; trap '[ -z "$srv" ] || kill "$srv" 2>/dev/null || true; rm -rf "$t"' EXIT
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

# Demo with the real browser (skipped without one or node): a clipboard-dependent control sees the clipboard
# API on localhost but not on the runner's own address, which is why checks must not run on localhost.
chrome=$(command -v chromium chromium-browser google-chrome 2>/dev/null | head -n 1 || true)
if [ -n "$chrome" ] && command -v node >/dev/null && addr=$("$here/browser-check.sh" --print-url --port 1 2>/dev/null); then
  node -e '
    const s = require("http").createServer((q, r) => r.end("<script>document.title = String(typeof navigator.clipboard)</script>"));
    s.listen(0, "0.0.0.0", () => console.log(s.address().port));
    setTimeout(() => process.exit(0), 300000);' >"$t/port" &
  srv=$!
  for _ in $(seq 50); do [ -s "$t/port" ] && break; sleep 0.1; done
  port=$(cat "$t/port"); host=${addr#http://}; host=${host%:1/}
  # A cold Chrome can take over a minute to start on a shared CI runner (it outlived the server's old 60 s exit there,
  # leaving an empty title): skip its background networking and first-run work, and give each load its own bound.
  title() { timeout 120 "$chrome" --headless --no-sandbox --disable-gpu --no-first-run --no-default-browser-check --disable-background-networking --disable-component-update --virtual-time-budget=3000 --dump-dom "$1" 2>"$t/chrome.err" | sed -n 's/.*<title>\(.*\)<\/title>.*/\1/p' || true; }
  # Chrome's stderr is kept (BOS-1087): an empty title used to say nothing about why (e.g. "Socket path too long" under a long TMPDIR).
  got=$(title "http://127.0.0.1:$port/"); [ "$got" = "object" ] || fail "demo: clipboard missing on localhost (title '${got}', TMPDIR=${TMPDIR:-unset}); Chrome said: $(tail -c 1500 "$t/chrome.err")"
  got=$(title "http://$host:$port/"); [ "$got" = "undefined" ] || fail "demo: clipboard present on $host (title '${got}'); Chrome said: $(tail -c 1500 "$t/chrome.err")"
  kill "$srv" 2>/dev/null || true
  echo "demo: clipboard object on localhost, undefined on $host"
fi
