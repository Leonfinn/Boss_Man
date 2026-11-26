#!/usr/bin/env bash
# The body of a weekly beta pre-release (BOS-2662): the "What's new" lines that were added to CHANGELOG.md between the
# last beta's commit and this one. Those lines are written per change, in plain words, by the Release Manager, and the
# website's "What's new" page is built from the same file, so the release and the site say the same thing and nobody
# pastes anything on release day.
#
#   release-notes.sh <previous commit> <this commit>
#
# Prints the notes body (Markdown) on stdout. With no new lines it says so in one sentence. Fails only on a bad argument;
# an earlier commit that is not in the history gives the one-sentence body too (the release must not be held up by notes).
set -euo pipefail

prev="${1:-}"
cur="${2:?this commit}"
FILE="${RELEASE_NOTES_FILE:-CHANGELOG.md}"

lines=""
if [ -n "$prev" ] && git cat-file -e "$prev^{commit}" 2>/dev/null; then
  # Added bullet lines only; a reworded line shows once (its new text). -U0: no context lines.
  lines="$(git diff --no-color -U0 "$prev" "$cur" -- "$FILE" | sed -n 's/^+\(- .*\)$/\1/p')"
fi

# The stage word (beta, rc, ...) comes from the one helper that knows it (BOS-2666); no version given means beta.
stage=beta
if [ -n "${RELEASE_VERSION:-}" ]; then
  stage="$("$(dirname "${BASH_SOURCE[0]}")/release-docs-gate.sh" stage-of "$RELEASE_VERSION")"
fi
if [ "$stage" = stable ]; then label="release"; else label="$stage"; fi
if [ -n "$lines" ]; then
  printf "## What's new in this %s\n\n%s\n\n" "$label" "$lines"
else
  printf "No changes you will notice in this %s.\n\n" "$label"
fi
first="$(printf '%s' "${label:0:1}" | tr '[:lower:]' '[:upper:]')"
printf "%s%s. The images are listed, by digest and architecture, in release.json, which is signed (release.json.sigstore.json).\n" "$first" "${label:1}"
