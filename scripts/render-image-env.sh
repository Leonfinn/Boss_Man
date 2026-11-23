#!/usr/bin/env bash
# Turns a release's release.json (scripts/publish-images.sh release-json) into the images.env that docker-compose.images.yml
# reads (BOS-974): the registry and the digest of each image. Nothing here names a registry or an account; they come from the file.
#   scripts/render-image-env.sh <release.json> [registry]   print images.env
# registry: one of the file's registries, e.g. ghcr.io/me. Default: the first one listed (GitHub's registry, ghcr.io, when it is
# listed, because it has no download limit). Every registry holds the same digests, so the choice changes where images come from, not what they are.
# Needs jq. Exit 0 = printed; 1 = the file is not a usable release.
set -euo pipefail

die() { echo "render-image-env: $*" >&2; exit 1; }
f="${1:-}" want="${2:-}"
if [ -z "$f" ] || [ ! -f "$f" ]; then die "usage: render-image-env.sh <release.json> [registry]"; fi
command -v jq >/dev/null 2>&1 || die "jq is not installed"
jq -e '.schema == 1 and (.registries | type == "array" and length > 0) and (.images | type == "array")' "$f" >/dev/null 2>&1 || die "$f is not a release.json this script understands (schema 1)"

# ghcr.io first when listed, else the file's own order.
registry="$want"
if [ -z "$registry" ]; then
  registry="$(jq -r '[.registries[] | select(startswith("ghcr.io/"))][0] // .registries[0]' "$f")"
fi
jq -e --arg r "$registry" '.registries | index($r) != null' "$f" >/dev/null || die "registry '$registry' is not one of: $(jq -r '.registries | join(", ")' "$f")"
[[ "$registry" =~ ^[a-z0-9][a-z0-9.:/_-]*$ ]] || die "registry '$registry' has odd characters"

echo "# Made by scripts/render-image-env.sh from release.json. Do not edit the digests: they are what was signed."
echo "BOSSMAN_VERSION=$(jq -r '.version' "$f")"
echo "BOSSMAN_REGISTRY=$registry"
for image in server launcher netguard runner; do
  d="$(jq -r --arg n "boss-man-$image" '.images[] | select(.name == $n) | .digest' "$f")"
  [ -n "$d" ] || die "release.json lists no boss-man-$image image. The install needs all four (the runner image must be published: add boss-man-runner to PUBLISH_IMAGES)."
  [[ "$d" =~ ^sha256:[0-9a-f]{64}$ ]] || die "boss-man-$image has a bad digest '$d'"
  echo "BOSSMAN_$(echo "$image" | tr '[:lower:]' '[:upper:]')_DIGEST=$d"
done
