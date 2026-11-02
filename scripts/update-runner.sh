#!/usr/bin/env bash
# Rebuilds the runner image and promotes it only if the canary passes (R52), then has the runners
# move onto it WITHOUT cutting off agent runs: Boss Man drains (nothing new starts, runs finish) and
# the launcher swaps each company's runner as soon as that company is idle (docs/09-self-deploy.md).
#
#   scripts/update-runner.sh             build with the latest Claude Code, check, promote, ask for the drain
#   scripts/update-runner.sh 2.1.50      pin a Claude Code version instead of "latest"
#   scripts/update-runner.sh --rollback  tag the image that was running before as current, then drain onto it
#   scripts/update-runner.sh --now       emergencies: recreate every runner at once (runs in progress are
#                                        cut off, crash recovery restarts them). Works with the others.
#
# The drain is asked for by dropping inbox/drain.json into the deployer folder ($BOSSMAN_DEPLOYER: set by
# the host deployer, or read from .env). The script returns at once, so a host lock is not held while runs finish; Boss Man
# tells the owner when the swap is done. With no deployer folder, start it in Settings > Runner update.
# Without the launcher there is nothing to drain onto, so the runners are restarted at once, as with --now.
#
# The canary runs a real Claude Code session inside the new image against a stand-in model
# served from the same container, with networking off, so it needs no credentials. The
# image that was running is kept as boss-man-runner:previous until the next update.
# Run it from the repository root, where docker-compose.yml is.
set -euo pipefail

IMAGE=boss-man-runner
# Compose runners follow COMPOSE_PROFILES (from .env); with none set, the "runners" profile as
# before. Runners the launcher made (R55) are recreated by the launcher itself.
profiles="${COMPOSE_PROFILES:-$(grep -s '^COMPOSE_PROFILES=' .env | tail -1 | cut -d= -f2- || true)}"
# The deployer folder (docs/09-self-deploy.md) is where the drain request goes; .env has it once self-deploy is set up.
BOSSMAN_DEPLOYER="${BOSSMAN_DEPLOYER:-$(grep -s '^BOSSMAN_DEPLOYER=' .env | tail -1 | cut -d= -f2- || true)}"
# Optional runner add-ons (docs/12), e.g. RUNNER_ADDONS=agent-browser,webkit in .env; empty builds the plain image.
addons="${RUNNER_ADDONS:-$(grep -s '^RUNNER_ADDONS=' .env | tail -1 | cut -d= -f2- || true)}"
compose() { COMPOSE_PROFILES="${profiles:-runners}" docker compose "$@"; }
launcher_id() { docker ps -q --filter label=com.docker.compose.project=boss-man --filter label=com.docker.compose.service=launcher; }

restart_runners() { # everything at once: the old behaviour
  compose up -d --no-build
  local launcher
  launcher="$(launcher_id)"
  if [[ -n "$launcher" ]]; then docker exec "$launcher" node dist/main.js recreate-all; fi
}

# Asks the server to start the drain. The file's existence is the whole request (written, then renamed).
request_drain() {
  local d="${BOSSMAN_DEPLOYER:-}"
  if [[ -n $d && -d $d/inbox ]]; then
    # Written in the root-only state folder, then renamed in: the server can write to inbox, so writing
    # there directly would follow a symlink it planted. A rename replaces whatever is at the name instead.
    mkdir -p "$d/state" && chmod 700 "$d/state"
    local tmp
    tmp="$(mktemp "$d/state/drain.XXXXXX")"
    printf '{"requestedAt":"%s","by":"update-runner.sh"}\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >"$tmp"
    chmod 644 "$tmp"; chown 1000:1000 "$tmp" 2>/dev/null || true
    mv -fT "$tmp" "$d/inbox/drain.json"
    echo "Asked Boss Man to drain: nothing new starts, runs finish, each runner is swapped when its company is idle."
    echo "Boss Man notifies you when it is done. To stop it: Settings > Runner update > Cancel."
  else
    echo "The new image is tagged, and the runners still run the old one. Start the drain in Boss Man:"
    echo "Settings > Runner update > Update runners. (Or rerun with --now to cut runs off and restart at once.)"
  fi
}

move_runners() {
  if ((NOW)); then restart_runners; echo "Runners recreated now."; return; fi
  if [[ -z "$(launcher_id)" ]]; then
    echo "WARNING: no launcher is running, so there is nothing to drain onto: restarting the runners at once." >&2
    restart_runners
    return
  fi
  request_drain
}

NOW=0 ROLLBACK=0 version=
for a in "$@"; do
  case $a in
    --now) NOW=1 ;;
    --rollback) ROLLBACK=1 ;;
    -*) echo "Usage: $0 [--now] [--rollback | CLAUDE_CODE_VERSION]" >&2; exit 2 ;;
    *) version="$a" ;;
  esac
done

if ((ROLLBACK)); then
  docker image inspect "$IMAGE:previous" >/dev/null 2>&1 || { echo "No previous image to roll back to." >&2; exit 1; }
  docker tag "$IMAGE:previous" "$IMAGE:current"
  move_runners
  echo "The previous runner image is now current."
  exit 0
fi

stamp="$(date -u +%Y%m%d%H%M)"
echo "Building $IMAGE:candidate with Claude Code ${version:-(the version pinned in the Dockerfile)}${addons:+ and add-ons: $addons}..."
docker build --pull -f apps/runner/Dockerfile \
  ${version:+--build-arg CLAUDE_CODE_VERSION="$version"} \
  --build-arg BOSSMAN_IMAGE_VERSION="$stamp" \
  --build-arg RUNNER_ADDONS="$addons" \
  -t "$IMAGE:candidate" .

echo "Running the canary (no network): a Claude session, then each add-on..."
if ! docker run --rm --network none --cap-drop ALL --security-opt no-new-privileges:true \
  "$IMAGE:candidate" node_modules/.bin/tsx src/canary-main.ts; then
  echo "The canary failed: $IMAGE:current is unchanged and the runners keep running it." >&2
  echo "The failed build is still tagged $IMAGE:candidate if you want to look at it." >&2
  exit 1
fi

if docker image inspect "$IMAGE:current" >/dev/null 2>&1; then docker tag "$IMAGE:current" "$IMAGE:previous"; fi
docker tag "$IMAGE:candidate" "$IMAGE:current"
docker rmi "$IMAGE:candidate" >/dev/null
move_runners
echo "The new runner image ($stamp) is current. To undo: scripts/update-runner.sh --rollback"
