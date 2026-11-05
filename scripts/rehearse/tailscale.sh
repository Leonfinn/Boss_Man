#!/usr/bin/env bash
# Rehearses the Tailscale sidecar (deploy/tailscale.yml, docs/20-https-tailscale.md) on a throwaway Docker machine (DR-024).
# Starts the real sidecar from the repo's own compose files, with no auth key, and checks the outcome:
#   - the container is Up and its RestartCount does not change over REHEARSE_SECONDS (catches a restart loop);
#   - it reports it needs a login (so it is running tailscaled, not crashing);
#   - its state folder is written, and survives `docker compose restart tailscale`.
# It cannot rehearse: the login itself, approving the device, the tailnet's HTTPS/DNS settings, and the
# serve config being applied (all need a real Tailscale account). The summary at the end says so.
# Safe to run twice: its project name is its own and it cleans up on exit. Needs Docker; run it from CI or any Docker host.
# Env: REHEARSE_SECONDS (default 150, longer than the 2-minute restart seen in the field), REHEARSE_PROJECT.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../.."

secs="${REHEARSE_SECONDS:-150}"
case "$secs" in '' | *[!0-9]*) echo "REHEARSE_SECONDS must be a whole number" >&2; exit 64 ;; esac
project="${REHEARSE_PROJECT:-bossman-rehearse-ts}"
case "$project" in *[!a-z0-9_-]* | '') echo "REHEARSE_PROJECT must be lowercase letters, digits, - or _" >&2; exit 64 ;; esac
command -v docker >/dev/null || { echo "docker is required" >&2; exit 69; }

data="$(mktemp -d)"
made_secrets=()
for f in secrets/master.key secrets/runner-app-co.token; do
  if [ ! -e "$f" ]; then mkdir -p secrets; : >"$f"; made_secrets+=("$f"); fi
done
export POSTGRES_PASSWORD=rehearse BOSSMAN_DATA="$data" TS_AUTHKEY=
dc() { docker compose -p "$project" -f docker-compose.yml -f deploy/tailscale.yml "$@"; }

cleanup() {
  dc down -v --remove-orphans >/dev/null 2>&1 || true
  # State is written by the container's user, so remove it through a container, then the empty folder.
  docker run --rm -v "$data:/d" --entrypoint sh "$(dc config --images 2>/dev/null | grep tailscale/tailscale | head -1)" -c 'rm -rf /d/* /d/.[!.]* 2>/dev/null' >/dev/null 2>&1 || true
  rm -rf "$data" 2>/dev/null || true
  for f in "${made_secrets[@]}"; do rm -f "$f"; done
}
trap cleanup EXIT

fail() { echo "FAIL: $*" >&2; dc logs --no-color tailscale 2>&1 | tail -30 >&2 || true; exit 1; }
cid() { dc ps -q tailscale; }
restarts() { docker inspect -f '{{.RestartCount}}' "$(cid)"; }
running() { docker inspect -f '{{.State.Running}}' "$(cid)"; }

echo "== start the sidecar alone (no key, so it waits for a login)"
dc config -q
dc up -d --no-deps tailscale
sleep 10
[ "$(running)" = true ] || fail "sidecar is not running after start"
first="$(restarts)"
started="$(docker inspect -f '{{.State.StartedAt}}' "$(cid)")"

echo "== watch for ${secs}s: must stay up, no restarts"
sleep "$secs"
[ "$(running)" = true ] || fail "sidecar stopped during the watch"
[ "$(restarts)" = "$first" ] || fail "RestartCount went from $first to $(restarts): restart loop"
[ "$(docker inspect -f '{{.State.StartedAt}}' "$(cid)")" = "$started" ] || fail "container was started again during the watch"

echo "== it says it needs a login (running, not crashing)"
dc logs --no-color tailscale 2>&1 | grep -qiE "NeedsLogin|authkey|log in|login" || fail "no login prompt in the logs"

echo "== state is written and survives a restart"
dc exec -T tailscale sh -c 'ls /var/lib/tailscale | grep -q .' || fail "state folder is empty"
before="$(dc exec -T tailscale sh -c 'ls /var/lib/tailscale' | sort | tr '\n' ' ')"
dc restart tailscale >/dev/null
sleep 10
[ "$(running)" = true ] || fail "sidecar did not come back after restart"
after="$(dc exec -T tailscale sh -c 'ls /var/lib/tailscale' | sort | tr '\n' ' ')"
[ "$before" = "$after" ] || fail "state changed across restart: [$before] -> [$after]"

cat <<'SUMMARY'
PASS: tailscale sidecar rehearsal
Rehearsed: starts from the repo's compose files, stays up with no restarts, waits for login, keeps its state across a restart.
Not rehearsed (needs a real Tailscale account): the login with a key, approving the device, HTTPS and DNS in the tailnet,
the serve config being applied, and the login surviving a restart. Mark these "first time on a real machine".
SUMMARY
