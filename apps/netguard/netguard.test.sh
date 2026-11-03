#!/usr/bin/env bash
# Tests the ruleset netguard.sh prints (no nft or Docker needed).
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
fail() { echo "netguard.test.sh: $1" >&2; exit 1; }
printf '# tool servers\n192.168.68.20:11235\nnot a host:port\nbad:port\n' >"$tmp/allow"
printf 'search lan\nnameserver 127.0.0.11\n# ExtServers: [192.168.68.1 1.1.1.1 fd00::53]\n' >"$tmp/resolv"

rules="$(NETGUARD_ALLOW=10.1.2.3:3100 NETGUARD_EXTRA="172.20.0.9:8080 oops;" NETGUARD_ALLOW_FILE="$tmp/allow" NETGUARD_DNS="192.168.68.1 fd00::53" sh netguard.sh --print 2>"$tmp/err")"
has() { grep -qF -- "$1" <<<"$rules" || fail "missing: $1"; }
has "ip daddr 10.1.2.3 tcp dport 3100 accept"
has "ip daddr 172.20.0.9 tcp dport 8080 accept"
has "ip daddr 192.168.68.20 tcp dport 11235 accept"
has "ip daddr 192.168.68.1 udp dport 53 accept"
has "ip6 daddr fd00::53 tcp dport 53 accept"
grep -q "ignoring 'oops;'" "$tmp/err" || fail "a bad EXTRA entry should be ignored with a message"
if grep -qE 'oops|not a host|bad:port' <<<"$rules"; then fail "a bad entry reached the ruleset"; fi

# A connection opened before the guard loaded must not be kept: no ct-state accept, and every accept comes before the rejects.
if grep -q 'ct state' <<<"$rules"; then fail "no ct state rule is allowed"; fi
first_reject="$(grep -n 'reject with' <<<"$rules" | head -1 | cut -d: -f1)"
last_accept="$(grep -n ' accept$' <<<"$rules" | tail -1 | cut -d: -f1)"
((last_accept < first_reject)) || fail "an accept comes after the first reject"
grep -q 'fc00::/7' <<<"$rules" || fail "IPv6 private range missing"

# Without NETGUARD_DNS the resolvers come from resolv.conf: the loopback one is skipped, the upstream ones kept.
# (The script reads /etc/resolv.conf; only check that the output is still valid when that file lists none we can inject.)
NETGUARD_ALLOW=10.1.2.3:3100 sh netguard.sh --print >/dev/null || fail "--print failed without NETGUARD_DNS"
if NETGUARD_ALLOW='' sh netguard.sh --print 2>/dev/null; then fail "NETGUARD_ALLOW is required"; fi
# Hex-only names (cafe, dead) are looked up, not put in the ruleset as if they were addresses.
r2="$(NETGUARD_ALLOW=10.1.2.3:3100 NETGUARD_EXTRA="dead:1 ::1:2" NETGUARD_ALLOW_FILE=/nonexistent NETGUARD_DNS="" sh netguard.sh --print 2>/dev/null)" || true
if grep -qE 'daddr (dead|cafe) ' <<<"$r2"; then fail "a hex-only name reached the ruleset as an address"; fi

# Exit codes: probe fails -> 3 (host can't); probe works but the rules are refused -> 4 (no runner).
mkdir "$tmp/bin"
printf '#!/bin/sh\nexit 1\n' >"$tmp/bin/nft"; chmod +x "$tmp/bin/nft"
rc=0; PATH="$tmp/bin:$PATH" NETGUARD_ALLOW=10.1.2.3:3100 NETGUARD_ALLOW_FILE=/nonexistent NETGUARD_DNS="" NETGUARD_PROBE_CMD=false sh netguard.sh >/dev/null 2>&1 || rc=$?
[[ $rc == 3 ]] || fail "a failing probe should exit 3, got $rc"
rc=0; PATH="$tmp/bin:$PATH" NETGUARD_ALLOW=10.1.2.3:3100 NETGUARD_ALLOW_FILE=/nonexistent NETGUARD_DNS="" NETGUARD_PROBE_CMD=true sh netguard.sh >/dev/null 2>&1 || rc=$?
[[ $rc == 4 ]] || fail "refused rules with a working probe should exit 4, got $rc"
echo "netguard.test.sh: ok"
