#!/usr/bin/env bash
# Headless-Chromium check of a running app the way the owner meets it: over plain http on this machine's own
# non-loopback address (never localhost, where browsers allow things like the clipboard API that they block
# on a LAN or Tailscale address), at a desktop size and at a phone profile (touch, small viewport).
# The address is found at run time; BOSSMAN_CHECK_HOST overrides it. Nothing here is host-specific.
#
#   scripts/browser-check.sh [--port 3100] [--path /] [--out DIR] [--print-url]
#
# Writes desktop.png, phone.png, desktop.html, phone.html (the rendered DOM) to --out and prints the URL.
# Seeing a page is not enough: click, type and copy the control with your browser tool (agent-browser)
# against the printed URL, at both sizes. --print-url only prints the URL, for that.
set -euo pipefail

port=3100 path=/ out="" print_url=0
while [ $# -gt 0 ]; do
  case $1 in
    --port) port=${2:?--port needs a value}; shift 2 ;;
    --path) path=${2:?--path needs a value}; shift 2 ;;
    --out) out=${2:?--out needs a value}; shift 2 ;;
    --print-url) print_url=1; shift ;;
    *) echo "usage: $0 [--port N] [--path /p] [--out DIR] [--print-url]" >&2; exit 2 ;;
  esac
done
case $path in /*) ;; *) path=/$path ;; esac

# First address that is not loopback or link-local: hostname -I, then the source address of the default route.
discover_host() {
  local a
  for a in $(hostname -I 2>/dev/null || true) $(ip -4 route get 1.1.1.1 2>/dev/null | sed -n 's/.* src \([0-9.]*\).*/\1/p'); do
    case $a in 127.* | 169.254.* | ::1 | fe80:* | "") ;; *) echo "$a"; return 0 ;; esac
  done
  return 1
}

host=${BOSSMAN_CHECK_HOST:-}
[ -n "$host" ] || host=$(discover_host) || { echo "no non-loopback address found; set BOSSMAN_CHECK_HOST" >&2; exit 1; }
case $host in
  localhost | 127.* | ::1 | "[::1]") echo "refusing loopback host '$host': it hides clipboard and other plain-http limits" >&2; exit 1 ;;
esac
case $host in *:*) [[ $host == \[* ]] || host="[$host]" ;; esac
url="http://$host:$port$path"
echo "$url"
[ "$print_url" -eq 0 ] || exit 0

chromium=${BOSSMAN_CHROMIUM:-$(command -v chromium chromium-browser google-chrome 2>/dev/null | head -n 1 || true)}
[ -n "$chromium" ] || { echo "no Chromium found; set BOSSMAN_CHROMIUM" >&2; exit 1; }
if [ -z "$out" ]; then out=$(mktemp -d); fi
mkdir -p "$out"

phone_ua="Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Mobile Safari/537.36"
common=(--headless --no-sandbox --disable-gpu --hide-scrollbars --virtual-time-budget=8000)

shoot() { # name, then extra flags
  local name=$1; shift
  "$chromium" "${common[@]}" "$@" --screenshot="$out/$name.png" "$url" >/dev/null 2>&1 || { echo "FAIL: $name screenshot" >&2; return 1; }
  "$chromium" "${common[@]}" "$@" --dump-dom "$url" >"$out/$name.html" 2>/dev/null || { echo "FAIL: $name dom" >&2; return 1; }
  echo "ok $name: $out/$name.png"
}
shoot desktop --window-size=1280,800
shoot phone --window-size=390,844 --touch-events=enabled --use-mobile-user-agent --user-agent="$phone_ua"
