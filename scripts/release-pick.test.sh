#!/usr/bin/env bash
# Tests for scripts/release-pick.sh and scripts/release-notes.sh (BOS-2662) with a fake gh, docker and cosign and a
# throw-away git repository: no GitHub, no registry, no network. Covers the three cases the weekly release must get
# right: a commit whose CI is red, a commit with a missing or unsigned image, and nothing new since the last release.
# For the notes, it checks the added lines, the closing signed-files sentence, and the "What's new" pointer line taken
# from SITE_URL (BOS-2903).
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
S="$(mktemp -d)"; trap 'rm -rf "$S"' EXIT
fail() { echo "release-pick.test.sh: FAIL: $*" >&2; exit 1; }
mkdir -p "$S/bin" "$S/fake/ci" "$S/fake/img" "$S/fake/noarm" "$S/fake/unsigned"

# --- fakes ------------------------------------------------------------------------------------------------------------
cat >"$S/bin/gh" <<'EOF'
#!/usr/bin/env bash
case "$1 $2" in
  "release list") cat "$FAKE/releases.json" ;;
  "api repos/acme/boss-man/releases/tags/"*) cat "$FAKE/target" ;;
  "api repos/acme/boss-man/actions/workflows/ci.yml/runs?head_sha="*)
    sha="${2#*head_sha=}"; sha="${sha%%&*}"
    if [ -e "$FAKE/ci/$sha" ]; then echo 1; else echo 0; fi ;;
  *) echo "fake gh: unexpected: $*" >&2; exit 99 ;;
esac
EOF
# The digest of an image is a hash of its tag, so a test can mark one image's digest as lacking arm64 or a signature.
cat >"$S/bin/docker" <<'EOF'
#!/usr/bin/env bash
[ "$1 $2" = "buildx imagetools" ] && [ "$3" = inspect ] || exit 99
ref="$4"; fmt="${5:-}"
dig() { echo "sha256:$(printf '%s' "$1" | sha256sum | cut -c1-64)"; }
case "$ref" in
  *@*) d="${ref#*@}" ;;
  *) tag="${ref##*:}"; name="${ref%:*}"; name="${name##*/}"
     [ -e "$FAKE/img/${name}_$tag" ] || { echo "not found" >&2; exit 1; }
     d="$(dig "$name:$tag")" ;;
esac
case "$fmt" in
  --raw)
    if [ -e "$FAKE/noarm/$d" ]; then
      echo '{"manifests":[{"platform":{"os":"linux","architecture":"amd64"}}]}'
    else
      echo '{"manifests":[{"platform":{"os":"linux","architecture":"amd64"}},{"platform":{"os":"linux","architecture":"arm64"}}]}'
    fi ;;
  --format) case "$6" in
    '{{json .Manifest}}') printf '{"digest":"%s"}\n' "$d" ;;
    *) echo '{"linux/amd64":{"x":1},"linux/arm64":{"x":1}}' ;;
    esac ;;
  *) exit 97 ;;
esac
EOF
cat >"$S/bin/cosign" <<'EOF'
#!/usr/bin/env bash
last="${*: -1}"
[ ! -e "$FAKE/unsigned/${last##*@}" ]
EOF
chmod +x "$S/bin/gh" "$S/bin/docker" "$S/bin/cosign"
# BOS-2666: the docs rule has its own tests (release-docs-gate.test.sh). Here a fake gate says "covered" unless the commit
# is marked in fake/uncovered, so the pick's handling of an uncovered commit is tested on its own.
mkdir -p "$S/fake/uncovered"
cat >"$S/bin/fake-gate" <<'EOF'
#!/usr/bin/env bash
[ "$1" = covered ] || exit 99
if [ -e "$FAKE/uncovered/$2" ]; then echo "docs were last checked up to 0123456789ab, and a later commit changed x" >&2; exit 1; fi
EOF
chmod +x "$S/bin/fake-gate"

# --- a throw-away repository: c1 (the last release) .. c4 (main's head) ------------------------------------------------
G="$S/repo"; mkdir -p "$G"
git -C "$G" init -q -b main
git -C "$G" config user.email t@example.com; git -C "$G" config user.name t
printf "# What's new\n\n## 1 January 2026\n\n- Old line.\n" >"$G/CHANGELOG.md"
git -C "$G" add -A; git -C "$G" commit -qm c1
printf "# What's new\n\n## 8 January 2026\n\n- New line one.\n\n## 1 January 2026\n\n- Old line.\n" >"$G/CHANGELOG.md"
git -C "$G" commit -qam c2
echo x >"$G/x"; git -C "$G" add -A; git -C "$G" commit -qm c3
printf "# What's new\n\n## 8 January 2026\n\n- New line one.\n- New line two.\n\n## 1 January 2026\n\n- Old line.\n" >"$G/CHANGELOG.md"
git -C "$G" commit -qam c4
C1="$(git -C "$G" rev-parse HEAD~3)"; C2="$(git -C "$G" rev-parse HEAD~2)"; C3="$(git -C "$G" rev-parse HEAD~1)"; C4="$(git -C "$G" rev-parse HEAD)"
git -C "$G" update-ref refs/remotes/origin/main "$C4"

tagof() { echo "sha-${1:0:12}"; }
dig() { echo "sha256:$(printf '%s' "$1" | sha256sum | cut -c1-64)"; }
reset() {
  rm -f "$S/fake/uncovered/"* "$S/fake/ci/"* "$S/fake/img/"* "$S/fake/noarm/"* "$S/fake/unsigned/"*
  echo '[{"tagName":"v0.1.0-beta.1"},{"tagName":"v0.1.0-beta.3"},{"tagName":"v0.1.0-beta.10"},{"tagName":"v0.1.0-rc"}]' >"$S/fake/releases.json"
  echo "$C1" >"$S/fake/target"
}
# A commit that is fully good: CI passed, both images published.
good() { touch "$S/fake/ci/$1" "$S/fake/img/boss-man-server_$(tagof "$1")" "$S/fake/img/boss-man-launcher_$(tagof "$1")"; }
pick() { (cd "$G" && env -i PATH="$S/bin:$PATH" HOME="$S" FAKE="$S/fake" RELEASE_DOCS_GATE_SH="$S/bin/fake-gate" GITHUB_REPOSITORY=acme/boss-man GITHUB_REPOSITORY_OWNER=acme \
  PUBLISH_IMAGES="boss-man-server boss-man-launcher" "$REPO_ROOT/scripts/release-pick.sh" pick 2>"$S/err"); }
field() { echo "$1" | sed -n "s/^$2=//p"; }

# 1. Everything good: the newest commit, the next beta by number (beta.10 -> beta.11, not by date or text order).
reset; good "$C4"
out="$(pick)"
[ "$(field "$out" sha)" = "$C4" ] || fail "should pick the newest good commit, got: $out"
[ "$(field "$out" version)" = "0.1.0-beta.11" ] || fail "version should be 0.1.0-beta.11, got: $out"
[ "$(field "$out" tag)" = "$(tagof "$C4")" ] || fail "tag"
[ "$(field "$out" prev_sha)" = "$C1" ] || fail "prev_sha should be the last release's commit"

# 2. Red commit: CI has not passed on the head, so an older good commit is chosen; the head is never released.
reset; good "$C3"; touch "$S/fake/img/boss-man-server_$(tagof "$C4")" "$S/fake/img/boss-man-launcher_$(tagof "$C4")"
out="$(pick)"
[ "$(field "$out" sha)" = "$C3" ] || fail "a commit without a passed CI must be skipped, got: $out"
grep -q "main CI has not passed" "$S/err" || fail "the reason for skipping the red commit should be printed"

# 3. A missing image (launcher) on the head: skipped.
reset; good "$C3"; touch "$S/fake/ci/$C4" "$S/fake/img/boss-man-server_$(tagof "$C4")"
out="$(pick)"
[ "$(field "$out" sha)" = "$C3" ] || fail "a commit with a missing image must be skipped, got: $out"
grep -q "no boss-man-launcher image" "$S/err" || fail "the missing image should be named"

# 3b. An image without arm64 is partly published: skipped.
reset; good "$C3"; good "$C4"; touch "$S/fake/noarm/$(dig "boss-man-server:$(tagof "$C4")")"
out="$(pick)"
[ "$(field "$out" sha)" = "$C3" ] || fail "an image missing arm64 must be skipped, got: $out"

# 3c. An unsigned image is skipped.
reset; good "$C3"; good "$C4"; touch "$S/fake/unsigned/$(dig "boss-man-launcher:$(tagof "$C4")")"
out="$(pick)"
[ "$(field "$out" sha)" = "$C3" ] || fail "an unsigned image must be skipped, got: $out"

# 4. No commit qualifies: one skip line, no sha, so no release.
reset; touch "$S/fake/ci/$C4"
out="$(pick)"
[ "$(echo "$out" | wc -l)" = 1 ] || fail "a skip is exactly one line, got: $out"
case "$out" in skip=Weekly\ release\ skipped:*) ;; *) fail "should skip with a reason, got: $out" ;; esac
[ -z "$(field "$out" sha)" ] || fail "a skip must name no commit"

# 5. Nothing new: the best commit is the last release's own commit (or older than it).
reset; good "$C1"; good "$C2"; echo "$C2" >"$S/fake/target"
out="$(pick)"
case "$out" in skip=*"nothing new"*"v0.1.0-beta.10"*) ;; *) fail "should skip with nothing new, got: $out" ;; esac
[ -z "$(field "$out" sha)" ] || fail "nothing new must name no commit"
echo "$C3" >"$S/fake/target"   # released from a newer commit than the best good one
out="$(pick)"
case "$out" in skip=*"nothing new"*) ;; *) fail "an older commit than the last release is nothing new, got: $out" ;; esac

# 6. No release yet: starts at 0.1.0-beta.1 with no previous commit.
reset; good "$C4"; echo '[]' >"$S/fake/releases.json"
out="$(pick)"
[ "$(field "$out" version)" = "0.1.0-beta.1" ] || fail "first beta should be 0.1.0-beta.1, got: $out"
[ -z "$(field "$out" prev_sha)" ] || fail "no previous commit"

# 7. The depth limit: only the newest RELEASE_PICK_DEPTH commits are looked at.
reset; good "$C2"
out="$( (cd "$G" && env -i PATH="$S/bin:$PATH" HOME="$S" FAKE="$S/fake" RELEASE_DOCS_GATE_SH="$S/bin/fake-gate" GITHUB_REPOSITORY=acme/boss-man GITHUB_REPOSITORY_OWNER=acme \
  PUBLISH_IMAGES="boss-man-server boss-man-launcher" RELEASE_PICK_DEPTH=1 "$REPO_ROOT/scripts/release-pick.sh" pick 2>/dev/null) )"
case "$out" in skip=*) ;; *) fail "depth 1 looks only at the head, got: $out" ;; esac

# 8. BOS-2666 docs rule. The head is green with images but has no recorded docs check: the newest covered commit is released.
reset; good "$C3"; good "$C4"; touch "$S/fake/uncovered/$C4"
out="$(pick)"
[ "$(field "$out" sha)" = "$C3" ] || fail "an uncovered head must give way to the newest covered commit, got: $out"
grep -q "docs were last checked" "$S/err" || fail "the docs reason should be printed"
# 8b. Nothing is covered and the newest green commit is new since the last release: a refusal (the run fails), not a skip.
reset; good "$C3"; good "$C4"; touch "$S/fake/uncovered/$C3" "$S/fake/uncovered/$C4"
out="$(pick)"
case "$out" in refuse=*"docs check"*) ;; *) fail "uncovered green commits must be refused, got: $out" ;; esac
[ "$(echo "$out" | wc -l)" = 1 ] || fail "a refusal is exactly one line, got: $out"
[ -z "$(field "$out" sha)" ] || fail "a refusal must name no commit"
# 8c. The only uncovered commit is the last release's own (nothing new anyway): a quiet skip, not a refusal.
reset; good "$C1"; touch "$S/fake/uncovered/$C1" "$S/fake/ci/$C1"
out="$(pick)"
case "$out" in skip=*) ;; *) fail "nothing new since the release is a skip, got: $out" ;; esac

# --- notes -------------------------------------------------------------------------------------------------------------
N="$REPO_ROOT/scripts/release-notes.sh"
notes="$(cd "$G" && "$N" "$C1" "$C4")"
echo "$notes" | grep -qx -- "- New line one." || fail "notes should hold the first added line: $notes"
echo "$notes" | grep -qx -- "- New line two." || fail "notes should hold the second added line: $notes"
echo "$notes" | grep -q "Old line" && fail "notes must not repeat lines the last release already had"
echo "$notes" | grep -q "release.json.sigstore.json" || fail "notes should keep the signed-files sentence"
# Only lines added after the previous release: c2 -> c4 gives line two only.
notes="$(cd "$G" && "$N" "$C2" "$C4")"
echo "$notes" | grep -qx -- "- New line two." || fail "c2..c4 should hold line two"
echo "$notes" | grep -q "New line one" && fail "c2..c4 must not hold line one"
# No change to the file, an empty previous commit and an unknown commit all give the plain sentence, never a failure.
notes="$(cd "$G" && "$N" "$C3" "$C3")"; echo "$notes" | grep -q "No changes you will notice" || fail "no new lines should say so"
notes="$(cd "$G" && "$N" "" "$C4")"; echo "$notes" | grep -q "No changes you will notice" || fail "no previous commit should say so"
notes="$(cd "$G" && "$N" "0123456789abcdef0123456789abcdef01234567" "$C4")"; echo "$notes" | grep -q "No changes you will notice" || fail "an unknown previous commit should not fail the release"

# BOS-2903: one "What's new" pointer line at the end, from the configured site address (SITE_URL), never a host in the repo.
grep -Eq "https://[a-z0-9]" "$N" && fail "release-notes.sh must not hardcode a site address, it comes from SITE_URL"
notes="$(cd "$G" && SITE_URL=https://example.test "$N" "$C1" "$C4")"
echo "$notes" | tail -n1 | grep -qx "Built from source? You get each change as soon as it is added. Update your server to pick it up. What's new shows which image has each change: https://example.test/whats-new" \
  || fail "the last line should be the What's new pointer, got: $notes"
# The words match the website's "Built from source" explainer box (apps/site/scripts/build.mjs), so the two never drift.
box="$(grep -o 'Built from source</h3><p>You get each change as soon as it is added[^<]*' "$REPO_ROOT/apps/site/scripts/build.mjs" | sed 's/.*<p>//')"
if [ -z "$box" ]; then fail "could not read the Built from source explainer box from build.mjs"; fi
echo "$notes" | grep -qF "$box" || fail "the pointer should keep the explainer box's words: $box"
# A trailing slash on the address is trimmed, so the link is never ...//whats-new.
notes="$(cd "$G" && SITE_URL=https://example.test/ "$N" "$C1" "$C4")"
echo "$notes" | grep -q "https://example.test/whats-new$" || fail "a trailing slash should be trimmed: $notes"
# An address that is not https does not go into the notes: the line is left out rather than ship a link that cannot work.
notes="$(cd "$G" && SITE_URL=http://example.test "$N" "$C1" "$C4")"
echo "$notes" | grep -q "What's new shows" && fail "an address that is not https must not be linked: $notes"
# No address (a fork has no website): no pointer line, and the notes still print.
notes="$(cd "$G" && env -u SITE_URL "$N" "$C1" "$C4")"
echo "$notes" | grep -q "What's new shows" && fail "with no SITE_URL there should be no pointer: $notes"
echo "$notes" | grep -qx -- "- New line one." || fail "with no SITE_URL the notes should still print: $notes"

# BOS-2903: the release job must pass SITE_URL to the notes step, or the pointer above never appears in a real release.
# The job runs in the `publish` environment, so it can only read a variable as ${{ vars.SITE_URL }} from the repository or
# that environment; a secret, or the `site` environment's copy the website publish uses, would never reach it.
wf="$REPO_ROOT/.github/workflows/release.yml"
grep -Eq '^      SITE_URL: \$\{\{ vars\.SITE_URL \}\}$' "$wf" \
  || fail "release.yml must pass SITE_URL from a variable (vars.SITE_URL) to the release step that writes the notes"
awk '/^  [a-z][a-z-]*:$/{job=$1} job=="release:" && /^    environment:/{print; exit}' "$wf" | grep -qx '    environment: publish' \
  || fail "release.yml's release job should still run in the publish environment"

echo "release-pick.test.sh: ok"
