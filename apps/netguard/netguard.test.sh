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

# BOS-576: the hold table blocks every private range and accepts only loopback; it needs no NETGUARD_ALLOW and no lookups.
hold="$(NETGUARD_ALLOW='' sh netguard.sh --print-hold)"
[[ "$(grep -c ' accept$' <<<"$hold")" == 1 ]] || fail "the hold table should accept loopback only"
grep -q 'oifname "lo" accept' <<<"$hold" || fail "the hold table should accept loopback"
grep -q '10.0.0.0/8' <<<"$hold" || fail "the hold table should block the private IPv4 ranges"
grep -q 'fc00::/7' <<<"$hold" || fail "the hold table should block the private IPv6 ranges"

# The hold table loads first, then the full rules; a USR1 makes it look again at once instead of after NETGUARD_EVERY.
printf '#!/bin/sh\n{ cat; echo "--- end of apply"; } >>"%s/applied"\n' "$tmp" >"$tmp/bin/nft"
printf '10.9.9.9:1\n' >"$tmp/allow2"
PATH="$tmp/bin:$PATH" NETGUARD_ALLOW=10.1.2.3:3100 NETGUARD_ALLOW_FILE="$tmp/allow2" NETGUARD_DNS="" NETGUARD_PROBE_CMD=true NETGUARD_EVERY=300 sh netguard.sh >/dev/null 2>&1 &
guard=$!
applied() { grep -c '^--- end of apply' "$tmp/applied" 2>/dev/null || true; }
for _ in $(seq 50); do [[ "$(applied)" == 2 ]] && break; sleep 0.1; done
[[ "$(applied)" == 2 ]] || { kill "$guard"; fail "expected the hold table and then the full rules, got $(applied) applies"; }
first="$(sed '/^--- end of apply/q' "$tmp/applied")"
if grep -q '10.1.2.3' <<<"$first" || ! grep -q 'oifname "lo" accept' <<<"$first"; then kill "$guard"; fail "the first table applied should be the hold table"; fi
printf '10.9.9.9:1\n10.8.8.8:2\n' >"$tmp/allow2"
kill -USR1 "$guard"
for _ in $(seq 50); do [[ "$(applied)" == 3 ]] && break; sleep 0.1; done
[[ "$(applied)" == 3 ]] || { kill "$guard"; fail "a USR1 should make the guard apply the changed rules at once"; }
grep -q 'ip daddr 10.8.8.8 tcp dport 2 accept' "$tmp/applied" || { kill "$guard"; fail "the new allow entry is missing after USR1"; }
kill "$guard"
wait "$guard" || true
echo "netguard.test.sh: ok"
