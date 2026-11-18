#!/usr/bin/env bash
# The "list guards" (BOS-1727): tests that fail when a screen, control, wake reason or in-memory state was added or changed
# without its record. They caused 25 failed quick checks in 3 days (BOS-1720), each found 9 to 13 minutes in, so check-quick.sh
# and check-all.sh run them first. Usage: scripts/check-guards.sh <wake-classes|owner-controls|screen-inventory>
# On failure it prints the file to edit and what to add, after the test's own output (whose "add to ..." lines are the exact edits).
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.." || exit 1
guard="${1:-}"
case "$guard" in
  wake-classes) pkg=@boss-man/server file=test/wake-classes.test.ts ;;
  owner-controls) pkg=@boss-man/server file=test/owner-control-list.test.ts ;;
  screen-inventory) pkg=@boss-man/web file=test/screen-inventory.test.ts ;;
  *) echo "usage: scripts/check-guards.sh wake-classes|owner-controls|screen-inventory" >&2; exit 2 ;;
esac
rc=0
pnpm --filter "$pkg" exec vitest run "$file" || rc=$?
[ "$rc" -eq 0 ] && exit 0
case "$guard" in
  wake-classes)
    echo "guard: a wake reason in apps/server/src has no class. Add one line per reason to WAKE_CLASS in apps/server/src/services/wake-classes.ts" >&2
    echo "       (the failure above prints the lines, with the class left for you to choose from the table's header)." >&2
    echo "       A string that is not a wake's reason goes in NOT_WAKE_REASONS in apps/server/test/wake-classes.test.ts instead." >&2 ;;
  owner-controls)
    echo "guard: a button, field or section heading in apps/web/src is not on the owner's list (or the list names one the app lost)." >&2
    echo "       The \"add to ...\" and \"remove from ...\" lines above are the exact edits, in packages/shared/src/owner-controls.ts;" >&2
    echo "       \"add X to FILE_SCREEN / PAGE_SCREEN / SITE_SCREEN\" means the same-named table in apps/server/test/owner-control-list.test.ts." >&2 ;;
  screen-inventory)
    echo "guard: a page's sections or API reads changed, so apps/web/test/screen-inventory.txt is out of date. If you meant the change, refresh and commit it:" >&2
    echo "       pnpm --filter @boss-man/web exec vitest run test/screen-inventory.test.ts -u" >&2
    echo "       then read the diff of screen-inventory.txt: a removed line is a dropped section or read. A new redirect in settingsRedirect" >&2
    echo "       (apps/web/src/pages/Settings.tsx) also needs a line in REDIRECTS in apps/web/test/screen-inventory.test.ts." >&2 ;;
esac
exit "$rc"
