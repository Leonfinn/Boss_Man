#!/bin/sh
# netguard: keeps one runner container off the private networks (IPv4 and IPv6), except the
# Boss Man server. It runs in the runner's own network namespace (the launcher starts it with
# network mode container:<runner>) and owns one nftables table, so the runner itself needs no
# capability and every agent session inside it is covered. Docker's DNS (127.0.0.11) is on
# loopback and stays open; the table never touches Docker's own NAT rules.
#   NETGUARD_ALLOW  host:port of the server, e.g. server:3100 (required)
#   NETGUARD_EXTRA  optional, space-separated CIDRs that stay reachable (default none)
#   NETGUARD_EVERY  seconds between re-resolving the server's address (default 15)
# Usage: netguard.sh            apply, then keep the allowed addresses fresh
#        netguard.sh --print    print the ruleset for the current environment and exit
#        netguard.sh --build-only  exit 0 (lets `docker compose` build the image)
set -eu

TABLE=bossman_netguard
V4_BLOCK="0.0.0.0/8, 10.0.0.0/8, 100.64.0.0/10, 169.254.0.0/16, 172.16.0.0/12, 192.0.0.0/24, 192.168.0.0/16, 198.18.0.0/15"
V6_BLOCK="::ffff:0:0/96, 64:ff9b::/96, 64:ff9b:1::/48, fc00::/7, fe80::/10, 2001:db8::/32"

resolve() {
  # IPv4 and IPv6 addresses of a name, or the address itself; one per line, no duplicates.
  case "$1" in
    *[!0-9a-fA-F:.]*) getent ahosts "$1" | awk '{print $1}' | sort -u ;;
    *) printf '%s\n' "$1" ;;
  esac
}

ruleset() {
  host="${NETGUARD_ALLOW%:*}"
  port="${NETGUARD_ALLOW##*:}"
  allow=""
  for a in $(resolve "$host"); do
    case "$a" in
      *:*) allow="$allow
    ip6 daddr $a tcp dport $port accept" ;;
      *) allow="$allow
    ip daddr $a tcp dport $port accept" ;;
    esac
  done
  extra=""
  for c in ${NETGUARD_EXTRA:-}; do
    case "$c" in
      *:*) extra="$extra
    ip6 daddr $c accept" ;;
      *) extra="$extra
    ip daddr $c accept" ;;
    esac
  done
  # add + delete + add in one file replaces the table atomically and is safe to run twice.
  cat <<RULES
add table inet $TABLE
delete table inet $TABLE
table inet $TABLE {
  chain out {
    type filter hook output priority 0; policy accept;
    oifname "lo" accept
    ct state established,related accept$allow$extra
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
last=""
while :; do
  rules="$(ruleset)"
  if [ "$rules" != "$last" ]; then
    if printf '%s\n' "$rules" | nft -f -; then
      last="$rules"
      echo "netguard: rules applied for $NETGUARD_ALLOW"
    else
      echo "netguard: could not apply the rules" >&2
    fi
  fi
  sleep "${NETGUARD_EVERY:-15}" &
  wait $!
done
