#!/usr/bin/env bash
# Refresh the host's own COPY of the deployer script from this checkout (BOS-1588). deploy.sh and host-deployer.sh run it
# after a good deploy, so no one copies scripts/host-deployer.sh by hand; the installer (BOS-1580) can call it too.
#
#   scripts/install-deployer.sh            copy it if the installed copy differs
#   scripts/install-deployer.sh --dry-run  say what would happen; change nothing
#
# Where: the deployer folder is BOSSMAN_DEPLOYER (environment, then the checkout's .env), else <install folder>/deployer,
# the same rule rebuild-live.sh uses. Nothing is done unless that folder already holds a host-deployer.sh: an install
# without the host deployer is left alone.
# How: the new file is written beside the old one, given the old one's owner and mode, checked with bash -n, and renamed
# over it (atomic). A deployer run in progress keeps reading the old file; the new one is used from the next run. It never
# takes the deployer's lock, so it cannot hold up or deadlock a deploy (BOS-1037).
# Exit: 0 = copied or nothing to do (it says which); 1 = something is wrong (the message says what). Callers treat 1 as a warning.
set -euo pipefail

DRY=0
for a in "$@"; do case $a in --dry-run) DRY=1 ;; *) echo "Usage: $0 [--dry-run]" >&2; exit 2 ;; esac; done

SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC="$SRC_DIR/scripts/host-deployer.sh"
INSTALL_DIR="$(cd "$SRC_DIR/.." && pwd)"
D="${BOSSMAN_DEPLOYER:-}"
if [[ -z $D && -f $SRC_DIR/.env ]]; then
  D="$({ grep -E '^[[:space:]]*(export[[:space:]]+)?BOSSMAN_DEPLOYER[[:space:]]*=' "$SRC_DIR/.env" || true; } | tail -n 1 | sed -E 's/^[^=]*=[[:space:]]*//; s/[[:space:]]+#.*$//; s/^"(.*)"$/\1/; s/^'"'"'(.*)'"'"'$/\1/')"
fi
D="${D:-$INSTALL_DIR/deployer}"
DEST="$D/host-deployer.sh"

[[ -f $SRC ]] || { echo "install-deployer: $SRC not found." >&2; exit 1; }
if [[ ! -d $D || ! -f $DEST ]]; then echo "install-deployer: no deployer copy at $DEST; nothing to refresh."; exit 0; fi
if cmp -s "$SRC" "$DEST"; then echo "install-deployer: the deployer copy is already current."; exit 0; fi
# A folder others can write to would let them swap what root runs; leave it for the owner to fix.
dmode="$(stat -c %a "$D")"
if (((8#$dmode) & 8#022)); then echo "install-deployer: $D is writable by others (mode $dmode); not touching it." >&2; exit 1; fi
if [[ $(id -u) != 0 && $(stat -c %u "$DEST") != "$(id -u)" ]]; then
  echo "install-deployer: $DEST belongs to another user; run this as root to refresh it." >&2; exit 1
fi
bash -n "$SRC" || { echo "install-deployer: $SRC does not parse; the old copy is kept." >&2; exit 1; }
if ((DRY)); then echo "[dry-run] would replace $DEST with $SRC"; exit 0; fi

tmp="$(mktemp "$D/.host-deployer.sh.XXXXXX")"
trap 'rm -f "$tmp"' EXIT
cp "$SRC" "$tmp"
chmod --reference="$DEST" "$tmp"
if [[ $(id -u) == 0 ]]; then chown --reference="$DEST" "$tmp"; fi
mv -f "$tmp" "$DEST"
trap - EXIT
echo "install-deployer: the deployer copy at $DEST is updated; it takes effect on the next run."
