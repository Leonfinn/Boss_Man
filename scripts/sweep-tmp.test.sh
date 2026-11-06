#!/usr/bin/env bash
# Tests for scripts/sweep-tmp.sh, in a throwaway folder.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
T=$(mktemp -d); HOLD=
trap '[ -z "$HOLD" ] || kill "$HOLD" 2>/dev/null || true; rm -rf "$T"' EXIT
fail() { echo "FAIL: $*" >&2; exit 1; }
old() { touch -d '2 days ago' "$@"; }
mkdir -p "$T/bm-old/sub" "$T/bm-new" "$T/mig-old-held" "$T/mig-old-with-dash" "$T/other-old" "$T/bossman-check-all.queue"
: >"$T/bm-old/sub/f"; : >"$T/mig-old-held/f"; : >"$T/bossman-pglite-template-1.tar"; : >"$T/other-old/f"
old "$T/bm-old/sub/f" "$T/bm-old/sub" "$T/bm-old" "$T/mig-old-held/f" "$T/mig-old-held" "$T/mig-old-with-dash" "$T/bossman-pglite-template-1.tar" "$T/other-old/f" "$T/other-old"
# A process holding a folder as its working folder.
(cd "$T/mig-old-held" && exec sleep 300) & HOLD=$!
sleep 0.3
SWEEP_TMP_DIR=$T SWEEP_TMP_HOURS=6 SWEEP_TMP_DRY_RUN=1 scripts/sweep-tmp.sh >"$T.out"
[ -e "$T/bm-old" ] || fail "dry run removed something"
grep -q "would remove $T/bm-old" "$T.out" || fail "dry run did not list bm-old"
SWEEP_TMP_DIR=$T SWEEP_TMP_HOURS=6 scripts/sweep-tmp.sh >"$T.out"; rm -f "$T.out"
[ ! -e "$T/bm-old" ] || fail "old scratch kept"
[ ! -e "$T/mig-old-with-dash" ] || fail "old dashed name kept"
[ ! -e "$T/bossman-pglite-template-1.tar" ] || fail "old template tar kept"
[ -e "$T/bm-new" ] || fail "recent scratch removed"
[ -e "$T/mig-old-held/f" ] || fail "held folder removed"
[ -e "$T/other-old/f" ] || fail "unlisted name removed"
[ -e "$T/bossman-check-all.queue" ] || fail "check queue removed"
SWEEP_TMP_DIR=$T SWEEP_TMP_HOURS=x scripts/sweep-tmp.sh 2>/dev/null && fail "bad hours accepted"
SWEEP_TMP_DIR=/ scripts/sweep-tmp.sh 2>/dev/null && fail "swept /"
echo "sweep-tmp.test: ok"
