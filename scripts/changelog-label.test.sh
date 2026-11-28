#!/usr/bin/env bash
# Tests for scripts/changelog-label.sh (BOS-2841) on a throw-away git repository: no GitHub, no network.
# One test per case: a release labels only its own lines, a re-run is a no-op, the docs gate's two-line refusal still
# fires on a labelled file, and the release gate passes a labelled commit and refuses an unlabelled one.
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
L="$REPO_ROOT/scripts/changelog-label.sh"
GATE="$REPO_ROOT/scripts/release-docs-gate.sh"
S="$(mktemp -d)"; trap 'rm -rf "$S"' EXIT
fail() { echo "changelog-label.test.sh: FAIL: $*" >&2; exit 1; }

G="$S/repo"; mkdir -p "$G"
git -C "$G" init -q -b main
git -C "$G" config user.email t@example.com; git -C "$G" config user.name t
commit() { git -C "$G" add -A; git -C "$G" commit -qm "$1"; git -C "$G" rev-parse HEAD; }
NOT_YET='**Not in an image yet:** comes with the next weekly image (Tuesdays).'

# Released earlier: 1 Dec holds an older image label. 8 Dec has a split day: newer lines not in an image, older ones in beta.3.
write_file() { # $1 = the lines under the 8 Dec "not yet" label
  cat >"$G/CHANGELOG.md" <<EOF
# What's new

<!-- Docs checked up to 0123456789abcdef0123456789abcdef01234567 -->

## 8 December 2026

$NOT_YET

$1

**In image 0.1.0-beta.3**

- Older line on the same day.

## 1 December 2026

**In image 0.1.0-beta.3**

- Old line.
EOF
}
write_file "- First new line."
prev="$(commit prev)"
write_file "- First new line.
- Second new line."
cur="$(commit cur)"
cp "$G/CHANGELOG.md" "$S/before.md"

# 1. Unlabelled: the release gate refuses, naming the line and saying what to do.
if out="$(cd "$G" && "$L" check 0.1.0-beta.4 "$prev" "$cur" 2>&1)"; then fail "the gate passed an unlabelled commit"; fi
echo "$out" | grep -q 'CHANGELOG.md:.*Not in an image yet' || fail "the refusal does not name the file and line: $out"
echo "$out" | tail -n 1 | grep -q 'label 0.1.0-beta.4' || fail "the last line does not say how to fix it: $out"

# 2. A release labels only its own lines.
(cd "$G" && "$L" label 0.1.0-beta.4 > "$S/label.out")
grep -q 'labelled 1 date section' "$S/label.out" || fail "expected one section labelled: $(cat "$S/label.out")"
[ "$(grep -c '^\*\*In image 0.1.0-beta.4\*\*$' "$G/CHANGELOG.md")" = 1 ] || fail "expected exactly one beta.4 label"
[ "$(grep -c '^\*\*In image 0.1.0-beta.3\*\*$' "$G/CHANGELOG.md")" = 2 ] || fail "an older label was touched"
grep -q 'Not in an image yet' "$G/CHANGELOG.md" && fail "a not-yet label is left"
# Everything else is byte for byte what it was: the diff is one line.
changed="$(diff "$S/before.md" "$G/CHANGELOG.md" | grep -c '^[<>]' || true)"
[ "$changed" = 2 ] || fail "more than the one label line changed ($changed diff lines)"

# 3. A re-run is a no-op (a resumed release cannot add a second label).
cp "$G/CHANGELOG.md" "$S/once.md"
(cd "$G" && "$L" label 0.1.0-beta.4 > "$S/label2.out")
grep -q 'labelled 0 date section' "$S/label2.out" || fail "re-run reported work: $(cat "$S/label2.out")"
cmp -s "$S/once.md" "$G/CHANGELOG.md" || fail "a re-run changed the file"
(cd "$G" && "$L" label 0.1.0-beta.5 > /dev/null)
cmp -s "$S/once.md" "$G/CHANGELOG.md" || fail "a later version relabelled an already labelled section"

# 4. A label with no entry under it is left alone.
printf '# x\n\n## 9 December 2026\n\n%s\n\n## 8 December 2026\n\n- A line.\n' "$NOT_YET" > "$S/empty.md"
"$L" label 0.1.0-beta.4 "$S/empty.md" > /dev/null
grep -q '^\*\*Not in an image yet' "$S/empty.md" || fail "an empty section was labelled"

# 5. The file's own rules still hold: one "Docs checked up to" line, dates valid and newest first.
[ "$(grep -c '^<!-- Docs checked up to [0-9a-f]\{40\} -->$' "$G/CHANGELOG.md")" = 1 ] || fail "the Docs checked line changed"
dates="$(sed -n 's/^## \([0-9]* [A-Za-z]* 20[0-9][0-9]\)$/\1/p' "$G/CHANGELOG.md")"
[ "$dates" = "$(printf '8 December 2026\n1 December 2026')" ] || fail "date headings changed: $dates"

# 6. The docs gate's own two-line refusal still fires on a labelled file (a second recorded check is still refused).
cur2="$(commit labelled)"
printf '\n<!-- Docs checked up to fedcba9876543210fedcba9876543210fedcba98 -->\n' >> "$G/CHANGELOG.md"
cur3="$(commit twochecks)"
if out="$(cd "$G" && RELEASE_PREV_SHA="$prev" "$GATE" check 0.1.0-beta.4 "$cur3" 2>&1)"; then fail "the docs gate passed a file with two checked lines"; fi
echo "$out" | grep -q 'exactly one' || fail "the docs gate did not refuse on the two lines: $out"

# 7. The release gate passes the labelled commit.
(cd "$G" && "$L" check 0.1.0-beta.4 "$prev" "$cur2") || fail "the gate refused a labelled commit"

# 8. A bad version is refused, nothing is written.
if "$L" label "not a version" "$S/empty.md" > "$S/bad.out" 2>&1; then fail "a bad version was accepted"; fi
grep -q 'is not like' "$S/bad.out" || fail "the bad-version refusal gave no reason: $(cat "$S/bad.out")"

echo "changelog-label.test.sh: all passed"
