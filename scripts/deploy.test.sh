#!/usr/bin/env bash
# Checks deploy.sh's "do the runners need updating?" rule against a throwaway git repo.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=scripts/deploy.sh
# shellcheck disable=SC1091
source "$here/deploy.sh"
d="$(mktemp -d)"; trap 'rm -rf "$d"' EXIT
cd "$d"; git init -q; git config user.email t@t; git config user.name t
mkdir -p apps/server apps/runner packages/shared docs; touch apps/server/a docs/x
git add -A; git commit -qm base; base="$(git rev-parse HEAD)"
check() { # file expected
  mkdir -p "$(dirname "$1")"; echo "$RANDOM" >"$1"; git add -A; git commit -qm c
  if needs_runner "$base" HEAD; then got=yes; else got=no; fi
  [[ $got == "$2" ]] || { echo "FAIL: $1 expected $2 got $got"; exit 1; }
  git reset -q --hard "$base"
}
check apps/server/a no
check docs/x no
check apps/runner/Dockerfile yes
check apps/launcher/src/m.ts yes
check packages/shared/i.ts yes
check pnpm-lock.yaml yes
check apps/runner-extra/y no
echo "deploy.test.sh: ok"
