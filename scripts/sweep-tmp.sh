#!/usr/bin/env bash
# Clear test scratch out of a temp folder (default /tmp): top-level entries that match a scratch name, where nothing inside
# was changed for SWEEP_TMP_HOURS hours (default 6) and no process has the entry as its working folder or an open file.
# Only the named patterns are touched, never the check lock files or anything else; it never leaves the one folder.
# Safe to run twice; SWEEP_TMP_DRY_RUN=1 only lists what it would remove.
#   SWEEP_TMP_DIR       folder to sweep (default /tmp)
#   SWEEP_TMP_HOURS     minimum age in hours (default 6)
#   SWEEP_TMP_PATTERNS  space-separated name globs (default: the migration/runner test scratch, pnpm stores, and a
#                       kept scratch's half-written log, bossman-scratch-*.tmp; a ticket's BOSSMAN_SCRATCH lives on
#                       the workspaces disk and is never here)
set -uo pipefail
DIR=${SWEEP_TMP_DIR:-/tmp}
HOURS=${SWEEP_TMP_HOURS:-6}
PATTERNS=${SWEEP_TMP_PATTERNS:-"bm-* mig-old-* bossman-pglite-template-*.tar pnpm-store* .pnpm-store* bossman-scratch-*.tmp"}
case "$HOURS" in '' | *[!0-9]*) echo "sweep-tmp: SWEEP_TMP_HOURS must be a whole number" >&2; exit 2 ;; esac
[ -d "$DIR" ] || { echo "sweep-tmp: $DIR is not a folder" >&2; exit 2; }
DIR=$(cd "$DIR" && pwd -P)
[ "$DIR" != / ] || { echo "sweep-tmp: refusing to sweep /" >&2; exit 2; }

# Every path a process holds: working folder, root, and open files (readlink copes with dashes and spaces in names).
held=$(mktemp)
trap 'rm -f "$held"' EXIT
for p in /proc/[0-9]*; do
  for l in "$p/cwd" "$p"/fd/*; do
    readlink "$l" 2>/dev/null
  done
done | grep -F "$DIR/" >"$held" || true

removed=0; kept=0
for pat in $PATTERNS; do
  for e in "$DIR"/$pat; do
    [ -e "$e" ] || [ -L "$e" ] || continue
    [ "$(dirname "$e")" = "$DIR" ] || continue
    # Recent change anywhere inside keeps it.
    if [ -n "$(find "$e" -mmin "-$((HOURS * 60))" -print -quit 2>/dev/null)" ]; then kept=$((kept + 1)); continue; fi
    # Held: a process path equal to the entry or below it.
    if grep -qxF -e "$e" -e "$e (deleted)" "$held" || grep -qF -- "$e/" "$held"; then kept=$((kept + 1)); continue; fi
    if [ -n "${SWEEP_TMP_DRY_RUN:-}" ]; then echo "would remove $e"; else rm -rf -- "$e"; fi
    removed=$((removed + 1))
  done
done
verb=removed; [ -z "${SWEEP_TMP_DRY_RUN:-}" ] || verb="would be removed"
echo "sweep-tmp: $removed $verb, $kept kept in $DIR (older than ${HOURS}h and unheld)"
