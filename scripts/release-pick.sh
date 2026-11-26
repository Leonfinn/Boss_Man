#!/usr/bin/env bash
# What the weekly Release run (BOS-2662) releases, decided in one place so it can be tested without GitHub or a registry
# (scripts/release-pick.test.sh). Prints key=value lines on stdout, notes for people on stderr:
#
#   release-pick.sh pick
#     sha=<40 hex>        the newest commit of main that is green and has every image published and signed
#     tag=sha-<12 hex>    its image tag
#     version=<x.y.z-beta.N>   the next beta number after the newest vX.Y.Z-beta.N release
#     prev_sha=<sha>      the commit the newest beta was released from (empty when there is none), for the notes
#   or, when nothing may be released this week, a single line
#     skip=<one-line reason>
#
# A commit qualifies when ALL hold: the CI workflow (ci.yml) passed on it as a push; every image in PUBLISH_IMAGES is in the
# first registry under its sha tag for linux/amd64 and linux/arm64; and `publish-images.sh verify` accepts every image
# (signature, SBOM and provenance in every registry). The newest RELEASE_PICK_DEPTH (default 30) commits of origin/main are
# looked at, newest first, and the first that qualifies wins; a red or half-published commit is never chosen.
# A chosen commit that is the last beta's own commit, or older than it, is "nothing new": skipped, no release.
#
# Needs: git with origin/main, gh (GH_TOKEN), docker buildx, cosign, jq; the same settings as publish-images.sh.
# GITHUB_REPOSITORY comes from GitHub's context, so a fork works with no change.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PUBLISH="${PUBLISH_IMAGES_SH:-$HERE/publish-images.sh}"
REPO="${GITHUB_REPOSITORY:?GITHUB_REPOSITORY}"
DEPTH="${RELEASE_PICK_DEPTH:-30}"
CI_WORKFLOW="${RELEASE_CI_WORKFLOW:-ci.yml}"

say() { echo "release-pick: $*" >&2; }
die() { echo "release-pick: $*" >&2; exit 1; }

# The newest beta release by number (not by date), as JSON {t: tag, k: [major, minor, patch, n]}, or nothing.
latest_beta() {
  local list
  list="$(gh release list --limit 200 --json tagName)" || die "could not list the releases"
  echo "$list" | jq -c '[.[] | .tagName | select(test("^v[0-9]+\\.[0-9]+\\.[0-9]+-beta\\.[0-9]+$"))
    | {t: ., k: (ltrimstr("v") | split("-beta.") | [(.[0] | split(".") | map(tonumber)), [(.[1] | tonumber)]] | add)}]
    | sort_by(.k) | last // empty'
}

ci_passed() {
  local n
  n="$(gh api "repos/$REPO/actions/workflows/$CI_WORKFLOW/runs?head_sha=$1&event=push&per_page=50" \
    --jq '[.workflow_runs[] | select(.conclusion == "success")] | length')" || die "could not read the CI runs of $1"
  [ "${n:-0}" -gt 0 ]
}

# Every image there, for both architectures, and verified in every registry. Says why on stderr when not.
images_ready() {
  local sha="$1" tag first name d
  tag="$("$PUBLISH" tag "$sha")"
  first="$("$PUBLISH" prefixes | head -n 1)"
  for name in $("$PUBLISH" images); do
    d="$(docker buildx imagetools inspect "$first/$name:$tag" --format '{{json .Manifest}}' 2>/dev/null | jq -r .digest 2>/dev/null)" || d=""
    if [ -z "$d" ] || [ "$d" = null ]; then say "${sha:0:12}: no $name image yet"; return 1; fi
    docker buildx imagetools inspect "$first/$name@$d" --raw 2>/dev/null \
      | jq -e '[.manifests[] | select(.platform.os == "linux") | .platform.architecture] | (index("amd64") != null) and (index("arm64") != null)' >/dev/null 2>&1 \
      || { say "${sha:0:12}: $name is not published for both amd64 and arm64"; return 1; }
    "$PUBLISH" verify "$name" "$d" >/dev/null 2>&1 || { say "${sha:0:12}: $name is not signed or lacks its SBOM or provenance"; return 1; }
  done
}

cmd_pick() {
  local latest tag="" core="" n=0 version prev="" sha chosen=""
  latest="$(latest_beta)"
  if [ -n "$latest" ]; then
    tag="$(echo "$latest" | jq -r .t)"
    core="$(echo "$tag" | sed -E 's/^v([0-9]+\.[0-9]+\.[0-9]+)-beta\.[0-9]+$/\1/')"
    n="$(echo "$tag" | sed -E 's/^.*-beta\.([0-9]+)$/\1/')"
    prev="$(gh api "repos/$REPO/releases/tags/$tag" --jq .target_commitish)" || die "could not read $tag"
    [[ "$prev" =~ ^[0-9a-f]{40}$ ]] || prev=""
  else
    core="0.1.0"
  fi
  version="$core-beta.$((n + 1))"

  while read -r sha; do
    [ -n "$sha" ] || continue
    ci_passed "$sha" || { say "${sha:0:12}: main CI has not passed on it"; continue; }
    images_ready "$sha" || continue
    chosen="$sha"
    break
  done < <(git rev-list --first-parent -n "$DEPTH" origin/main)

  if [ -z "$chosen" ]; then
    echo "skip=Weekly release skipped: none of the newest $DEPTH commits on main is green with every image published and signed."
    return 0
  fi
  if [ -n "$prev" ] && { [ "$chosen" = "$prev" ] || git merge-base --is-ancestor "$chosen" "$prev" 2>/dev/null; }; then
    echo "skip=Weekly release skipped: nothing new on main since $tag."
    return 0
  fi
  echo "sha=$chosen"
  echo "tag=$("$PUBLISH" tag "$chosen")"
  echo "version=$version"
  echo "prev_sha=$prev"
}

case "${1:-}" in
  pick) shift; cmd_pick "$@" ;;
  *) sed -n '2,18p' "$0" >&2; exit 2 ;;
esac
