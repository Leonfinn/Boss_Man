#!/usr/bin/env bash
# Install the pinned cosign (linux amd64) into a folder on PATH for the rest of a GitHub Actions job.
#   scripts/install-cosign.sh [version]     (default v2.4.1)
# Replaces sigstore/cosign-installer, whose single download failed once with curl exit 22 (an HTTP error from GitHub's
# release server) and failed the whole "Publish images" run on 17 Nov 2026 (BOS-1726). This one retries on any
# download error and checks the file against a pinned SHA-256, so a bad or swapped file is refused, never run.
# Safe to run twice. To move to a new version, take the hash of cosign-linux-amd64 from that release's
# cosign_checksums.txt and add it below.
set -euo pipefail

version="${1:-v2.4.1}"
case "$version" in
  v2.4.1) want=8b24b946dd5809c6bd93de08033bcf6bc0ed7d336b7785787c080f574b89249b ;;
  *) echo "install-cosign.sh: no pinned SHA-256 for cosign $version; add it to this script" >&2; exit 2 ;;
esac

dest="${COSIGN_INSTALL_DIR:-${RUNNER_TEMP:-/tmp}/cosign-bin}"
mkdir -p "$dest"
url="https://github.com/sigstore/cosign/releases/download/$version/cosign-linux-amd64"

# --retry-all-errors also retries HTTP 4xx/5xx (curl 7.71+; ubuntu-24.04 has 8.x). Up to 6 tries, 5 s apart.
curl --fail --silent --show-error --location --retry 5 --retry-delay 5 --retry-all-errors \
  --connect-timeout 20 --max-time 120 --output "$dest/cosign.part" "$url"
got="$(sha256sum "$dest/cosign.part" | cut -d' ' -f1)"
if [[ $got != "$want" ]]; then
  rm -f "$dest/cosign.part"
  echo "install-cosign.sh: SHA-256 of the download is $got, wanted $want" >&2
  exit 1
fi
chmod +x "$dest/cosign.part"
mv -f "$dest/cosign.part" "$dest/cosign"

if [[ -n ${GITHUB_PATH:-} ]]; then echo "$dest" >> "$GITHUB_PATH"; fi
"$dest/cosign" version
