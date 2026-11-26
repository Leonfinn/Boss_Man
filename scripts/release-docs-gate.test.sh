#!/usr/bin/env bash
# Tests for scripts/release-docs-gate.sh (BOS-2666) on a throw-away git repository with a fake gh: no GitHub, no network.
# One passing release and one fixture for each way the gate refuses: an older stage word, empty What's new, a stale or
# missing "Docs checked up to" line; plus the About text, the stage helper and the previous-release lookup.
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
GATE="$REPO_ROOT/scripts/release-docs-gate.sh"
S="$(mktemp -d)"; trap 'rm -rf "$S"' EXIT
fail() { echo "release-docs-gate.test.sh: FAIL: $*" >&2; exit 1; }
mkdir -p "$S/bin" "$S/fake"

cat >"$S/bin/gh" <<'EOF'
#!/usr/bin/env bash
case "$1 $2" in
  "release list") cat "$FAKE/releases.json" | jq -r 'if length > 0 then .[0].tagName else "" end' ;;
  "api repos/acme/boss-man") cat "$FAKE/about" ;;
  "api repos/acme/boss-man/releases/tags/"*) cat "$FAKE/target" ;;
  *) echo "fake gh: unexpected: $*" >&2; exit 99 ;;
esac
EOF
chmod +x "$S/bin/gh"

# Fake gh answers --jq itself above; the real flag handling is not needed. "release list" prints the newest tag.
echo '[{"tagName":"v0.1.0-beta.2"}]' >"$S/fake/releases.json"
echo "A tool for running a company of agents" >"$S/fake/about"

G="$S/repo"; mkdir -p "$G/docs" "$G/apps/site/src" "$G/apps/server/src"
git -C "$G" init -q -b main
git -C "$G" config user.email t@example.com; git -C "$G" config user.name t
changelog() { # $1 = checked sha line (or empty), $2 = bullet lines
  { printf "# What's new\n\n"; [ -z "$1" ] || printf '<!-- Docs checked up to %s -->\n\n' "$1"; printf '## 8 January 2026\n\n%s\n\n## 1 January 2026\n\n- Old line.\n' "$2"; } >"$G/CHANGELOG.md"
}
commit() { git -C "$G" add -A; git -C "$G" commit -qm "$1"; git -C "$G" rev-parse HEAD; }

echo "Status: beta. Old docs once said an earlier stage." >"$G/README.md"
echo "Install guide." >"$G/docs/01-install.md"
echo "Welcome." >"$G/apps/site/src/index.html"
echo '{"name":"x","description":"A tool","version":"1.0.0-alpha.1"}' >"$G/package.json"
echo "code 1" >"$G/apps/server/src/a.ts"
changelog "" ""
PREV="$(commit "release 2: the last release")"
echo "$PREV" >"$S/fake/target"

# A code change after the last release, then Brian checks the docs against it and writes the line, then a docs commit.
echo "code 2" >"$G/apps/server/src/a.ts"; CODE="$(commit "code change")"
changelog "$CODE" "- A new thing you will notice."
GOOD="$(commit "docs: changelog, docs checked up to the code change")"

run() { # version sha [prev]
  (cd "$G" && env -i PATH="$S/bin:$PATH" HOME="$S" FAKE="$S/fake" GITHUB_REPOSITORY=acme/boss-man "$GATE" check "$@" 2>&1)
}

# --- stage helper ---------------------------------------------------------------------------------------------------
for pair in "0.1.0-alpha.3:alpha" "0.1.0-beta.1:beta" "0.2.0-rc.2:rc" "1.0.0:stable" "0.1.0-beta:beta"; do
  [ "$("$GATE" stage-of "${pair%%:*}")" = "${pair##*:}" ] || fail "stage-of ${pair%%:*} should be ${pair##*:}"
done
"$GATE" stage-of 1.0.0-nightly.1 >/dev/null 2>&1 && fail "an unknown stage must not be guessed"
"$GATE" stage-of banana >/dev/null 2>&1 && fail "a non-version must fail"

# --- 1. a passing release -------------------------------------------------------------------------------------------
out="$(run 0.1.0-beta.3 "$GOOD" "$PREV")" || fail "a clean release should pass: $out"
echo "$out" | grep -q "ok for 0.1.0-beta.3 (beta)" || fail "pass line: $out"
# The recorded sha may be an abbreviation too, and the release commit may be the checked commit itself.
(cd "$G" && "$GATE" covered "$GOOD") || fail "covered should pass for the good commit"

# --- 2. old stage word ----------------------------------------------------------------------------------------------
echo "Status: alpha. Expect rough edges." >"$G/README.md"
changelog "$CODE" "- A new thing you will notice."
echo "A line about Alpha builds." >>"$G/docs/01-install.md"
echo "This one is a deliberate mention. release-docs-ok alpha" >>"$G/docs/01-install.md"
BAD1="$(commit "docs still say alpha")"
out="$(run 0.1.0-beta.3 "$BAD1" "$PREV")" && fail "an old stage word must fail"
echo "$out" | grep -q "^README.md:1: still says an older stage" || fail "README line should be named: $out"
echo "$out" | grep -q "^docs/01-install.md:2:" || fail "the docs line should be named: $out"
echo "$out" | grep -q "01-install.md:3" && fail "a release-docs-ok line must be left alone"
echo "$out" | tail -n 1 | grep -q "^Release blocked: stage wording" || fail "one-line reason last: $out"
# The same wording is fine when releasing an alpha (it is not an older stage).
run 0.1.0-alpha.9 "$BAD1" "$PREV" >/dev/null || fail "alpha wording is not wrong for an alpha release"
# A package.json description is read; a version string in it is not.
echo '{"name":"x","description":"An alpha tool","version":"1.0.0-alpha.1"}' >"$G/package.json"
echo "Status: beta." >"$G/README.md"
printf "Install guide.\n" >"$G/docs/01-install.md"
CODE="$(commit "package description says alpha")"   # package.json is not a docs file: the docs check is recorded again
changelog "$CODE" "- A new thing you will notice."
BAD1B="$(commit "docs checked again")"
out="$(run 0.1.0-beta.3 "$BAD1B" "$PREV")" && fail "a package.json description with an old stage must fail"
echo "$out" | grep -q "^package.json:1:" || fail "package.json should be named: $out"
# The allow list excuses a named line, with a reason.
printf 'package.json | An alpha tool | the product is described in historical terms (test)\n' >"$S/allow.txt"
(cd "$G" && env -i PATH="$S/bin:$PATH" HOME="$S" FAKE="$S/fake" GITHUB_REPOSITORY=acme/boss-man RELEASE_DOCS_ALLOW="$S/allow.txt" "$GATE" check 0.1.0-beta.3 "$BAD1B" "$PREV") >/dev/null 2>&1 \
  || fail "an allow-listed mention should pass"
echo '{"name":"x","description":"A tool","version":"1.0.0-alpha.1"}' >"$G/package.json"
CODE="$(commit "wording fixed")"
changelog "$CODE" "- A new thing you will notice."
FIXED="$(commit "docs checked again")"
run 0.1.0-beta.3 "$FIXED" "$PREV" >/dev/null || fail "after the fix the gate passes"

# --- 3. the GitHub About text ---------------------------------------------------------------------------------------
echo "An alpha tool for running a company of agents" >"$S/fake/about"
out="$(run 0.1.0-beta.3 "$FIXED" "$PREV")" && fail "an About text with an old stage must fail"
echo "$out" | grep -q "Only the owner can change it" || fail "About failure must say only the owner can change it: $out"
echo "A tool for running a company of agents" >"$S/fake/about"

# --- 4. empty What's new --------------------------------------------------------------------------------------------
changelog "$CODE" ""
EMPTY="$(commit "no new entries")"
out="$(run 0.1.0-beta.3 "$EMPTY" "$PREV")" && fail "empty What's new must fail"
echo "$out" | tail -n 1 | grep -q "What's new is empty" || fail "reason should say What's new is empty: $out"
# Without a previous release the whole file counts: it has the old line, so it is not empty.
run 0.1.0-beta.1 "$EMPTY" "" >/dev/null || fail "a first release with entries in the file passes"

# --- 5. a stale or missing docs-checked line ------------------------------------------------------------------------
changelog "$PREV" "- A new thing you will notice."   # checked only up to the old release: the code change since is unchecked
STALE="$(commit "stale docs line")"
out="$(run 0.1.0-beta.3 "$STALE" "$PREV")" && fail "a stale docs line must fail"
echo "$out" | tail -n 1 | grep -q "docs check not recorded" || fail "reason should say the docs check is not recorded: $out"
echo "$out" | grep -q "a later commit changed .* which is not a docs file" || fail "the offending code file should be named: $out"
changelog "" "- A new thing you will notice."
NOLINE="$(commit "no docs line")"
out="$(run 0.1.0-beta.3 "$NOLINE" "$PREV")" && fail "a missing docs line must fail"
echo "$out" | grep -q "no line" || fail "should say the line is missing: $out"
changelog "0123456789abcdef0123456789abcdef01234567" "- A new thing you will notice."
UNKNOWN="$(commit "docs line names a commit that is not in history")"
out="$(run 0.1.0-beta.3 "$UNKNOWN" "$PREV")" && fail "an unknown checked sha must fail"
echo "$out" | grep -q "not in this repository's history" || fail "should say the sha is unknown: $out"
# A docs-only change after the checked commit is fine (that is Brian's own commit), a code change is not.
changelog "$CODE" "- A new thing you will notice."
echo "more docs" >>"$G/docs/01-install.md"; echo "<p>hi</p>" >>"$G/apps/site/src/index.html"
DOCSONLY="$(commit "more docs after the check")"
(cd "$G" && "$GATE" covered "$DOCSONLY") || fail "docs-only commits after the checked sha are covered"
echo "code 3" >"$G/apps/server/src/a.ts"; CODE3="$(commit "a later code change")"
(cd "$G" && "$GATE" covered "$CODE3") 2>/dev/null && fail "a code commit after the checked sha is not covered"

# --- 6. several problems: one line lists them all -------------------------------------------------------------------
echo "alpha status" >"$G/README.md"; changelog "" ""
ALL="$(commit "everything wrong")"
out="$(run 0.1.0-beta.3 "$ALL" "$PREV")" && fail "should fail"
last="$(echo "$out" | tail -n 1)"
for w in "stage wording" "What's new is empty" "docs check not recorded"; do
  echo "$last" | grep -q "$w" || fail "the one-line reason should list '$w': $last"
done
[ "$(echo "$last" | wc -l)" = 1 ] || fail "the reason is one line"

# --- 7. the previous release's commit -------------------------------------------------------------------------------
[ "$(cd "$G" && env -i PATH="$S/bin:$PATH" HOME="$S" FAKE="$S/fake" GITHUB_REPOSITORY=acme/boss-man "$GATE" prev)" = "$PREV" ] \
  || fail "prev should print the newest release's commit"
echo '[]' >"$S/fake/releases.json"
[ -z "$(cd "$G" && env -i PATH="$S/bin:$PATH" HOME="$S" FAKE="$S/fake" GITHUB_REPOSITORY=acme/boss-man "$GATE" prev)" ] || fail "no release gives an empty prev"

# --- 8. release-notes uses the stage word ---------------------------------------------------------------------------
notes="$(cd "$G" && RELEASE_VERSION=0.2.0-rc.1 "$REPO_ROOT/scripts/release-notes.sh" "$PREV" "$DOCSONLY")"
echo "$notes" | grep -q "What's new in this rc" || fail "notes heading should use the rc stage: $notes"

echo "release-docs-gate.test.sh: ok"
