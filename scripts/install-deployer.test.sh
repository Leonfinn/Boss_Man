#!/usr/bin/env bash
# Checks scripts/install-deployer.sh (BOS-1588) in a throwaway install folder: <install>/src (checkout) + <install>/deployer.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
fail() { echo "FAIL: $*" >&2; exit 1; }
mkdir -p "$T/src/scripts" "$T/deployer"
cp "$here/install-deployer.sh" "$T/src/scripts/"
SCR="$T/src/scripts/install-deployer.sh"
printf '#!/usr/bin/env bash\necho new\n' >"$T/src/scripts/host-deployer.sh"
unset BOSSMAN_DEPLOYER

# 1. No installed copy: nothing is created.
out="$("$SCR")"; [[ $out == *"nothing to refresh"* ]] || fail "no copy: $out"
[[ ! -e $T/deployer/host-deployer.sh ]] || fail "created a copy that was never installed"

# 2. A stale copy is replaced; its mode is kept and no temp file is left.
printf '#!/usr/bin/env bash\necho old\n' >"$T/deployer/host-deployer.sh"; chmod 750 "$T/deployer/host-deployer.sh"; chmod 755 "$T/deployer"
"$SCR" --dry-run | grep -q "would replace" || fail "dry run"
cmp -s "$T/src/scripts/host-deployer.sh" "$T/deployer/host-deployer.sh" && fail "dry run changed the copy"
"$SCR" >/dev/null
cmp -s "$T/src/scripts/host-deployer.sh" "$T/deployer/host-deployer.sh" || fail "copy not refreshed"
[[ $(stat -c %a "$T/deployer/host-deployer.sh") == 750 ]] || fail "mode not kept"
[[ -z $(find "$T/deployer" -name '.host-deployer.sh.*') ]] || fail "temp file left behind"

# 3. A run that has the old file open (as bash does while it reads a script) still reads the old text: the rename
# gives the new file a new inode, nothing is rewritten in place.
printf 'still-old\n' >"$T/deployer/host-deployer.sh"; chmod 750 "$T/deployer/host-deployer.sh"
exec 8<"$T/deployer/host-deployer.sh"
"$SCR" >/dev/null
read -r line <&8; exec 8<&-
[[ $line == still-old ]] || fail "a running copy was disturbed: $line"
cmp -s "$T/src/scripts/host-deployer.sh" "$T/deployer/host-deployer.sh" || fail "copy not refreshed (3)"

# 4. Already current: unchanged. A script that does not parse: the old copy stays and it exits 1.
out="$("$SCR")"; [[ $out == *"already current"* ]] || fail "current: $out"
printf 'if then\n' >"$T/src/scripts/host-deployer.sh"
if "$SCR" 2>/dev/null; then fail "a broken script was installed"; fi
cmp -s "$T/deployer/host-deployer.sh" "$T/src/scripts/host-deployer.sh" && fail "broken script copied"
printf '#!/usr/bin/env bash\necho new\n' >"$T/src/scripts/host-deployer.sh"

# 5. A folder others can write to is left alone.
printf '#!/usr/bin/env bash\necho newer\n' >"$T/src/scripts/host-deployer.sh"
chmod 777 "$T/deployer"
if "$SCR" 2>/dev/null; then fail "wrote into a world-writable folder"; fi
chmod 755 "$T/deployer"

# 6. The folder comes from BOSSMAN_DEPLOYER, then the checkout's .env.
mkdir "$T/other" "$T/viaenv"; chmod 755 "$T/other" "$T/viaenv"
printf 'x\n' >"$T/other/host-deployer.sh"; printf 'x\n' >"$T/viaenv/host-deployer.sh"
BOSSMAN_DEPLOYER="$T/other" "$SCR" >/dev/null; cmp -s "$T/other/host-deployer.sh" "$T/src/scripts/host-deployer.sh" || fail "env folder not used"
printf 'BOSSMAN_DEPLOYER="%s"  # note\n' "$T/viaenv" >"$T/src/.env"
"$SCR" >/dev/null; cmp -s "$T/viaenv/host-deployer.sh" "$T/src/scripts/host-deployer.sh" || fail ".env folder not used"
echo "install-deployer.test.sh: ok"
