#!/usr/bin/env bash
# deploy/tailscale.yml must give the Tailscale container a healthcheck that asks containerboot's /healthz on the local address,
# with the same timing as deploy/cloudflared.yml, so a failed login shows "unhealthy" instead of "Up" (BOS-2155). Plain text checks: needs no Docker.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
f="${1:-$here/../deploy/tailscale.yml}"
c="${2:-$here/../deploy/cloudflared.yml}"
fail() { echo "FAIL: $*"; exit 1; }

grep -qE '^[[:space:]]+TS_ENABLE_HEALTH_CHECK: "true"' "$f" || fail "TS_ENABLE_HEALTH_CHECK is not true in $f"
addr="$(grep -E '^[[:space:]]+TS_LOCAL_ADDR_PORT:' "$f" | head -1 | sed -E 's/.*:[[:space:]]+//')"
[ -n "$addr" ] || fail "no TS_LOCAL_ADDR_PORT in $f"
case "$addr" in 127.0.0.1:*) ;; *) fail "TS_LOCAL_ADDR_PORT must stay on 127.0.0.1: $addr" ;; esac

grep -qE '^[[:space:]]+healthcheck:' "$f" || fail "the tailscale service has no healthcheck"
test_line="$(grep -E '^[[:space:]]+test:' "$f" | head -1)"
case "$test_line" in *"http://$addr/healthz"*) ;; *) fail "the healthcheck does not probe http://$addr/healthz: $test_line" ;; esac

for key in interval timeout retries start_period; do
  a="$(grep -E "^[[:space:]]+$key:" "$f" | head -1 | sed -E 's/.*:[[:space:]]+//')"
  b="$(grep -E "^[[:space:]]+$key:" "$c" | head -1 | sed -E 's/.*:[[:space:]]+//')"
  [ -n "$a" ] && [ "$a" = "$b" ] || fail "healthcheck $key is '$a', cloudflared uses '$b'"
done

echo "tailscale-healthcheck.test.sh: ok"
