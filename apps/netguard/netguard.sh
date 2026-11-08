#!/bin/sh
# netguard: keeps one runner container off the private networks (IPv4 and IPv6), except the
# Boss Man server, the company's tool servers and the DNS resolvers. It runs in the runner's own
# network namespace (the launcher starts it with network mode container:<runner>) and owns one
# nftables table, so the runner itself needs no capability and every agent session inside it is
# covered. Docker's DNS (127.0.0.11) is on loopback and stays open; the table never touches
# Docker's own NAT rules. An allow entry whose name now resolves to a private address is dropped
# unless it is trusted for private, so a re-pointed name can't open the stack network (BOS-708).
#   NETGUARD_ALLOW       host:port of the server, e.g. server:3100 (required)
#   NETGUARD_EXTRA       optional, space-separated host:port entries that stay reachable (owner setting)
#   NETGUARD_ALLOW_FILE  optional file with one host:port per line, read again every cycle
#                        (the company's tool servers; default /etc/netguard/allow). A line may end in
#                        "private" when the owner allowed that entry a private address (BOS-708).
#   NETGUARD_DNS         optional, space-separated resolver addresses (default: read from /etc/resolv.conf)
#   NETGUARD_EVERY       seconds between re-resolving the allowed addresses (default 15)
# Exit code 3 means nf_tables itself doesn't work here (a probe table can't be made): the
# launcher reads that as "network guard unavailable on this host". Any other failure of the first
# apply (a bad ruleset) exits 4, which the launcher treats as an error: no guard, no runner.
# Usage: netguard.sh            apply, then keep the allowed addresses fresh
#        netguard.sh --print    print the ruleset for the current environment and exit
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

# Accept rules for one host:port, one per address it resolves to. Anything that isn't host:port is skipped.
allow_rules() {
  case "$1" in
    *[!A-Za-z0-9.:-]* | "" | :* | *:) echo "netguard: ignoring '$1'" >&2; return 0 ;;
  esac
  host="${1%:*}"
  port="${1##*:}"
  case "$port" in *[!0-9]* | "") echo "netguard: ignoring '$1'" >&2; return 0 ;; esac
  for a in $(resolve "$host"); do
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
  allow="$(allow_rules "$NETGUARD_ALLOW")"
  for e in ${NETGUARD_EXTRA:-}; do allow="$allow
$(allow_rules "$e")"; done
  if [ -r "$ALLOW_FILE" ]; then
    while read -r e _; do
      case "$e" in "" | \#*) continue ;; esac
      allow="$allow
$(allow_rules "$e")"
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
esac
: "${NETGUARD_ALLOW:?set NETGUARD_ALLOW to host:port}"

trap 'exit 0' TERM INT
# Does nftables work here at all? Only a failing probe means "this host can't"; NETGUARD_PROBE_CMD is for tests.
if ! sh -c "${NETGUARD_PROBE_CMD:-nft add table inet bossman_probe && nft delete table inet bossman_probe}" >/dev/null 2>&1; then
  echo "netguard: nf_tables isn't available here; stopping" >&2
  exit 3
fi
last=""
while :; do
  rules="$(ruleset)"
  if [ "$rules" != "$last" ]; then
    if printf '%s\n' "$rules" | nft -f -; then
      last="$rules"
      echo "netguard: rules applied for $NETGUARD_ALLOW"
    elif [ -z "$last" ]; then
      # Never applied: the runner is not guarded. Stop, so the launcher sees it.
      echo "netguard: nftables works but the rules were refused; stopping" >&2
      exit 4
    else
      echo "netguard: could not apply the new rules; keeping the old ones" >&2
    fi
  fi
  sleep "${NETGUARD_EVERY:-15}" &
  wait $!
done
