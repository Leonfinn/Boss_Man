#!/usr/bin/env bash
# Checks the compose files and the CI workflows without a Docker daemon (BOS-1036): `docker compose config -q` only reads
# and validates the files, and actionlint reads the workflows. Neither needs a socket, and nothing is ever started.
# Used by scripts/check-quick.sh; run it by hand with no arguments to check everything.
#   scripts/check-compose.sh            every compose file set below, and every workflow in .github/workflows
# Exit 0 = all passed; 1 = a file is invalid (the tool's message names the file and line, and the set that failed);
# 3 = the tools are not installed (an older runner image; "Build and update runners" installs them).
# Each set is what a host really loads (docs/09-self-deploy.md, docs/06-install-truenas.md, scripts/deploy-staging.sh),
# with every profile on, so a service behind a profile is checked too. Add a line to `sets` when a new overlay appears.
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.." || exit 1

if ! command -v docker >/dev/null 2>&1 || ! docker compose version >/dev/null 2>&1; then echo "check-compose: docker CLI or compose plugin not installed"; exit 3; fi
command -v actionlint >/dev/null 2>&1 || { echo "check-compose: actionlint not installed"; exit 3; }

# Placeholders for the values the files require (${VAR:?...}), only where the caller has not set one. They are not secrets
# and are never used: config -q renders the files and starts nothing.
for v in POSTGRES_PASSWORD NTFY_BASE_URL BOSSMAN_TOOLSERVER_IMAGE PENPOT_PUBLIC_URI PENPOT_SECRET_KEY PENPOT_DB_PASSWORD CLOUDFLARE_TUNNEL_TOKEN; do
  [ -n "${!v:-}" ] || export "$v=check-compose-placeholder"
done
# Folders must look like absolute paths (a bind mount) and the Penpot bind must be an address, or compose reads them as volume names.
for v in BOSSMAN_DATA BOSSMAN_DEPLOYER; do [ -n "${!v:-}" ] || export "$v=/check-compose-placeholder"; done
# The image install (BOS-974) names images by registry and digest, which must look like real ones.
[ -n "${BOSSMAN_REGISTRY:-}" ] || export BOSSMAN_REGISTRY=registry.invalid/check-compose
for v in BOSSMAN_SERVER_DIGEST BOSSMAN_LAUNCHER_DIGEST BOSSMAN_NETGUARD_DIGEST BOSSMAN_RUNNER_DIGEST BOSSMAN_UPDATER_DIGEST; do
  [ -n "${!v:-}" ] || export "$v=sha256:0000000000000000000000000000000000000000000000000000000000000000"
done
# The updater (BOS-1227) also names the repository that signed the release.
[ -n "${BOSSMAN_UPDATER_REPO:-}" ] || export BOSSMAN_UPDATER_REPO=example/check-compose
[ -n "${PENPOT_BIND:-}" ] || export PENPOT_BIND=127.0.0.1
# A stray COMPOSE_FILE or COMPOSE_PROFILES from the caller would change what -f means.
unset COMPOSE_FILE COMPOSE_PROFILES COMPOSE_PROJECT_NAME

d=docker-compose.yml
sets=(
  "$d"
  "$d deploy/truenas.yml"
  "$d deploy/truenas.yml deploy/truenas-deployer.yml"
  "$d deploy/truenas.yml deploy/truenas-bluegreen.yml"
  "$d deploy/tailscale.yml"
  "$d deploy/truenas.yml deploy/tailscale.yml deploy/truenas-bluegreen.yml deploy/tailscale-bluegreen.yml"
  "$d deploy/cloudflared.yml"
  "$d deploy/truenas.yml deploy/truenas-bluegreen.yml deploy/cloudflared.yml"
  "$d deploy/staging.yml"
  "$d deploy/tool-servers.yml"
  "deploy/ntfy.yml"
  "deploy/ntfy.yml deploy/ntfy-bluegreen.yml"
  "deploy/penpot.yml"
  "docker-compose.images.yml"
  "docker-compose.ntfy.images.yml"
  "docker-compose.cloudflared.images.yml"
  "deploy/check-worker/compose.yaml"
)

failed=0 checked=0
for set in "${sets[@]}"; do
  args=() missing=0
  for f in $set; do
    [ -f "$f" ] || { missing=1; break; }
    args+=(-f "$f")
  done
  [ "$missing" -eq 0 ] || continue
  checked=$((checked + 1))
  if ! out="$(docker compose --profile '*' "${args[@]}" config -q 2>&1)"; then
    echo "FAIL  compose set [$set]"; printf '%s\n' "$out" | sed 's/^/      /'; failed=1
  fi
done
echo "check-compose: $checked compose set(s) checked"

shopt -s nullglob
wf=(.github/workflows/*.yml .github/workflows/*.yaml)
if [ "${#wf[@]}" -gt 0 ]; then
  # -shellcheck= : the run: scripts are not linted here (style findings in old workflows would fail the check; the repo's own
  # scripts go through scripts/check-shell.sh). The workflow structure, expressions and job references are.
  if ! out="$(actionlint -shellcheck= -pyflakes= "${wf[@]}" 2>&1)"; then
    echo "FAIL  actionlint"; printf '%s\n' "$out" | sed 's/^/      /'; failed=1
  fi
  echo "check-compose: ${#wf[@]} workflow file(s) checked"
fi
exit "$failed"
