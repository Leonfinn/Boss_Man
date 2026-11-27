#!/usr/bin/env bash
# The image label on CHANGELOG.md's What's new entries (BOS-2841, part 3/3; format from BOS-2839).
#
# Each date heading's first line says which ready-made image has its entries: "**Not in an image yet:** comes with the
# next weekly image (Tuesdays)." or "**In image 0.1.0-beta.4**". A day the weekly cut falls inside has both labels.
#
#   changelog-label.sh label <version> [file]
#       Turns every "Not in an image yet" label that has at least one entry under it into "**In image <version>**", in
#       place. Safe to run twice: a second run finds nothing unlabelled and changes nothing. Older "In image" labels,
#       headings, entries and the one "Docs checked up to" line are never touched. Prints one line saying how many.
#
#   changelog-label.sh check <version> <previous commit> <commit being released>
#       Release gate (.github/workflows/release.yml). The entries that release will list (the added list lines, as
#       scripts/release-notes.sh reads them) must each sit under "**In image <version>**" in the commit being released.
#       Otherwise the page would say "not in an image yet" about an image that has them. Prints file:line lines and a
#       last plain line, and exits 1. An empty previous commit means every entry counts, as in release-notes.sh.
#
# Why labelled before the release and not by the release run: a push made with the workflow's own token does not start CI,
# so no "Publish images" run would build the labelled commit and the release would have no image for it. The label is
# written on main before the release (the Release Manager, with `label`, once the weekly version is known) and this
# gate proves it reached the commit that is tagged.
set -euo pipefail

FILE="${RELEASE_NOTES_FILE:-CHANGELOG.md}"
VERSION_RE='^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.]+)?$'
NOT_YET='^\*\*Not in an image yet:\*\* '

die() { echo "changelog-label: $*" >&2; exit 1; }
need_version() { [[ "${1:-}" =~ $VERSION_RE ]] || die "version '${1:-}' is not like 0.1.0 or 0.1.0-beta.1"; }

cmd_label() {
  local v="${1:-}" f="${2:-$FILE}"
  need_version "$v"
  [ -f "$f" ] || die "$f is missing"
  local tmp; tmp="$(mktemp)"
  # A label counts only with a "- " entry under it before the next heading or label; the comment block at the top of the
  # file has none of its own labels at line start, so it is never matched.
  awk -v v="$v" -v re="$NOT_YET" -v out="$tmp" '
    { line[NR] = $0 }
    END {
      n = 0
      for (i = 1; i <= NR; i++) {
        if (line[i] ~ re) {
          has = 0
          for (j = i + 1; j <= NR; j++) {
            if (line[j] ~ /^## / || line[j] ~ /^\*\*(Not in an image yet:|In image )/) break
            if (line[j] ~ /^- /) { has = 1; break }
          }
          if (has) { line[i] = "**In image " v "**"; n++ }
        }
      }
      for (i = 1; i <= NR; i++) print line[i] > out
      print n
    }' "$f" > "$tmp.n"
  local n; n="$(cat "$tmp.n")"
  if [ "$n" -gt 0 ]; then cat "$tmp" > "$f"; fi
  rm -f "$tmp" "$tmp.n"
  echo "changelog-label: labelled $n date section(s) as in image $v"
}

cmd_check() {
  local v="${1:-}" prev="${2:-}" sha="${3:?commit being released}"
  need_version "$v"
  local text added
  text="$(git show "$sha:$FILE" 2>/dev/null)" || die "$FILE is missing at ${sha:0:12}"
  if [ -n "$prev" ] && git cat-file -e "$prev^{commit}" 2>/dev/null; then
    added="$(git diff --no-color -U0 "$prev" "$sha" -- "$FILE" | sed -n 's/^+\(- .*\)$/\1/p')"
  else
    added="$(printf '%s\n' "$text" | grep '^- ' || true)"
  fi
  [ -n "$added" ] || return 0 # nothing to label; the docs gate refuses an empty release
  local tmp; tmp="$(mktemp)"; printf '%s\n' "$added" > "$tmp"
  local bad
  bad="$(printf '%s\n' "$text" | awk -v want="**In image $v**" -v f="$FILE" '
    FNR == NR { set[$0] = 1; next }
    /^## / { label = ""; next }
    /^\*\*(Not in an image yet:|In image )/ { label = ($0 == want) ? "ok" : $0; next }
    ($0 in set) && label != "ok" {
      printf "%s:%d: %s\n", f, FNR,(label == "" ? "no image label above this entry" : "under \"" substr(label, 1, 60) "\"")
    }' "$tmp" -)"
  rm -f "$tmp"
  if [ -n "$bad" ]; then
    printf '%s\n' "$bad" | head -n 5
    echo "The What's new entries of $v are not all labelled \"In image $v\" in $FILE at ${sha:0:12}, so the page would say they are not in an image yet. Label them on main first (scripts/changelog-label.sh label $v), wait for that commit's images, then run the release again."
    return 1
  fi
}

case "${1:-}" in
  label) shift; cmd_label "$@" ;;
  check) shift; cmd_check "$@" ;;
  *) die "usage: changelog-label.sh label <version> [file] | check <version> <previous commit> <commit>" ;;
esac
