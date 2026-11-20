#!/usr/bin/env bash
# Every `image:` in deploy/*.yml that names a public registry image must carry @sha256:, so a re-pushed tag
# cannot change a container silently. Exceptions are listed below, each with a reason.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

# "file-pattern|image-pattern  # reason": an image: line in a matching file whose image matches is not checked.
# shellcheck disable=SC2016  # the ${...} below is literal text matched against compose files
exceptions=(
  'deploy/*.yml|boss-man-*'                # built on the host from this repo, no registry
  'deploy/*.yml|${BOSSMAN_TOOLSERVER_IMAGE:?*'  # the owner names their own image; nothing to pin here
  'deploy/penpot.yml|*'                    # Penpot add-on: pinned by its own ticket (BOS-2099); remove this line once those pins are on main
)

fail=0; checked=0
for f in deploy/*.yml; do
  while IFS= read -r line; do
    img=${line#*image:}; img=${img## }; img=${img%% #*}; img=${img//\"/}
    skip=0
    for e in "${exceptions[@]}"; do
      fp=${e%%|*}; ip=${e#*|}; ip=${ip%%  #*}
      # shellcheck disable=SC2053
      if [[ $f == $fp && $img == $ip ]]; then skip=1; break; fi
    done
    [ "$skip" -eq 0 ] || continue
    checked=$((checked + 1))
    if [[ $img != *@sha256:* ]]; then
      echo "FAIL: $f: image has no @sha256: digest: $img" >&2
      fail=1
    fi
  done < <(grep -E '^[[:space:]]*image:' "$f" || true)
done

[ "$checked" -gt 0 ] || { echo "FAIL: no image lines were checked (test is broken)" >&2; exit 1; }
[ "$fail" -eq 0 ] || exit 1
echo "deploy-image-pins: $checked public images all carry a digest"
