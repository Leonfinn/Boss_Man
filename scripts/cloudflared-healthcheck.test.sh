#!/usr/bin/env bash
# deploy/cloudflared.yml must give the tunnel container a healthcheck that asks cloudflared's own metrics address, so a tunnel
# that lost Cloudflare shows "unhealthy" instead of "running" (BOS-2113). Plain text checks: needs no Docker.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
f="${1:-$here/../deploy/cloudflared.yml}"
fail() { echo "FAIL: $*"; exit 1; }

metrics="$(grep -oE -- '"--metrics", "[^"]+"' "$f" | head -1 | sed -E 's/.*"([^"]+)"$/\1/')"
[ -n "$metrics" ] || fail "no --metrics address found in $f"

grep -qE '^[[:space:]]+healthcheck:' "$f" || fail "the cloudflared service has no healthcheck"
test_line="$(grep -E '^[[:space:]]+test:' "$f" | head -1)"
[ -n "$test_line" ] || fail "the healthcheck has no test:"
case "$test_line" in *cloudflared*"$metrics"*ready*) ;; *) fail "the healthcheck does not run 'cloudflared tunnel --metrics $metrics ready': $test_line" ;; esac

echo "cloudflared-healthcheck.test.sh: ok"
