#!/usr/bin/env bash
# Rebuilds the runner image and promotes it only if the canary passes (R52).
#
#   scripts/update-runner.sh             build with the latest Claude Code, check, promote
#   scripts/update-runner.sh 2.1.50      pin a Claude Code version instead of "latest"
#   scripts/update-runner.sh --rollback  go back to the image that was running before
#
# The canary runs a real Claude Code session inside the new image against a stand-in model
# served from the same container, with networking off, so it needs no credentials. The
# image that was running is kept as boss-man-runner:previous until the next update.
# Run it from the repository root, where docker-compose.yml is.
set -euo pipefail

IMAGE=boss-man-runner
compose() { docker compose --profile runners "$@"; }

if [[ "${1:-}" == "--rollback" ]]; then
  docker image inspect "$IMAGE:previous" >/dev/null 2>&1 || { echo "No previous image to roll back to." >&2; exit 1; }
  docker tag "$IMAGE:previous" "$IMAGE:current"
  compose up -d --no-build
  echo "Rolled back to the previous runner image."
  exit 0
fi

version="${1:-latest}"
stamp="$(date -u +%Y%m%d%H%M)"
echo "Building $IMAGE:candidate with Claude Code $version..."
docker build --pull -f apps/runner/Dockerfile \
  --build-arg CLAUDE_CODE_VERSION="$version" \
  --build-arg BOSSMAN_IMAGE_VERSION="$stamp" \
  -t "$IMAGE:candidate" .

echo "Running the canary (no network)..."
if ! docker run --rm --network none --cap-drop ALL --security-opt no-new-privileges:true \
  "$IMAGE:candidate" node_modules/.bin/tsx src/canary-main.ts; then
  echo "The canary failed: $IMAGE:current is unchanged and the runners keep running it." >&2
  echo "The failed build is still tagged $IMAGE:candidate if you want to look at it." >&2
  exit 1
fi

if docker image inspect "$IMAGE:current" >/dev/null 2>&1; then docker tag "$IMAGE:current" "$IMAGE:previous"; fi
docker tag "$IMAGE:candidate" "$IMAGE:current"
docker rmi "$IMAGE:candidate" >/dev/null
compose up -d --no-build
echo "Runners now use the new image ($stamp). To undo: scripts/update-runner.sh --rollback"
