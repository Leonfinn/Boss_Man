#!/usr/bin/env bash
# Guard (BOS-1690): no tracked shell script tests a negated group or subshell that carries its own redirect, such as
#   if ! { cmd; } >"$file"; then …      or      if ! ( cmd ) 2>>"$LOG"; then …
# When that redirect can't be opened (a read-only file, a missing folder), bash does not apply the `!`: the whole
# command is just "false", so the failure branch never runs. That hid check-all.sh's fallback log for weeks
# (BOS-1689, wiki engineering/rca/rca-bos-1689-check-all-fallback-log-test). Write it instead as
#   if { cmd; } >"$file"; then :; else …; fi      or put the body in a function:      if ! body 2>>"$LOG"; then …
# (a failed redirect on a plain command or function call does run the `!` branch).
# What it does not catch: a group spread over several lines (`if ! {` on one line, `} >file` on a later one), and a
# redirect hidden behind a variable or an alias. Comment lines and trailing comments are ignored.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
root="$(cd "$here/.." && pwd)"
fail() { echo "FAIL: $*"; exit 1; }

# `!` as a word, then a `{ ` group or a `(` subshell, then later on the line a `}` or `)` followed by a redirect.
pattern='(^|[[:space:];&|(])![[:space:]]+(\{[[:space:]]|\().*[})][[:space:]]*(&|[0-9]*)(>|<)'
# Drop comment lines and trailing ` # …` comments first, so prose about the pattern (like this file's) is not a hit.
code_only() { sed -E -e 's/^[[:space:]]*#.*$//' -e 's/[[:space:]]#[^"'\'']*$//'; }
hits() { code_only | grep -nE -- "$pattern" || true; }

# The matcher itself: lines it must flag, and lines it must leave alone.
while IFS= read -r line; do
  [ -n "$(printf '%s\n' "$line" | hits)" ] || fail "the guard misses: $line"
done <<'EOF'
if ! { printf 'x'; cat "$1"; } 2>/dev/null >"$tmp"; then
if ! (set -o pipefail; g archive "$commit" | tar -x -C "$RENDER_DIR") 2>>"$LOG"; then
x || ! { a; } &>"$f"
while ! ( read -r l ) <"$in"; do
EOF
while IFS= read -r line; do
  [ -z "$(printf '%s\n' "$line" | hits)" ] || fail "the guard flags a safe line: $line"
done <<'EOF'
if ! unpack_commit "$commit" 2>>"$LOG"; then
if { printf 'x'; } 2>/dev/null >"$tmp"; then :; else
[ ! -s "$SCRATCH_LOG" ] || mv -f "$SCRATCH_LOG" "$SCRATCH_LOG.previous" 2>/dev/null || true
! grep -qF -- "$2" "$1" 2>/dev/null || fail "x"
out="$(! true)"; echo "$(date)" >"$f"
# not `if ! { …; } >file`: bash skips the `!`
echo done # a trailing note: ! { a; } >f
EOF

# Every tracked shell script (or every *.sh below the repo when this is not a git checkout).
if git -C "$root" rev-parse --git-dir >/dev/null 2>&1; then
  mapfile -t files < <(git -C "$root" ls-files -- '*.sh')
else
  mapfile -t files < <(cd "$root" && find . -name node_modules -prune -o -name '*.sh' -type f -print | sed 's#^\./##')
fi
[ "${#files[@]}" -gt 10 ] || fail "found only ${#files[@]} shell scripts under $root; the guard would check nothing"
found=""
for f in "${files[@]}"; do
  # This file's own samples above are the pattern on purpose; the matcher checks on them already prove it works.
  if [ ! -f "$root/$f" ] || [ "$f" = scripts/negated-redirect.test.sh ]; then continue; fi
  h="$(hits <"$root/$f")"
  [ -z "$h" ] || found+="$(printf '%s\n' "$h" | sed "s#^#  $f:#")"$'\n'
done
[ -z "$found" ] || fail "negated group or subshell with its own redirect (bash skips the \`!\` when the redirect fails; see this file's header):
$found"
echo "negated-redirect.test.sh: ok (${#files[@]} scripts)"
