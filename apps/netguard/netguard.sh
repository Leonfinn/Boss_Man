#!/bin/sh
# netguard: keeps one runner container off the private networks (IPv4 and IPv6), except the
# Boss Man server, the company's tool servers and the DNS resolvers. It runs in the runner's own
# network namespace (the launcher starts it with network mode container:<runner>) and owns one
# nftables table, so the runner itself needs no capability and every agent session inside it is
# covered. Docker's DNS (127.0.0.11) is on loopback and stays open; the table never touches
# Docker's own NAT rules.
#   NETGUARD_ALLOW       host:port of the server, e.g. server:3100 (required)
#   NETGUARD_EXTRA       optional, space-separated host:port entries that stay reachable (owner setting)
#   NETGUARD_ALLOW_FILE  optional file with one host:port per line, read again every cycle
#                        (the company's tool servers; default /etc/netguard/allow)
#   NETGUARD_DNS         optional, space-separated resolver addresses (default: read from /etc/resolv.conf)
#   NETGUARD_EVERY       seconds between re-resolving the allowed addresses (default 15); a USR1 does it at once
# It loads a "hold" table first (private networks blocked, no lookups), so it is healthy even while the
# launcher keeps the runner off its network; the full table (with the allowed addresses) replaces it.
# Exit code 3 means nf_tables itself doesn't work here (a probe table can't be made): the
# launcher reads that as "network guard unavailable on this host". Any other failure of the first
# apply (a bad ruleset) exits 4, which the launcher treats as an error: no guard, no runner.
# Usage: netguard.sh            apply, then keep the allowed addresses fresh
#        netguard.sh --print    print the ruleset for the current environment and exit
#        netguard.sh --print-hold  print the hold table and exit
#        netguard.sh --build-only  exit 0 (lets `docker compose build` the image)
set -eu

TABLE=bossman_netguard
V4_BLOCK="0.0.0.0/8, 10.0.0.0/8, 100.64.0.0/10, 169.254.0.0/16, 172.16.0.0/12, 192.0.0.0/24, 192.168.0.0/16, 198.18.0.0/15"
V6_BLOCK="::ffff:0:0/96, 64:ff9b::/96, 64:ff9b:1::/48, fc00::/7, fe80::/10, 2001:db8::/32"
ALLOW_FILE="${NETGUARD_ALLOW_FILE:-/etc/netguard/allow}"

resolve() {
  # IPv4 and IPv6 addresses of a name, or the address itself; one per line, no duplicates.
  case "$1" in
    *[!0-9a-fA-F:.]*) getent ahosts "$1" | awk '{print $1}' | sort -u ;;
    # Only a real IP literal goes in as is: dotted digits (IPv4) or something with a colon (IPv6).
    # Hex-only names such as cafe or dead are names, so they are looked up.
    *:*) printf '%s\n' "$1" ;;
    *[!0-9.]*) getent ahosts "$1" | awk '{print $1}' | sort -u ;;
    *) printf '%s\n' "$1" ;;
  esac
}

# Is an address on a private, loopback, link-local or CGNAT range (or an IPv6 one)? 1 means yes.
# The same ranges the table rejects; an allow entry is dropped for these unless the owner trusted
# it (BOS-708), so a name re-pointed in DNS can't open a way onto the stack's own network.
# No bitwise ops: awk here may be mawk, which has no and(), so octets are compared arithmetically.
is_private() {
  awk -v a="$1" 'BEGIN {
    # CIDR list as "a.b.c.d/bits"; IPv4-mapped IPv6 is cut down to plain IPv4 first.
    cidr = "0.0.0.0/8 10.0.0.0/8 100.64.0.0/10 127.0.0.0/8 169.254.0.0/16 172.16.0.0/12 192.0.0.0/24 192.168.0.0/16 198.18.0.0/15"
    a = tolower(a)
    if (a ~ /^::ffff:/) {
      # IPv4-mapped IPv6 as dotted IPv4 ("::ffff:10.0.0.1"), or in hex ("::ffff:a00:1"), or fully expanded ("0:0:0:0:0:ffff:..."). The
      # dotted form is cut down to plain IPv4; any other mapped form cannot be read as an IPv4 address here, so treat it as
      # private (fail closed) rather than let a re-pointed name reach the stack network in hex (BOS-708).
      rest = substr(a, 8)
      if (rest ~ /^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$/) a = rest
      else { print 1; exit }
    }
    if (a ~ /^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$/) {
      n = split(a, o, "."); if (n != 4) { print 0; exit }
      for (i = 1; i <= 4; i++) if (o[i] !~ /^[0-9]+$/ || o[i] + 0 > 255) { print 0; exit }
      m = split(cidr, cs, " "); hit = 0
      for (i = 1; i <= m && !hit; i++) {
        split(cs[i], p, "/"); split(p[1], q, ".")
        bits = p[2] + 0; left = bits; ok = 1
        for (j = 1; j <= 4 && ok; j++) {
          oct = q[j] + 0
          if (left >= 8) { if (o[j] + 0 != oct) ok = 0; left -= 8 }
          else if (left > 0) {
            div = 2 ^ (8 - left)
            if (int(o[j] / div) != int(oct / div)) ok = 0
            left = 0
          }
        }
        if (ok) hit = 1
      }
      print hit; exit
    }
    if (a == "::" || a == "::1" || a ~ /^fe[89ab]/ || a ~ /^f[cd]/ || a ~ /^64:ff9b:/ || a ~ /^2001:db8:/) print 1
    else print 0
  }'
}

# Accept rules for one host:port, one per address it resolves to. Anything that isn't host:port is skipped.
# $2 is "private" when the owner meant this entry to reach a private address: then its private
# addresses are kept; otherwise they are dropped and logged (BOS-708).
allow_rules() {
  case "$1" in
    *[!A-Za-z0-9.:-]* | "" | :* | *:) echo "netguard: ignoring '$1'" >&2; return 0 ;;
  esac
  host="${1%:*}"
  port="${1##*:}"
  case "$port" in *[!0-9]* | "") echo "netguard: ignoring '$1'" >&2; return 0 ;; esac
  trust="${2:-}"
  # A private IP literal can't be re-pointed in DNS, so its address was meant as written (BOS-708).
  case "$host" in
    *:*) ;;
    *[!0-9.]*) ;;
    *) if [ "$(is_private "$host")" = 1 ]; then trust=private; fi ;;
  esac
  for a in $(resolve "$host"); do
    if [ "$trust" != private ] && [ "$(is_private "$a")" = 1 ]; then
      echo "netguard: dropping private address $a for $1 (not allowed on a private address)" >&2
      continue
    fi
    case "$a" in
      *:*) printf '    ip6 daddr %s tcp dport %s accept\n' "$a" "$port" ;;
      *) printf '    ip daddr %s tcp dport %s accept\n' "$a" "$port" ;;
    esac
  done
}

# Upstream resolvers: Docker's embedded DNS (127.0.0.11) forwards from inside this namespace, so
# a private resolver (a router, a Pi-hole) must stay reachable on port 53.
dns_servers() {
  if [ -n "${NETGUARD_DNS:-}" ]; then printf '%s\n' "$NETGUARD_DNS" | tr ' ' '\n'; return 0; fi
  [ -r /etc/resolv.conf ] || return 0
  {
    awk '$1 == "nameserver" {print $2}' /etc/resolv.conf
    sed -n 's/^# *ExtServers: *\[\(.*\)\].*/\1/p' /etc/resolv.conf | tr ' ' '\n'
  } | grep -E '^[0-9a-fA-F:.]+$' | grep -Ev '^127\.|^::1$' | sort -u || true
}

ruleset() {
  # "hold": the same table with no accepts but loopback, and no lookups (BOS-576). It loads before the runner has
  # a network, so the launcher can wait for it, then connect the network and wake this loop for the full rules.
  if [ "${1:-}" = hold ]; then allow=""; dns=""; rules_text; return; fi
  # The server's own address and the owner's extra setting are trusted to be private addresses they meant
  # (the server lives on the stack network; a LAN host is the owner's own choice).
  allow="$(allow_rules "$NETGUARD_ALLOW" private)"
  for e in ${NETGUARD_EXTRA:-}; do allow="$allow
$(allow_rules "$e" private)"; done
  if [ -r "$ALLOW_FILE" ]; then
    while read -r e mark _; do
      case "$e" in "" | \#*) continue ;; esac
      allow="$allow
$(allow_rules "$e" "$mark")"
    done <"$ALLOW_FILE"
  fi
  dns=""
  for d in $(dns_servers); do
    case "$d" in
      *:*) dns="$dns
    ip6 daddr $d udp dport 53 accept
    ip6 daddr $d tcp dport 53 accept" ;;
      *) dns="$dns
    ip daddr $d udp dport 53 accept
    ip daddr $d tcp dport 53 accept" ;;
    esac
  done
  rules_text
}

# The table for the current $allow and $dns lines.
rules_text() {
  # add + delete + add in one file replaces the table atomically and is safe to run twice.
  # No "established, accept" line: a connection opened before the guard loaded (a runner restart
  # leaves a short gap) must be cut off by the rejects below, not kept alive.
  cat <<RULES
add table inet $TABLE
delete table inet $TABLE
table inet $TABLE {
  chain out {
    type filter hook output priority 0; policy accept;
    oifname "lo" accept
$allow$dns
    ip daddr { $V4_BLOCK } reject with icmp type admin-prohibited
    ip6 daddr { $V6_BLOCK } reject with icmpv6 type admin-prohibited
  }
}
RULES
}

case "${1:-}" in
  --build-only) exit 0 ;;
  --print) : "${NETGUARD_ALLOW:?set NETGUARD_ALLOW to host:port}"; ruleset; exit 0 ;;
  --print-hold) ruleset hold; exit 0 ;;
esac
: "${NETGUARD_ALLOW:?set NETGUARD_ALLOW to host:port}"

trap 'exit 0' TERM INT
# USR1 (sent by the launcher once it has connected the runner's network): look the names up again now, not in 15 s.
wake=0
sleeper=""
trap 'wake=1; [ -z "$sleeper" ] || kill "$sleeper" 2>/dev/null || true' USR1
# Does nftables work here at all? Only a failing probe means "this host can't"; NETGUARD_PROBE_CMD is for tests.
if ! sh -c "${NETGUARD_PROBE_CMD:-nft add table inet bossman_probe && nft delete table inet bossman_probe}" >/dev/null 2>&1; then
  echo "netguard: nf_tables isn't available here; stopping" >&2
  exit 3
fi
# The hold table first (BOS-576): it needs no lookups, so the guard is healthy before the runner has a network.
if ! ruleset hold | nft -f -; then
  echo "netguard: nftables works but the rules were refused; stopping" >&2
  exit 4
fi
echo "netguard: private networks blocked; waiting for the full rules"
last=""
while :; do
  wake=0
  rules="$(ruleset)"
  if [ "$rules" != "$last" ]; then
    if printf '%s\n' "$rules" | nft -f -; then
      last="$rules"
      echo "netguard: rules applied for $NETGUARD_ALLOW"
    elif [ -z "$last" ]; then
      # The full rules never loaded. The hold table stays (nothing private is reachable); stop, so the launcher sees it.
      echo "netguard: nftables works but the rules were refused; stopping" >&2
      exit 4
    else
      echo "netguard: could not apply the new rules; keeping the old ones" >&2
    fi
  fi
  sleep "${NETGUARD_EVERY:-15}" &
  sleeper=$!
  # A USR1 that came while the names were looked up skips the wait; one during the wait ends it (the trap kills the sleep).
  [ "$wake" = 1 ] || wait "$sleeper" || true
  kill "$sleeper" 2>/dev/null || true
  sleeper=""
done
