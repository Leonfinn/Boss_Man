#!/usr/bin/env bash
# Clear test scratch out of a temp folder (default /tmp): top-level entries that match a scratch name, where nothing inside
# was changed for SWEEP_TMP_HOURS hours (default 6) and no process has the entry as its working folder or an open file.
# Only the named patterns are touched, never the check lock files or anything else; it never leaves the one folder.
# When the folder's disk is nearly full (free below SWEEP_TMP_MIN_FREE_PERCENT, default 10%), the age bar drops to
# SWEEP_TMP_EMERGENCY_HOURS (default 1), so a day of checks can't leave the runner with no room for the next one.
# Safe to run twice; SWEEP_TMP_DRY_RUN=1 only lists what it would remove.
#   SWEEP_TMP_DIR       folder to sweep (default /tmp)
#   SWEEP_TMP_HOURS     minimum age in hours (default 6)
#   SWEEP_TMP_PATTERNS  space-separated name globs (default: the migration/runner test scratch and pnpm stores)
set -uo pipefail
DIR=${SWEEP_TMP_DIR:-/tmp}
HOURS=${SWEEP_TMP_HOURS:-6}
PATTERNS=${SWEEP_TMP_PATTERNS:-"bm-* mig-old-* bossman-pglite-template-*.tar pnpm-store* .pnpm-store*"}
MIN_FREE=${SWEEP_TMP_MIN_FREE_PERCENT:-10}
EMERGENCY_HOURS=${SWEEP_TMP_EMERGENCY_HOURS:-1}
case "$HOURS" in '' | *[!0-9]*) echo "sweep-tmp: SWEEP_TMP_HOURS must be a whole number" >&2; exit 2 ;; esac
case "$MIN_FREE" in '' | *[!0-9]*)
  echo "sweep-tmp: SWEEP_TMP_MIN_FREE_PERCENT must be a whole number" >&2
  exit 2
  ;;
esac
case "$EMERGENCY_HOURS" in '' | *[!0-9]*) echo "sweep-tmp: SWEEP_TMP_EMERGENCY_HOURS must be a whole number" >&2; exit 2 ;; esac
[ -d "$DIR" ] || { echo "sweep-tmp: $DIR is not a folder" >&2; exit 2; }
DIR=$(cd "$DIR" && pwd -P)
[ "$DIR" != / ] || { echo "sweep-tmp: refusing to sweep /" >&2; exit 2; }

# A low disk drops the age bar on this folder's filesystem. Only the bar ever moves; recent work and held folders still stay.
emergency=0
if [ "$MIN_FREE" -gt 0 ] && free=$(df -Pk "$DIR" 2>/dev/null | awk 'NR==2 {print $4, $2}') && [ -n "$free" ]; then
  read -r avail total <<<"$free"
  if [ -n "${avail:-}" ] && [ "$total" -gt 0 ] && [ $(( avail * 100 / total )) -lt "$MIN_FREE" ]; then
    emergency=1
    if [ "$EMERGENCY_HOURS" -lt "$HOURS" ]; then HOURS=$EMERGENCY_HOURS; fi
  fi
fi

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
note=; [ "$emergency" -eq 0 ] || note=", disk low: only entries older than ${HOURS}h were removed"
echo "sweep-tmp: $removed $verb, $kept kept in $DIR (older than ${HOURS}h and unheld$note)"
