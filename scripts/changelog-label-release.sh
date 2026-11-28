#!/usr/bin/env bash
# Label one release's "What's new" entries at the commit that release is releasing (BOS-2840).
#
# The weekly release releases the newest commit whose docs check covers it and whose images are published. That commit is
# not always the one the Monday docs check labelled: code merged on Monday evening, or a Tuesday morning merge, becomes the
# commit released, and its new "What's new" entries carry no image label, so the Image label gate (BOS-2841) refuses the
# release. Nobody should have to notice that by hand, so the nightly check runs the one-shot `label-release` below.
#
#   label-release <version> <previous commit> <commit being released> [file]
#       Writes "**In image <version>**" over the "**Not in an image yet**" line that sits above the entries that release
#       will list (the added "- " lines, as scripts/release-notes.sh and the gate read them). Section headings, other
#       entries, other labels and the "Docs checked up to" line are never touched. A day whose section holds both
#       already-labelled and unlabelled released entries gets a second label line, so only the released ones move.
#       Prints one line: how many labels it wrote. Writes nothing when every released entry is already labelled.
#       Safe to run twice: a second run finds nothing unlabelled and changes nothing.
#
# Why this is not done inside the Release workflow: a push made with the workflow's own token starts no CI, so a label
# written there would have no images to tag. The label has to be on a commit whose images are published, which means main
# before the run picks it. That is the Monday docs check's job (CHANGELOG.md step 8); this helper is the fallback for code
# that lands after that pass, and is run once more on the Monday evening before the Tuesday release (BOS-2667).
set -euo pipefail

FILE="${RELEASE_NOTES_FILE:-CHANGELOG.md}"
VERSION_RE='^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.]+)?$'
NOT_YET_RE='^[*][*]Not in an image yet:[*][*]' # bracket form: awk -v would warn on a backslash escape

die() { echo "changelog-label-release: $*" >&2; exit 1; }
need_version() { [[ "${1:-}" =~ $VERSION_RE ]] || die "version '${1:-}' is not like 0.1.0 or 0.1.0-beta.1"; }

cmd_label_release() {
  local v="${1:-}" prev="${2:-}" sha="${3:-}" f="${4:-$FILE}"
  need_version "$v"
  [ -n "$sha" ] || die "usage: changelog-label-release.sh label-release <version> <previous commit> <commit> [file]"
  [ -f "$f" ] || die "$f is missing"
  local text added
  text="$(git show "$sha:$FILE" 2>/dev/null)" || die "$FILE is missing at ${sha:0:12}"
  if [ -n "$prev" ] && git cat-file -e "$prev^{commit}" 2>/dev/null; then
    added="$(git diff --no-color -U0 "$prev" "$sha" -- "$FILE" | sed -n 's/^+\(- .*\)$/\1/p')"
  else
    added="$(printf '%s\n' "$text" | grep '^- ' || true)"
  fi
  [ -n "$added" ] || { echo "changelog-label-release: nothing released in $FILE at ${sha:0:12}; labelled 0"; return 0; }

  local addedf out
  addedf="$(mktemp)"; out="$addedf.out"
  printf '%s\n' "$added" > "$addedf"
  printf '%s\n' "$text" |
    awk -v v="$v" -v re="$NOT_YET_RE" -v want="**In image $v**" -v out="$out" '
      FNR == NR { released[$0] = 1; next }
      { line[FNR] = $0; last = FNR }
      END {
        n = 0
        # Pass 1: a "Not in an image yet" label above one or more released entries becomes the image label.
        for (i = 1; i <= last; i++) {
          if (line[i] ~ /^## /) continue
          if (line[i] ~ re) {
            for (j = i + 1; j <= last; j++) {
              if (line[j] ~ /^## / || line[j] ~ /^[*][*](Not in an image yet:|In image )/) break
              if (line[j] ~ /^- / && (line[j] in released)) { line[i] = want; n++; break }
            }
          }
        }
        # Pass 2: inside a section, if released entries still sit under a not-yet label while the section already has the
        # image label, put the image label just above the first such entry, so only the released ones move. Collected here
        # and emitted in order below, so no line is ever printed twice.
        m = 0; lastlab = 0
        for (i = 1; i <= last; i++) {
          if (line[i] ~ /^## /) { lastlab = 0; continue }
          if (line[i] ~ /^[*][*](Not in an image yet:|In image )/)  { lastlab = (line[i] == want) ? 1 : -1; continue }
          if (line[i] ~ /^- / && (line[i] in released) && lastlab == -1) {
            insert[i] = 1; m++; n++; lastlab = 1
          }
        }
        for (i = 1; i <= last; i++) { if (insert[i]) print want > out; print line[i] > out }
        print n > (out ".n")
      }' "$addedf" -
  local n; n="$(cat "$out.n" 2>/dev/null || echo 0)"
  if [ "${n:-0}" -gt 0 ]; then cat "$out" > "$f"; fi
  rm -f "$addedf" "$out" "$out.n"
  echo "changelog-label-release: labelled $n section(s) as in image $v"
}

case "${1:-}" in
  label-release) shift; cmd_label_release "$@" ;;
  *) die "usage: changelog-label-release.sh label-release <version> <previous commit> <commit> [file]" ;;
esac
