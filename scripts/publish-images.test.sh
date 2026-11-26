#!/usr/bin/env bash
# Tests for scripts/publish-images.sh with a fake docker and cosign: no registry, no network.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
S=$(mktemp -d); trap 'rm -rf "$S"' EXIT
fail() { echo "publish-images.test.sh: FAIL: $*" >&2; exit 1; }
D1=sha256:$(printf 'a%.0s' {1..64}); D2=sha256:$(printf 'b%.0s' {1..64}); DA=sha256:$(printf '1%.0s' {1..64}); DB=sha256:$(printf '2%.0s' {1..64})
mkdir -p "$S/bin" "$S/state"

# A fake registry: one file per reference holding the digest it points to.
cat >"$S/bin/docker" <<'EOF'
#!/usr/bin/env bash
# Only `docker buildx imagetools create|inspect`.
[ "$1 $2" = "buildx imagetools" ] || exit 99
key() { echo "$1" | tr '/:@' '___'; }
case "$3" in
  create)
    dst=$5; src=$6
    case "$src" in *@*) d=${src#*@} ;; *) d=$(cat "$FAKE_STATE/$(key "$src")") ;; esac
    case "$dst" in *"${FAKE_BAD_COPY:-@none@}"*) d=sha256:$(printf 'f%.0s' {1..64}) ;; esac
    echo "$d" >"$FAKE_STATE/$(key "$dst")" ;;
  inspect)
    ref=$4; fmt=${5:-}
    case "$ref" in *@*) d=${ref#*@} ;; *) d=$(cat "$FAKE_STATE/$(key "$ref")") ;; esac
    case "$fmt" in
      --raw) printf '{"manifests":[{"digest":"%s","platform":{"os":"linux","architecture":"amd64"}},{"digest":"%s","platform":{"os":"linux","architecture":"arm64"}},{"digest":"sha256:cc","platform":{"os":"unknown","architecture":"unknown"}}]}\n' "$FAKE_DA" "$FAKE_DB" ;;
      --format) case "$6" in
        '{{json .Manifest}}') printf '{"digest":"%s"}\n' "$d" ;;
        '{{json .SBOM}}') if [ -n "${FAKE_SBOM:-}" ]; then echo "$FAKE_SBOM"; else echo '{"linux/amd64":{"x":1},"linux/arm64":{"x":1}}'; fi ;;
        '{{json .Provenance}}') echo '{"linux/amd64":{"x":1},"linux/arm64":{"x":1}}' ;;
        # The image config per platform; its revision label comes from a rev_ file beside the reference (none: no label).
        '{{json .Image}}')
          [ -f "$FAKE_STATE/$(key "$ref")" ] || { echo "ERROR: not found" >&2; exit 1; }
          r=$(cat "$FAKE_STATE/rev_$(key "$ref")" 2>/dev/null || true)
          if [ -n "$r" ]; then l=$(printf '{"org.opencontainers.image.revision":"%s"}' "$r"); else l='{}'; fi
          printf '{"linux/amd64":{"config":{"Labels":%s}},"linux/arm64":{"config":{"Labels":%s}}}\n' "$l" "$l" ;;
        *) exit 98 ;; esac ;;
      *) exit 97 ;;
    esac ;;
esac
EOF
cat >"$S/bin/cosign" <<'EOF'
#!/usr/bin/env bash
[ -z "${FAKE_NO_SIG:-}" ]
EOF
chmod +x "$S/bin/docker" "$S/bin/cosign"
run() { env -i PATH="$S/bin:$PATH" FAKE_STATE="$S/state" FAKE_DA="$DA" FAKE_DB="$DB" GITHUB_REPOSITORY=acme/boss-man "$@"; }
P="scripts/publish-images.sh"

# Prefixes: the default is ghcr.io of the owner; lower case; an unlisted registry is refused.
[ "$(run GITHUB_REPOSITORY_OWNER=Acme $P prefixes)" = ghcr.io/acme ] || fail "default prefix"
[ "$(run IMAGE_PREFIXES="GHCR.io/Me/ docker.io/me" $P prefixes 2>/dev/null)" = ghcr.io/me ] || fail "Docker Hub must be skipped while the setting is off"
out=$(run IMAGE_PREFIXES="ghcr.io/me,docker.io/me2" DOCKERHUB_PUBLISH=true DOCKERHUB_USERNAME=u DOCKERHUB_TOKEN=t $P prefixes)
[ "$out" = "$(printf 'ghcr.io/me\ndocker.io/me2')" ] || fail "both prefixes expected, got: $out"
# Once on, missing secrets or a missing prefix fail loudly, never skip.
if run IMAGE_PREFIXES="ghcr.io/me docker.io/me" DOCKERHUB_PUBLISH=true DOCKERHUB_TOKEN=t $P prefixes 2>"$S/err"; then fail "missing username must fail"; fi
grep -q DOCKERHUB_USERNAME "$S/err" || fail "the error must name the missing secret"
if run IMAGE_PREFIXES="ghcr.io/me docker.io/me" DOCKERHUB_PUBLISH=true DOCKERHUB_USERNAME=u DOCKERHUB_TOKEN= $P prefixes 2>"$S/err"; then fail "empty token must fail"; fi
grep -q DOCKERHUB_TOKEN "$S/err" || fail "the error must name DOCKERHUB_TOKEN"
if run IMAGE_PREFIXES="ghcr.io/me" DOCKERHUB_PUBLISH=true DOCKERHUB_USERNAME=u DOCKERHUB_TOKEN=t $P prefixes 2>/dev/null; then fail "Hub on with no docker.io prefix must fail"; fi
if run IMAGE_PREFIXES="me" $P prefixes 2>/dev/null; then fail "a bare name must fail"; fi
if run IMAGE_PREFIXES="quay.io/me" $P prefixes 2>/dev/null; then fail "a registry with no login step must fail"; fi
if run IMAGE_PREFIXES="docker.io/me" $P prefixes 2>/dev/null; then fail "nothing left to publish to must fail"; fi

# Images: the runner image is not in the default set (it holds Claude Code until BOS-972).
run $P images | grep -qx boss-man-runner && fail "runner must not be published by default"
[ "$(run $P images | wc -l)" = 3 ] || fail "three images by default"
if run PUBLISH_IMAGES="evil" $P images 2>/dev/null; then fail "unknown image must fail"; fi
[ "$(run $P dockerfile boss-man-netguard)" = apps/netguard/Dockerfile ] || fail "dockerfile path"
[ "$(run $P tag 0123456789abcdef0123456789abcdef01234567)" = sha-0123456789ab ] || fail "tag"

# Copy: the second registry gets the same digest; a different digest fails.
export_state() { echo "$D1" >"$S/state/ghcr.io_me_boss-man-server_sha-0123456789ab"; }
export_state
run IMAGE_PREFIXES="ghcr.io/me docker.io/me2" DOCKERHUB_PUBLISH=true DOCKERHUB_USERNAME=u DOCKERHUB_TOKEN=t $P copy boss-man-server sha-0123456789ab "$D1" >/dev/null || fail "copy"
[ "$(cat "$S/state/docker.io_me2_boss-man-server_sha-0123456789ab")" = "$D1" ] || fail "copy digest"
if run FAKE_BAD_COPY=docker.io IMAGE_PREFIXES="ghcr.io/me docker.io/me2" DOCKERHUB_PUBLISH=true DOCKERHUB_USERNAME=u DOCKERHUB_TOKEN=t $P copy boss-man-server sha-0123456789ab "$D1" 2>"$S/err"; then fail "different digests must fail"; fi
grep -q "digest" "$S/err" || fail "the mismatch must be explained"
if run IMAGE_PREFIXES="ghcr.io/me" $P copy boss-man-server sha-0123456789ab "$D2" 2>/dev/null; then fail "a digest that is not the pushed one must fail"; fi

# Verify: signature, SBOM and provenance in every registry.
V="IMAGE_PREFIXES=ghcr.io/me docker.io/me2"
run "$V" DOCKERHUB_PUBLISH=true DOCKERHUB_USERNAME=u DOCKERHUB_TOKEN=t $P verify boss-man-server "$D1" >/dev/null || fail "verify should pass"
if run "$V" DOCKERHUB_PUBLISH=true DOCKERHUB_USERNAME=u DOCKERHUB_TOKEN=t FAKE_NO_SIG=1 $P verify boss-man-server "$D1" 2>/dev/null; then fail "no signature must fail"; fi
if run "$V" DOCKERHUB_PUBLISH=true DOCKERHUB_USERNAME=u DOCKERHUB_TOKEN=t FAKE_SBOM='{"linux/amd64":{"x":1}}' $P verify boss-man-server "$D1" 2>"$S/err"; then fail "an SBOM missing for arm64 must fail"; fi
grep -q "SBOM for linux/arm64" "$S/err" || fail "the missing SBOM must be named"

# release.json: digest per image and per architecture, both registries agree.
for n in server launcher netguard; do echo "$D1" >"$S/state/ghcr.io_me_boss-man-${n}_sha-0123456789ab"; echo "$D1" >"$S/state/docker.io_me2_boss-man-${n}_sha-0123456789ab"; done
REAL_COMMIT=$(git rev-parse HEAD) # release-json reads the Claude pack lockfile at the commit being released
WANT_PACK=$(sha256sum apps/runner/claude-pack/package-lock.json | cut -c1-24)
json=$(run "$V" DOCKERHUB_PUBLISH=true DOCKERHUB_USERNAME=u DOCKERHUB_TOKEN=t $P release-json 0.1.0-beta.1 "$REAL_COMMIT" sha-0123456789ab)
# BOS-1225: the signed release also names the Claude pack hash (same rule as the runner's lockHash) and the install layout.
echo "$json" | jq -e --arg h "$WANT_PACK" '.packHash == $h and (.packHash | test("^[0-9a-f]{24}$")) and .installLayout == 1' >/dev/null || fail "release.json must carry packHash and installLayout: $json"
if run "$V" DOCKERHUB_PUBLISH=true DOCKERHUB_USERNAME=u DOCKERHUB_TOKEN=t $P release-json 0.1.0-beta.1 0123456789abcdef0123456789abcdef01234567 sha-0123456789ab 2>"$S/err"; then fail "a commit without the pack lockfile must fail"; fi
grep -q "Claude pack" "$S/err" || fail "the missing lockfile must be explained"
# The updater image is a known name with its own Dockerfile, and is not published until PUBLISH_IMAGES lists it.
[ "$(run $P dockerfile boss-man-updater)" = apps/updater/Dockerfile ] || fail "updater dockerfile path"
run PUBLISH_IMAGES="boss-man-server boss-man-updater" $P images | grep -qx boss-man-updater || fail "the updater image must be publishable"
run $P images | grep -qx boss-man-updater && fail "the updater must not be published until PUBLISH_IMAGES lists it"
echo "$json" | jq -e --arg d "$D1" --arg a "$DA" --arg b "$DB" '.schema == 1 and .version == "0.1.0-beta.1" and (.images | length) == 3 and .images[0].digest == $d and .images[0].platforms["linux/amd64"] == $a and .images[0].platforms["linux/arm64"] == $b and (.images[0].platforms | length) == 2 and (.registries | length) == 2' >/dev/null || fail "release.json shape: $json"
echo "$D2" >"$S/state/docker.io_me2_boss-man-launcher_sha-0123456789ab"
if run "$V" DOCKERHUB_PUBLISH=true DOCKERHUB_USERNAME=u DOCKERHUB_TOKEN=t $P release-json 0.1.0 "$REAL_COMMIT" sha-0123456789ab 2>/dev/null; then fail "registries that disagree must fail"; fi
if run "$V" $P release-json latest 0123456789abcdef0123456789abcdef01234567 sha-0123456789ab 2>/dev/null; then fail "a bad version must fail"; fi
# resolve-commit: blank = main's head; a typed commit must be 40 hex and on main (a branch-only commit is refused).
G="$S/repo"; mkdir -p "$G"
git_t() { git -C "$G" -c user.name=t -c user.email=t@example.com "$@"; }
git_t init -q -b main; git_t commit -q --allow-empty -m one; OLD=$(git_t rev-parse HEAD)
git_t commit -q --allow-empty -m two; HEAD_SHA=$(git_t rev-parse HEAD)
git_t update-ref refs/remotes/origin/main "$HEAD_SHA"
git_t checkout -q -b side "$OLD"; git_t commit -q --allow-empty -m branch-only; SIDE=$(git_t rev-parse HEAD)
rc() { (cd "$G" && env -i PATH="$PATH" "$OLDPWD/$P" resolve-commit "$@"); }
[ "$(rc "" "$HEAD_SHA")" = "$HEAD_SHA" ] || fail "blank commit must give the default (main's head)"
[ "$(rc "$OLD" "$HEAD_SHA")" = "$OLD" ] || fail "an older commit on main must be accepted"
if rc "$SIDE" "$HEAD_SHA" 2>"$S/err"; then fail "a commit not on main must be refused"; fi
grep -q "not on main" "$S/err" || fail "the refusal must say the commit is not on main"
if rc "${OLD:0:12}" "$HEAD_SHA" 2>"$S/err"; then fail "a short sha must be refused"; fi
grep -q "40-character" "$S/err" || fail "the refusal must say 40 characters"
if rc "$(printf 'A%.0s' {1..40})" "$HEAD_SHA" 2>/dev/null; then fail "non-hex-lowercase must be refused"; fi
if rc "$(printf '0%.0s' {1..40})" "$HEAD_SHA" 2>"$S/err"; then fail "an unknown commit must be refused"; fi
grep -q "not in this repository" "$S/err" || fail "the refusal must say the commit is unknown"
# version-commit (BOS-2602): the commit whose images already carry a version, from their revision label.
C1=$(printf 'c%.0s' {1..40}); C2=$(printf 'd%.0s' {1..40})
vc() { run IMAGE_PREFIXES="ghcr.io/vc" $P version-commit "$@"; }
[ -z "$(vc 0.1.0-beta.2)" ] || fail "a version no image carries must give nothing (main's newest is used)"
for n in server launcher netguard; do echo "$D1" >"$S/state/ghcr.io_vc_boss-man-${n}_0.1.0-beta.2"; echo "$C1" >"$S/state/rev_ghcr.io_vc_boss-man-${n}_0.1.0-beta.2"; done
[ "$(vc 0.1.0-beta.2)" = "$C1" ] || fail "a half-finished release must resume on the commit its images were tagged from"
echo "$C2" >"$S/state/rev_ghcr.io_vc_boss-man-launcher_0.1.0-beta.2"
if vc 0.1.0-beta.2 >/dev/null 2>"$S/err"; then fail "images of one version naming two commits must fail"; fi
grep -q "different commits" "$S/err" || fail "the disagreement must be explained"
rm "$S/state/rev_ghcr.io_vc_boss-man-launcher_0.1.0-beta.2"
if vc 0.1.0-beta.2 >/dev/null 2>"$S/err"; then fail "a tagged image with no revision label must fail, not guess"; fi
grep -q "no org.opencontainers.image.revision label" "$S/err" || fail "the missing label must be named"
# release.yml resolves the commit after the registry login (private images), and a blank box uses version-commit.
awk '/registry: ghcr.io/{l=NR} /version-commit/{v=NR} END{exit !(l && v && l < v)}' .github/workflows/release.yml || fail "release.yml must call version-commit after the ghcr login"
# Every refusal before tagging is an annotation (the job log is not readable by agents).
if grep -nE 'echo "[^"]*Pick a new version[^"]*"; exit 1' .github/workflows/release.yml >/dev/null; then fail "a release.yml refusal is printed to the log only"; fi
# release.yml must take its commit from resolve-commit, never trust the raw input or use GITHUB_SHA past it.
grep -q "resolve-commit" .github/workflows/release.yml || fail "release.yml must call resolve-commit"
grep -q 'inputs.commit' .github/workflows/release.yml || fail "release.yml must have the commit input"
if grep -n 'GITHUB_SHA' .github/workflows/release.yml | grep -v 'resolve-commit' | grep -v '^[0-9]*: *#' >/dev/null; then fail "release.yml uses GITHUB_SHA outside resolve-commit"; fi
# BOS-2590: the Release image check names every missing image and says to re-run Publish after PUBLISH_IMAGES grew.
grep -qF "missing=\"\$missing \$name\"" .github/workflows/release.yml || fail "release.yml must collect every image missing for the commit"
grep -q 'Re-run all jobs' .github/workflows/release.yml || fail "release.yml must tell the owner to re-run Publish images"
echo "publish-images.test.sh: ok"
