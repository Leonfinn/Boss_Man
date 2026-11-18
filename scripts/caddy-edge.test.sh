#!/usr/bin/env bash
# Spoofed-header test through the real deploy/caddy/Caddyfile (no Docker; needs a Caddy binary):
#   CADDY=/path/to/caddy scripts/caddy-edge.test.sh
# CI runs it with the binary taken out of the pinned caddy image. Without CADDY it says SKIP and passes.
# Loopback source addresses stand in for the two kinds of caller: 127.0.0.2 is "the Tailscale container"
# (the one address Caddy is told to believe), 127.0.0.3 is anybody else (a LAN device, a runner).
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
fail() { echo "FAIL: $*" >&2; exit 1; }
if [[ -z ${CADDY:-} ]]; then echo "caddy-edge.test.sh: SKIP (set CADDY=<caddy binary> to run it)"; exit 0; fi
[[ -x $CADDY ]] || fail "CADDY=$CADDY is not an executable"
command -v node >/dev/null || { echo "caddy-edge.test.sh: SKIP (needs node)"; exit 0; }

T="$(mktemp -d)"; pids=()
cleanup() { for p in "${pids[@]}"; do kill "$p" 2>/dev/null || true; done; rm -rf "$T"; }
trap cleanup EXIT

ui=38100 portal=38101 admin=38119 b_ui=38200 b_portal=38201
mkdir -p "$T/caddy" "$T/active"
# The real Caddyfile on test ports.
sed -e "s/:3100/:$ui/g" -e "s/:3101/:$portal/g" -e "s/localhost:2019/localhost:$admin/" -e "s/import active 3100/import active $b_ui/" -e "s/import active 3101/import active $b_portal/" "$here/deploy/caddy/Caddyfile" >"$T/caddy/Caddyfile"
# The include in the form scripts/host-deployer.sh writes for blue (write_include), with the colour's name replaced by loopback.
cat >"$T/active/active.caddy" <<'INC'
(active) {
	reverse_proxy 127.0.0.1:{args[0]} {
		header_up X-Forwarded-For {client_ip}
		health_uri {args[1]}
		health_interval 1s
		health_timeout 1s
	}
}
INC
sed -i "s#/etc/caddy-active#$T/active#" "$T/caddy/Caddyfile"

# A backend that answers with the forwarding headers it received.
cat >"$T/echo.mjs" <<'JS'
import http from "node:http";
for (const p of process.argv.slice(2)) http.createServer((q, r) => {
  r.setHeader("content-type", "application/json");
  r.end(JSON.stringify({ xff: q.headers["x-forwarded-for"] ?? null, xfp: q.headers["x-forwarded-proto"] ?? null }));
}).listen(Number(p), "127.0.0.1");
JS
node "$T/echo.mjs" "$b_ui" "$b_portal" & pids+=($!)
BOSSMAN_CADDY_TRUSTED_PROXIES="127.0.0.2/32" "$CADDY" run --config "$T/caddy/Caddyfile" --adapter caddyfile >"$T/caddy.log" 2>&1 & pids+=($!)

# Caddy marks a backend down until its first health check passes: wait until it proxies.
# The event is "a request through Caddy reaches the backend", polled until a deadline (a fixed 20 s was too short on a
# slow GitHub runner, BOS-1726). It gives up at once if Caddy has exited, and on the deadline prints Caddy's log.
# The deadline only decides how long a broken setup takes to fail; a working one returns on the first answer.
deadline=$((SECONDS + 90))
until curl -fs -o /dev/null --interface 127.0.0.3 "http://127.0.0.1:$ui/api/ready" 2>/dev/null; do
  kill -0 "${pids[1]}" 2>/dev/null || { cat "$T/caddy.log"; fail "Caddy exited before it proxied to the backend"; }
  ((SECONDS < deadline)) || { cat "$T/caddy.log"; fail "Caddy never proxied to the backend (waited 90 s)"; }
  sleep 0.2
done

# seen <source-ip> <port> <xff|-> <xfp|->: prints "xff|xfp" as the backend received them.
seen() {
  local args=(-fs --interface "$1")
  [[ $3 == - ]] || args+=(-H "X-Forwarded-For: $3")
  [[ $4 == - ]] || args+=(-H "X-Forwarded-Proto: $4")
  curl "${args[@]}" "http://127.0.0.1:$2/api/ready" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);console.log(j.xff+"|"+j.xfp)})'
}
expect() { [[ $1 == "$2" ]] || fail "$3: got '$1', wanted '$2'"; }

expect "$(seen 127.0.0.3 $ui "6.6.6.6" https)" "127.0.0.3|http" "a LAN caller spoofing both headers"
expect "$(seen 127.0.0.3 $ui - -)" "127.0.0.3|http" "a LAN caller sending none"
expect "$(seen 127.0.0.2 $ui "100.64.0.9" https)" "100.64.0.9|https" "the trusted hop reporting a tailnet client"
expect "$(seen 127.0.0.2 $ui "6.6.6.6, 100.64.0.9" https)" "100.64.0.9|https" "a client prepending a fake address behind the trusted hop"
expect "$(seen 127.0.0.2 $portal "100.64.0.9" https)" "127.0.0.2|http" "the portal listener must not believe even the trusted hop"
expect "$(seen 127.0.0.3 $portal "6.6.6.6" https)" "127.0.0.3|http" "the portal listener, spoofed"
echo "caddy-edge.test.sh: all checks passed"
