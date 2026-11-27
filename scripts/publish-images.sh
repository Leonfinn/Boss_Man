#!/usr/bin/env bash
# The rules behind .github/workflows/publish.yml and release.yml (BOS-973, plan: BOS-935, DR-050). They live in
# one script so they can be tested without a registry (scripts/publish-images.test.sh) and so the two workflows agree.
#
#   publish-images.sh prefixes                 the registries and namespaces to publish under, one per line; the first is
#                                              pushed to, the others get a copy by digest. Fails loudly on a wrong setting.
#   publish-images.sh images                   the image names to publish, one per line
#   publish-images.sh dockerfile <name>        the Dockerfile of an image
#   publish-images.sh tag <commit>             the tag every merge gets: sha-<first 12 characters>
#   publish-images.sh copy <name> <tag> <digest>
#                                              copy the finished multi-arch image from the first prefix to the others
#                                              by digest, and fail if any copy has a different digest
#   publish-images.sh digest <reference>       the digest a reference points to, waiting about a minute for a new tag
#   publish-images.sh verify <name> <digest>   in EVERY registry: the signature, the SBOM and the provenance exist
#   publish-images.sh release-json <version> <commit> <tag>
#                                              print release.json: each image's digest, and its digest per architecture
#   publish-images.sh resolve-commit <input> <default>
#                                              the commit to release: <default> when <input> is empty, else <input> if it is
#                                              a full 40-hex sha reachable from origin/main; otherwise fails
#   publish-images.sh version-commit <version>
#                                              the commit whose images already carry <version> (their revision label), or
#                                              nothing when no image has it; fails when the images disagree
#   publish-images.sh workflows-match <commit> fails when the commit's .github/workflows differ from origin/main's
#                                              (GitHub refuses a release there with the Actions token)
#
# Settings come from the environment (GitHub: repository variables and secrets), never from this file:
#   IMAGE_PREFIXES      space or comma separated <registry>/<namespace> list, e.g. "ghcr.io/me docker.io/me".
#                       Empty: ghcr.io/<GITHUB_REPOSITORY_OWNER>.
#   PUBLISH_IMAGES      image names, default boss-man-server boss-man-launcher boss-man-netguard. The runner image
#                       (boss-man-runner) is added only once it holds no Anthropic code (BOS-972); publish.yml runs
#                       `scripts/image-tests.sh no-anthropic` on it first, with the expected-fail marker off.
#   DOCKERHUB_PUBLISH   "true" turns Docker Hub on. Then a docker.io prefix must be listed and DOCKERHUB_USERNAME and
#                       DOCKERHUB_TOKEN (secrets of the 'publish' environment) must be set, or this fails. Off: docker.io entries are skipped.
#   COSIGN_IDENTITY_REGEXP  who may have signed (verify). Default: this repository's publish and release workflows.
set -euo pipefail

die() { echo "publish-images: $*" >&2; exit 1; }

# Registries this repo knows how to log in to (the workflows have a login step for each).
host_of() { echo "${1%%/*}"; }
is_hub() { case "$(host_of "$1")" in docker.io | index.docker.io | registry-1.docker.io) return 0 ;; *) return 1 ;; esac; }

cmd_prefixes() {
  local raw="${IMAGE_PREFIXES:-}" p out=() hub_listed=0 hub_on=0
  [ -n "${raw//[[:space:],]/}" ] || raw="ghcr.io/${GITHUB_REPOSITORY_OWNER:-}"
  [ "${DOCKERHUB_PUBLISH:-}" = true ] && hub_on=1
  for p in ${raw//,/ }; do
    p="${p,,}"; p="${p%/}"
    case "$p" in */?*) ;; *) die "'$p' is not <registry>/<namespace> (for example ghcr.io/me). Set the IMAGE_PREFIXES variable." ;; esac
    case "$(host_of "$p")" in *.* | *:*) ;; *) die "'$p' names no registry. Write the registry first, e.g. docker.io/$p." ;; esac
    if is_hub "$p"; then
      hub_listed=1
      [ "$hub_on" = 1 ] || { echo "publish-images: Docker Hub is off (DOCKERHUB_PUBLISH is not true), skipping $p" >&2; continue; }
      p="docker.io/${p#*/}"
    else
      [ "$(host_of "$p")" = ghcr.io ] || die "'$p': only ghcr.io and docker.io have a login step in publish.yml. Add one before listing another registry."
    fi
    out+=("$p")
  done
  if [ "$hub_on" = 1 ]; then
    [ "$hub_listed" = 1 ] || die "DOCKERHUB_PUBLISH is true but IMAGE_PREFIXES lists no docker.io/<namespace>."
    [ -n "${DOCKERHUB_USERNAME:-}" ] || die "Docker Hub publishing is on but the DOCKERHUB_USERNAME secret is missing or empty. Add it as a secret of the 'publish' environment (Settings > Environments > publish), not under Secrets and variables > Actions, or set DOCKERHUB_PUBLISH to false."
    [ -n "${DOCKERHUB_TOKEN:-}" ] || die "Docker Hub publishing is on but the DOCKERHUB_TOKEN secret is missing or empty. Add it as a secret of the 'publish' environment (Settings > Environments > publish), not under Secrets and variables > Actions, or set DOCKERHUB_PUBLISH to false."
  fi
  [ "${#out[@]}" -gt 0 ] || die "no registry left to publish to."
  printf '%s\n' "${out[@]}"
}

cmd_images() {
  local n
  for n in ${PUBLISH_IMAGES:-boss-man-server boss-man-launcher boss-man-netguard}; do
    case "$n" in boss-man-server | boss-man-launcher | boss-man-netguard | boss-man-runner | boss-man-updater) echo "$n" ;; *) die "unknown image '$n'" ;; esac
  done
}

cmd_dockerfile() {
  case "${1:-}" in boss-man-server | boss-man-launcher | boss-man-netguard | boss-man-runner | boss-man-updater) echo "apps/${1#boss-man-}/Dockerfile" ;; *) die "unknown image '${1:-}'" ;; esac
}

cmd_tag() {
  [[ "${1:-}" =~ ^[0-9a-f]{12,40}$ ]] || die "tag needs a commit id"
  echo "sha-${1:0:12}"
}

# Read into arrays through a plain assignment, so a failing check stops the script (it would not inside < <(...)).
load_prefixes() { local out; out="$(cmd_prefixes)"; mapfile -t prefixes <<<"$out"; }
load_images() { local out; out="$(cmd_images)"; mapfile -t names <<<"$out"; }

# The digest a reference points to (the manifest list for a multi-arch image). A tag written a moment ago can read
# as "not found" for a few seconds (BOS-2768: ghcr.io, right after `imagetools create`; the same commit's next run
# passed), so a failed read is tried again, PUBLISH_READ_TRIES times PUBLISH_READ_STEP seconds apart (about a
# minute). A reference that never appears still fails, naming it.
digest_of() {
  local out try=1 tries="${PUBLISH_READ_TRIES:-12}" step="${PUBLISH_READ_STEP:-5}"
  until out="$(docker buildx imagetools inspect "$1" --format '{{json .Manifest}}')"; do
    [ "$try" -lt "$tries" ] || die "$1 still cannot be read after $tries tries"
    echo "publish-images: $1 cannot be read yet (try $try of $tries), trying again in ${step}s" >&2
    sleep "$step"
    try=$((try + 1))
  done
  jq -r .digest <<<"$out"
}

cmd_digest() { digest_of "${1:?image reference}"; }

cmd_copy() {
  local name="${1:?image name}" tag="${2:?tag}" digest="${3:?digest}" first p got
  load_prefixes
  first="${prefixes[0]}"
  [[ "$digest" =~ ^sha256:[0-9a-f]{64}$ ]] || die "'$digest' is not a sha256 digest"
  got="$(digest_of "$first/$name:$tag")"
  [ "$got" = "$digest" ] || die "$first/$name:$tag is $got, expected $digest"
  for p in "${prefixes[@]:1}"; do
    docker buildx imagetools create -t "$p/$name:$tag" "$first/$name@$digest"
    got="$(digest_of "$p/$name:$tag")"
    [ "$got" = "$digest" ] || die "$p/$name:$tag has digest $got but $first has $digest. One signed release.json can only cover identical images."
    echo "publish-images: $p/$name:$tag = $digest"
  done
}

cmd_verify() {
  local name="${1:?image name}" digest="${2:?digest}" p re arch what out
  re="${COSIGN_IDENTITY_REGEXP:-^https://github.com/${GITHUB_REPOSITORY:?GITHUB_REPOSITORY or COSIGN_IDENTITY_REGEXP}/\.github/workflows/(publish|release)\.yml@refs/heads/main\$}"
  load_prefixes
  for p in "${prefixes[@]}"; do
    [ "$(digest_of "$p/$name@$digest")" = "$digest" ] || die "$p/$name does not hold $digest"
    cosign verify --certificate-oidc-issuer https://token.actions.githubusercontent.com --certificate-identity-regexp "$re" "$p/$name@$digest" >/dev/null \
      || die "$p/$name@$digest: the signature is missing or not from this repository's workflow"
    for what in SBOM Provenance; do
      out="$(docker buildx imagetools inspect "$p/$name@$digest" --format "{{json .$what}}")"
      for arch in linux/amd64 linux/arm64; do
        echo "$out" | jq -e --arg a "$arch" 'type == "object" and has($a) and (.[$a] != null)' >/dev/null \
          || die "$p/$name@$digest: no $what for $arch in this registry"
      done
    done
    echo "publish-images: $p/$name@$digest has a signature, SBOM and provenance for both architectures"
  done
}

cmd_resolve_commit() {
  # <input> <default>: the commit a release is for. Empty input = the default (main's head, $GITHUB_SHA). A typed commit
  # must be 40 hex and reachable from origin/main: the updater trusts release.json signed by release.yml on main, so a
  # commit that never merged must never be released. Needs a full-history checkout with origin/main.
  local input="${1:-}" default="${2:?default commit}" full
  if [ -z "$input" ]; then echo "$default"; return; fi
  [[ "$input" =~ ^[0-9a-f]{40}$ ]] || die "commit '$input' is not a full 40-character lower-case sha. Leave it blank for main's newest commit."
  git cat-file -e "$input^{commit}" 2>/dev/null || die "commit $input is not in this repository."
  full="$(git rev-parse "$input^{commit}")"
  git rev-parse --verify -q origin/main >/dev/null || die "origin/main is not available to check commit $input against."
  git merge-base --is-ancestor "$full" origin/main || die "commit $input is not on main. Only a commit that has merged to main can be released."
  echo "$full"
}

cmd_workflows_match() {
  # <commit>: fails, naming the files, when the commit's .github/workflows/ differ from origin/main's. GitHub's "Create a
  # release" refuses such a target with the Actions token (HTTP 403 "Resource not accessible by integration", REST docs:
  # the token must be allowed to modify workflows, and GITHUB_TOKEN never is). BOS-2602: runs #3/#4 tagged c94ebeb3's
  # images, then step 13 hit exactly that 403, leaving a version half-made. Checked before anything is tagged.
  local commit="${1:?commit}" files
  git rev-parse --verify -q origin/main >/dev/null || die "origin/main is not available to compare commit $commit's workflow files with."
  files="$(git diff --name-only "$commit" origin/main -- .github/workflows/)"
  [ -z "$files" ] || die "commit $commit has different workflow files from main ($(echo "$files" | tr '\n' ' ')). GitHub will not let this workflow create a release there (HTTP 403). Leave the commit box blank, or type a newer main commit whose workflow files match main's; if this version is already on that commit's images, pick a new version."
}

cmd_version_commit() {
  # <version>: the commit whose images already carry the version tag in the first registry, read from the
  # org.opencontainers.image.revision label publish.yml puts on every image. Prints nothing when no image has the tag
  # (a new version). Fails when the images name more than one commit, or one has the tag but no label. BOS-2602: a
  # Release that tagged the images and then failed before the GitHub release is resumed on that commit, not on main's
  # newest one (which would never match the tag, so the re-press was refused with nothing readable to say why).
  local version="${1:?version}" first name cfg revs found=""
  load_prefixes
  first="${prefixes[0]}"
  load_images
  for name in "${names[@]}"; do
    cfg="$(docker buildx imagetools inspect "$first/$name:$version" --format '{{json .Image}}' 2>/dev/null)" || continue
    [ -n "$cfg" ] || continue
    # One platform: the config itself; several: a map of platform to config. Collect every revision label in either.
    revs="$(echo "$cfg" | jq -r '[.. | objects | .Labels? // empty | objects | .["org.opencontainers.image.revision"] // empty] | unique | .[]')"
    [ -n "$revs" ] || die "$first/$name:$version has no org.opencontainers.image.revision label, so its commit is unknown. Type the commit in the commit box, or pick a new version."
    [ "$(echo "$revs" | wc -l)" = 1 ] || die "$first/$name:$version names more than one commit ($(echo "$revs" | tr '\n' ' ')). Pick a new version."
    [ -z "$found" ] || [ "$found" = "$revs" ] || die "the $version images name different commits ($found and $revs on $name). Pick a new version."
    found="$revs"
  done
  [ -z "$found" ] || echo "$found"
}

# The Claude pack folder name for a commit: the first 24 hex characters of the sha256 of apps/runner/claude-pack/package-lock.json
# at that commit, the same rule as lockHash() in apps/runner/src/claude-pack.ts. The updater (BOS-941a) compares the folder its pack
# installer made with this signed value. Read from git at the released commit (main may have moved on since).
pack_hash() {
  local h
  h="$(git show "$1:apps/runner/claude-pack/package-lock.json" 2>/dev/null | sha256sum | cut -c1-24)" || true
  git cat-file -e "$1:apps/runner/claude-pack/package-lock.json" 2>/dev/null || die "commit $1 has no apps/runner/claude-pack/package-lock.json, so release.json cannot name the Claude pack hash"
  [[ "$h" =~ ^[0-9a-f]{24}$ ]] || die "could not hash the Claude pack lockfile at $1"
  echo "$h"
}

# The number of the colour-spec layout the updater's swap builds (941b). Bump it with a change to that layout.
INSTALL_LAYOUT=1

cmd_release_json() {
  local version="${1:?version}" commit="${2:?commit}" tag="${3:?tag}" first p name d got images=() prefixes_json packhash
  [[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.]+)?$ ]] || die "version '$version' is not like 0.1.0 or 0.1.0-beta.1"
  packhash="$(pack_hash "$commit")"
  load_prefixes
  first="${prefixes[0]}"
  load_images
  for name in "${names[@]}"; do
    d="$(digest_of "$first/$name:$tag")"
    for p in "${prefixes[@]:1}"; do
      got="$(digest_of "$p/$name:$tag")"
      [ "$got" = "$d" ] || die "$name: $p has $got but $first has $d"
    done
    images+=("$(docker buildx imagetools inspect "$first/$name@$d" --raw \
      | jq -c --arg n "$name" --arg d "$d" '{name: $n, digest: $d, platforms: ([.manifests[] | select(.platform.os == "linux" and .platform.architecture != "unknown") | {key: (.platform.os + "/" + .platform.architecture), value: .digest}] | from_entries)}')")
  done
  prefixes_json="$(printf '%s\n' "${prefixes[@]}" | jq -R . | jq -sc .)"
  # packHash and installLayout are additive: an updater reading an older release.json simply finds them absent.
  printf '%s\n' "${images[@]}" | jq -s --arg v "$version" --arg c "$commit" --argjson p "$prefixes_json" --arg h "$packhash" --argjson l "$INSTALL_LAYOUT" \
    '{schema: 1, version: $v, commit: $c, registries: $p, images: ., packHash: $h, installLayout: $l}'
}

case "${1:-}" in
  prefixes) shift; cmd_prefixes "$@" ;;
  images) shift; cmd_images "$@" ;;
  dockerfile) shift; cmd_dockerfile "$@" ;;
  tag) shift; cmd_tag "$@" ;;
  copy) shift; cmd_copy "$@" ;;
  digest) shift; cmd_digest "$@" ;;
  verify) shift; cmd_verify "$@" ;;
  release-json) shift; cmd_release_json "$@" ;;
  resolve-commit) shift; cmd_resolve_commit "$@" ;;
  version-commit) shift; cmd_version_commit "$@" ;;
  workflows-match) shift; cmd_workflows_match "$@" ;;
  *) sed -n '2,32p' "$0" >&2; exit 2 ;;
esac
