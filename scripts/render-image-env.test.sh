#!/usr/bin/env bash
# Tests scripts/render-image-env.sh (BOS-974): no network, no Docker. Also checks that the compose file accepts the result.
# ok/bad only print a line and set a flag, so A && ok || bad cannot run both.
# shellcheck disable=SC2015
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.." || exit 1
S=scripts/render-image-env.sh
t="$(mktemp -d)"; trap 'rm -rf "$t"' EXIT
fail=0
ok() { echo "ok   $1"; }
bad() { echo "FAIL $1"; fail=1; }
dg() { printf "sha256:%064d" "$1"; }

mk() { # mk <file> <images...>
  local file="$1"; shift
  local imgs="" n
  for n in "$@"; do imgs="$imgs${imgs:+,}{\"name\":\"boss-man-$n\",\"digest\":\"$(dg ${#n})\",\"platforms\":{}}"; done
  echo "{\"schema\":1,\"version\":\"0.1.0-beta.1\",\"commit\":\"abc\",\"registries\":[\"docker.io/me\",\"ghcr.io/me\"],\"images\":[$imgs]}" > "$file"
}
mk "$t/all.json" server launcher netguard runner updater
mk "$t/norunner.json" server launcher netguard updater
mk "$t/noupdater.json" server launcher netguard runner
export GITHUB_REPOSITORY=example/boss-man

out="$("$S" "$t/all.json" 2>&1)" || { bad "renders a full release: $out"; }
echo "$out" | grep -q '^BOSSMAN_REGISTRY=ghcr.io/me$' && ok "ghcr is the default even when listed second" || bad "default registry: $out"
echo "$out" | grep -q "^BOSSMAN_RUNNER_DIGEST=$(dg 6)$" && ok "runner digest" || bad "runner digest: $out"
echo "$out" | grep -q '^BOSSMAN_VERSION=0.1.0-beta.1$' && ok "version" || bad "version"
hub="$("$S" "$t/all.json" docker.io/me 2>&1)"; echo "$hub" | grep -q '^BOSSMAN_REGISTRY=docker.io/me$' && ok "picks a listed registry" || bad "pick registry"
if "$S" "$t/all.json" evil.io/x 2>/dev/null; then bad "refused an unlisted registry"; else ok "refuses an unlisted registry"; fi
if err="$("$S" "$t/norunner.json" 2>&1)"; then bad "refused a release with no runner image"; else echo "$err" | grep -q 'boss-man-runner' && ok "refuses a release with no runner image, by name" || bad "no-runner message: $err"; fi
if err="$("$S" "$t/noupdater.json" 2>&1)"; then bad "refused a release with no updater image"; else echo "$err" | grep -q 'boss-man-updater' && ok "refuses a release with no updater image, by name" || bad "no-updater message: $err"; fi
echo "$out" | grep -q "^BOSSMAN_UPDATER_DIGEST=$(dg 7)$" && ok "updater digest" || bad "updater digest: $out"
echo "$out" | grep -q '^BOSSMAN_UPDATER_REPO=example/boss-man$' && ok "the signing repository for the updater" || bad "updater repo: $out"
echo '{"schema":2}' > "$t/v2.json"
if "$S" "$t/v2.json" 2>/dev/null; then bad "refused an unknown schema"; else ok "refuses an unknown schema"; fi
if "$S" "$t/missing.json" 2>/dev/null; then bad "refused a missing file"; else ok "refuses a missing file"; fi

# The compose file takes exactly what this prints, and says what to do without it.
if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
  "$S" "$t/all.json" > "$t/images.env"
  img="$(docker compose --env-file "$t/images.env" -f docker-compose.images.yml config --format json 2>&1 | jq -r '.services.updater.image')"
  [ "$img" = "ghcr.io/me/boss-man-updater@$(dg 7)" ] && ok "compose reads images.env" || bad "compose image: $img"
  # Criterion 2: with Docker Hub picked, every Boss Man image (and the launcher's runner and guard images) names docker.io/me and the same digest.
  "$S" "$t/all.json" docker.io/me > "$t/hub.env"
  cfg="$(docker compose --env-file "$t/hub.env" -f docker-compose.images.yml --profile '*' config --format json 2>&1)"
  for pair in "updater:updater:7" "setup:launcher:8"; do
    IFS=: read -r svc nm len <<<"$pair"
    got="$(echo "$cfg" | jq -r ".services[\"$svc\"].image // \"missing\"")"
    [ "$got" = "docker.io/me/boss-man-$nm@$(dg "$len")" ] && ok "Docker Hub: $svc image" || bad "Docker Hub: $svc image: $got"
  done
  # The server, launcher, runner and guard images are made by the updater from these four settings (BOS-1227).
  for pair in "SERVER:6" "LAUNCHER:8" "RUNNER:6" "NETGUARD:8"; do
    IFS=: read -r k len <<<"$pair"
    echo "$cfg" | jq -r ".services.updater.environment.UPDATER_FIRST_${k}_DIGEST" | grep -qx "$(dg "$len")" && ok "updater's first-start $k digest" || bad "updater's first-start $k digest"
  done
  echo "$cfg" | jq -r '.services.updater.environment.UPDATER_REGISTRY' | grep -qx 'docker.io/me' && ok "Docker Hub: the updater pulls from the chosen registry" || bad "Docker Hub: UPDATER_REGISTRY"
  if docker compose -f docker-compose.images.yml config -q 2>"$t/err"; then bad "compose refused no images.env"; else grep -q 'images.env\|BOSSMAN_REGISTRY' "$t/err" && ok "compose names the missing setting (images.env or BOSSMAN_REGISTRY; newer Compose drops our hint text)" || bad "compose message: $(cat "$t/err")"; fi
else
  echo "skip compose checks (no docker compose)"
fi
exit "$fail"
