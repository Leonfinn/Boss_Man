#!/usr/bin/env bash
# ShellCheck for every tracked *.sh (git ls-files), so a new script is checked without anyone adding it to a list.
# CI runs this; run it yourself before handing work in. Arguments replace the file list (used by check-shell.test.sh).
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
# Skip list: one "path  # reason" per entry. Keep it short; an entry without a reason is a bug.
skip=(
  # (empty: every tracked shell script is checked)
)
if [ "$#" -gt 0 ]; then
  files=("$@")
else
  files=()
  while IFS= read -r f; do
    for s in ${skip[@]+"${skip[@]}"}; do [ "$f" != "$s" ] || continue 2; done
    files+=("$f")
  done < <(git ls-files '*.sh')
fi
[ "${#files[@]}" -gt 0 ] || { echo "check-shell: no shell scripts found" >&2; exit 1; }
shellcheck "${files[@]}"
