#!/usr/bin/env bash
# BOS-2924: removes Docker build cache older than a set age, so the cache stops growing for ever (a host reached 91 GB).
# Called after a successful image build by deploy.sh, rebuild-live.sh, host-deployer.sh and update-runner.sh. Works on any
# Docker host: it names no path and asks Docker itself. It only touches build cache; images, containers and volumes are
# never touched. Cache used in the last N hours stays, so the next build is still quick.
#
#   BOSSMAN_BUILD_CACHE_KEEP_HOURS   age to keep, in hours (default 168 = 7 days); 0 or "off" switches pruning off
#
# Never fails the caller: a prune is housekeeping, and a deploy must not stop because of it. Always exits 0.
hours="${BOSSMAN_BUILD_CACHE_KEEP_HOURS:-168}"
case "$hours" in
  0 | off | OFF | no) echo "build cache prune: off (BOSSMAN_BUILD_CACHE_KEEP_HOURS=$hours)"; exit 0 ;;
  '' | *[!0-9]*) echo "build cache prune: skipped, BOSSMAN_BUILD_CACHE_KEEP_HOURS must be a whole number of hours (got '$hours')" >&2; exit 0 ;;
esac
command -v docker >/dev/null 2>&1 || { echo "build cache prune: skipped, no docker command"; exit 0; }
if out="$(docker builder prune --force --filter "until=${hours}h" 2>&1)"; then
  echo "build cache prune: removed cache older than ${hours}h. $(printf '%s\n' "$out" | tail -n 1)"
else
  echo "build cache prune: failed (ignored): $(printf '%s\n' "$out" | tail -n 1)" >&2
fi
exit 0
