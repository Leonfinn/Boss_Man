#!/usr/bin/env bash
# shellcheck disable=SC2016  # the fake getent scripts are written literally; $2 expands when the guard runs them
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

# BOS-708: a name re-pointed in DNS to a private address must not open it, unless the entry is trusted.
# A fake getent lets one name resolve to a public address first and a private one after.
mkdir -p "$tmp/bin"
# Public first, then private (two answers), so the guard sees both.
	printf '#!/bin/sh\ncase "$2" in\n  re-point.example.org) printf "%%s\\n" 93.184.216.34 172.18.0.2 ;;\n  trusted.example.org) printf "%%s\\n" 172.18.0.2 ;;\nesac\n' >"$tmp/bin/getent"
chmod +x "$tmp/bin/getent"
printf 're-point.example.org:5432\ntrusted.example.org:8080 private\n10.9.8.7:9000\n' >"$tmp/repoint-allow"
rr="$(PATH="$tmp/bin:$PATH" NETGUARD_ALLOW=10.1.2.3:3100 NETGUARD_ALLOW_FILE="$tmp/repoint-allow" NETGUARD_DNS="" sh netguard.sh --print 2>"$tmp/repoint-err")"
# The public address is opened, the private one it re-pointed to is dropped.
grep -qF 'ip daddr 93.184.216.34 tcp dport 5432 accept' <<<"$rr" || fail "the public address should still open"
if grep -qF 'ip daddr 172.18.0.2 tcp dport 5432 accept' <<<"$rr"; then fail "a re-pointed private address reached the ruleset"; fi
grep -qF 'dropping private address 172.18.0.2 for re-point.example.org:5432' "$tmp/repoint-err" || fail "the dropped private address should be logged"
# A trusted (marked) entry keeps its private address; so does a private IP literal, which can't be re-pointed.
grep -qF 'ip daddr 172.18.0.2 tcp dport 8080 accept' <<<"$rr" || fail "a trusted entry should keep its private address"
grep -qF 'ip daddr 10.9.8.7 tcp dport 9000 accept' <<<"$rr" || fail "a private IP literal should open"
# The server address and the owner's extra setting are trusted for private (server on the stack network, a LAN host they set).
grep -qF 'ip daddr 10.1.2.3 tcp dport 3100 accept' <<<"$rr" || fail "the server address should open even if private"

# The classifier covers every range the table rejects (and leaves a public address alone).
for ip in 0.1.2.3 10.1.2.3 100.64.0.1 127.0.0.1 169.254.1.1 172.16.0.1 172.31.255.255 192.0.0.1 192.168.0.1 198.18.0.1 198.19.255.255; do
  printf 'x.example.org:1\n' >"$tmp/cls-allow"
  printf '#!/bin/sh\n[ "$2" = x.example.org ] && echo "%s"\n' "$ip" >"$tmp/bin/getent"; chmod +x "$tmp/bin/getent"
  cr="$(PATH="$tmp/bin:$PATH" NETGUARD_ALLOW=8.8.8.8:3100 NETGUARD_ALLOW_FILE="$tmp/cls-allow" NETGUARD_DNS="" sh netguard.sh --print 2>/dev/null)"
  if grep -qF "ip daddr $ip " <<<"$cr"; then fail "$ip should be dropped as private"; fi
done
for ip in 8.8.8.8 93.184.216.34 1.1.1.1; do
  printf 'x.example.org:1\n' >"$tmp/cls-allow"
  printf '#!/bin/sh\n[ "$2" = x.example.org ] && echo "%s"\n' "$ip" >"$tmp/bin/getent"; chmod +x "$tmp/bin/getent"
  cr="$(PATH="$tmp/bin:$PATH" NETGUARD_ALLOW=9.9.9.9:3100 NETGUARD_ALLOW_FILE="$tmp/cls-allow" NETGUARD_DNS="" sh netguard.sh --print 2>/dev/null)"
  grep -qF "ip daddr $ip tcp dport 1 accept" <<<"$cr" || fail "$ip is public and should open"
done

# Exit codes: probe fails -> 3 (host can't); probe works but the rules are refused -> 4 (no runner).
printf '#!/bin/sh\nexit 1\n' >"$tmp/bin/nft"; chmod +x "$tmp/bin/nft"
rc=0; PATH="$tmp/bin:$PATH" NETGUARD_ALLOW=10.1.2.3:3100 NETGUARD_ALLOW_FILE=/nonexistent NETGUARD_DNS="" NETGUARD_PROBE_CMD=false sh netguard.sh >/dev/null 2>&1 || rc=$?
[[ $rc == 3 ]] || fail "a failing probe should exit 3, got $rc"
rc=0; PATH="$tmp/bin:$PATH" NETGUARD_ALLOW=10.1.2.3:3100 NETGUARD_ALLOW_FILE=/nonexistent NETGUARD_DNS="" NETGUARD_PROBE_CMD=true sh netguard.sh >/dev/null 2>&1 || rc=$?
[[ $rc == 4 ]] || fail "refused rules with a working probe should exit 4, got $rc"
echo "netguard.test.sh: ok"
