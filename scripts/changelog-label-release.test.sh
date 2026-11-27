#!/usr/bin/env bash
# Tests for scripts/changelog-label-release.sh (BOS-2840) on a throw-away git repository: no GitHub, no network.
# The case that matters: Monday's docs check labelled an older commit, code merged after it, and the release FILE.
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
L="$REPO_ROOT/scripts/changelog-label-release.sh"
GATE="$REPO_ROOT/scripts/changelog-label.sh"
S="$(mktemp -d)"; trap 'rm -rf "$S"' EXIT
fail() { echo "changelog-label-release.test.sh: FAIL: $*" >&2; exit 1; }

G="$S/repo"; mkdir -p "$G"
git -C "$G" init -q -b main
git -C "$G" config user.email t@example.com; git -C "$G" config user.name t
commit() { git -C "$G" add -A; git -C "$G" commit -qm "$1"; git -C "$G" rev-parse HEAD; }
NOT_YET='**Not in an image yet:** comes with the next weekly image (Tuesdays).'
CHECK='<!-- Docs checked up to 0123456789abcdef0123456789abcdef01234567 -->'

# 30 Nov holds one entry from the last release (already labelled beta.3) and two newer ones still unlabelled.
write_file() {
  cat >"$G/CHANGELOG.md" <<EOF
# What's new

$CHECK

## 1 December 2026

$NOT_YET

$1

## 30 November 2026

inline split day marker

**In image 0.1.0-beta.3**

- Old line, already in beta.3.

## 27 November 2026

**In image 0.1.0-beta.3**

- Older line.

## 26 October 2026

- Very old line.
EOF
}
write_file "- New line one."
prev="$(commit prev)"
write_file "- New line one.
- New line two."
cur="$(commit cur)"
cp "$G/CHANGELOG.md" "$S/before.md"

# 1. The gate refuses the commit (this is the failure the helper exists for).
if out="$(cd "$G" && "$GATE" check 0.1.0-beta.4 "$prev" "$cur" 2>&1)"; then fail "the gate passed an unlabelled commit"; fi
echo "$out" | grep -q '01 December 2026\|CHANGELOG.md:.*Not in an image yet' || fail "the refusal names no line: $out"

# 2. The helper labels exactly what the release will list.
(cd "$G" && "$L" label-release 0.1.0-beta.4 "$prev" "$cur" > "$S/out")
grep -q 'labelled 1 section' "$S/out" || fail "expected one label written: $(cat "$S/out")"
[ "$(grep -c '^\*\*In image 0.1.0-beta.4\*\*$' "$G/CHANGELOG.md")" = 1 ] || fail "expected exactly one beta.4 label"
[ "$(grep -c '^\*\*In image 0.1.0-beta.3\*\*$' "$G/CHANGELOG.md")" = 2 ] || fail "an older label was touched"
grep -q 'Not in an image yet' "$G/CHANGELOG.md" && fail "a not-yet label is left"
# One line changed, everything else byte for byte.
changed="$(diff "$S/before.md" "$G/CHANGELOG.md" | grep -c '^[<>]' || true)"
[ "$changed" = 2 ] || fail "more than the one label line changed ($changed diff lines)"
grep -q '^\*\*In image 0.1.0-beta.4\*\*$' <<<"$(sed -n '/^## 1 December 2026/,/^## 30 November 2026/p' "$G/CHANGELOG.md")" || fail "the 1 Dec section got no label"
cmp -s <(grep -v '^\*\*\(In image\|Not in an image yet\)' "$S/before.md") <(grep -v '^\*\*\(In image\|Not in an image yet\)' "$G/CHANGELOG.md") || fail "a line other than a label changed"

# 3. A re-run is a no-op, and after the label is committed the gate passes it.
cp "$G/CHANGELOG.md" "$S/once.md"
(cd "$G" && "$L" label-release 0.1.0-beta.4 "$prev" "$cur" > /dev/null)
cmp -s "$S/once.md" "$G/CHANGELOG.md" || fail "a re-run changed the file"
labelled="$(commit labelled)"
(cd "$G" && "$GATE" check 0.1.0-beta.4 "$prev" "$labelled") || fail "the gate refused a labelled commit"

# 4. A day the weekly cut falls inside: only the newer released entries move, the older label stays.
cat >"$G/CHANGELOG.md" <<EOF
# What's new

$CHECK

## 2 December 2026

$NOT_YET

- Same day, newer line.

**In image 0.1.0-beta.3**

- Same day, older line.

## 1 December 2026

**In image 0.1.0-beta.3**

- Old line.
EOF
sprev="$(commit split-prev)"
cat >"$G/CHANGELOG.md" <<EOF
# What's new

$CHECK

## 2 December 2026

$NOT_YET

- Same day, newer line.
- Same day, newer line two.

**In image 0.1.0-beta.3**

- Same day, older line.

## 1 December 2026

**In image 0.1.0-beta.3**

- Old line.
EOF
scur="$(commit split-cur)"
(cd "$G" && "$L" label-release 0.1.0-beta.4 "$sprev" "$scur" > "$S/split")
grep -q 'labelled 1 section' "$S/split" || fail "expected one label on the split day: $(cat "$S/split")"
grep -q '^## 2 December 2026$' "$G/CHANGELOG.md" && grep -q '^\*\*In image 0.1.0-beta.4\*\*$' "$G/CHANGELOG.md" || fail "the split day got no beta.4 label"
[ "$(grep -c '^\*\*In image 0.1.0-beta.4\*\*$' "$G/CHANGELOG.md")" = 1 ] || fail "expected exactly one beta.4 label"
[ "$(grep -c '^\*\*In image 0.1.0-beta.3\*\*$' "$G/CHANGELOG.md")" = 2 ] || fail "the older label was touched"
echo "split file:"; sed -n '1,30p' "$G/CHANGELOG.md"
split_labelled="$(commit split-labelled)"
(cd "$G" && "$GATE" check 0.1.0-beta.4 "$sprev" "$split_labelled") || fail "the gate refused a labelled split day"
# 5. A section's own rules still hold and the file is unchanged elsewhere.
[ "$(grep -c '^<!-- Docs checked up to [0-9a-f]\{40\} -->$' "$G/CHANGELOG.md")" = 1 ] || fail "the Docs checked line changed"

# 6. A bad version is refused, nothing is written.
if "$L" label-release "not a version" "$prev" "$cur" > "$S/bad.out" 2>&1; then fail "a bad version was accepted"; fi
grep -q 'is not like' "$S/bad.out" || fail "the bad-version refusal gave no reason: $(cat "$S/bad.out")"

echo "changelog-label-release.test.sh: all passed"
