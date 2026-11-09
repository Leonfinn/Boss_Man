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

# IPv4-mapped IPv6 in hex form (::ffff:a00:1 is 10.0.0.1) is treated as private, so a re-pointed name can't sneak it in (BOS-708, Rod's note).
for ip in "::ffff:a00:1" "::ffff:a9fe:a9fe" "::FFFF:C0A8:1"; do
  printf 'x.example.org:1\n' >"$tmp/cls-allow"
  printf '#!/bin/sh\n[ "$2" = x.example.org ] && echo "%s"\n' "$ip" >"$tmp/bin/getent"; chmod +x "$tmp/bin/getent"
  cr="$(PATH="$tmp/bin:$PATH" NETGUARD_ALLOW=9.9.9.9:3100 NETGUARD_ALLOW_FILE="$tmp/cls-allow" NETGUARD_DNS="" sh netguard.sh --print 2>"$tmp/hex-err")"
  if grep -qF "daddr $ip " <<<"$cr"; then fail "$ip is a mapped private address and should be dropped"; fi
done
# A dotted mapped public address (::ffff:8.8.8.8) still opens: it is read as the public IPv4 it is.
printf 'x.example.org:1\n' >"$tmp/cls-allow"
printf '#!/bin/sh\n[ "$2" = x.example.org ] && echo "::ffff:8.8.8.8"\n' >"$tmp/bin/getent"; chmod +x "$tmp/bin/getent"
cr="$(PATH="$tmp/bin:$PATH" NETGUARD_ALLOW=9.9.9.9:3100 NETGUARD_ALLOW_FILE="$tmp/cls-allow" NETGUARD_DNS="" sh netguard.sh --print 2>/dev/null)"
grep -qF "daddr ::ffff:8.8.8.8 tcp dport 1 accept" <<<"$cr" || fail "a dotted mapped public address should open"

# Exit codes: probe fails -> 3 (host can't); probe works but the rules are refused -> 4 (no runner).
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
