#!/usr/bin/env bash
# Does this full merge check need ShellCheck and the shell tests (BOS-1939)? Exit 0 = yes, run them; exit 1 = no, skip them.
# The reason goes to stdout, one line. Only a merge check on a branch whose changed files can be listed and touch nothing the
# shell tests read skips them; anything else (a hand run, main, CHECK_ALL_FORCE, an empty or failed diff) runs them as before.
# GitHub CI runs scripts/test-shell.sh on every branch and on main, so a skip here loses no coverage before main.
# BASE (default origin/main) is the branch to compare with, as in scripts/check-quick.sh. Tests stub nothing: they use a temp repo.
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.." || { echo "run: cannot enter the repo"; exit 0; }

# What the shell tests and ShellCheck read. Found by reading every tracked *.test.sh (scripts/, apps/netguard/, skills/penpot/):
# each runs the script beside it, and the real repo paths it reads are deploy/*.yml and deploy/caddy, .github/workflows/*,
# docker-compose*.yml, Dockerfiles, apps/netguard, skills/penpot and scripts/. Most other "apps/..." and "packages/..." names in them
# are fixtures built in a temp repo. check-all.test.sh fails when a path a test names is not covered here. The list is generous on
# purpose: a wrong inclusion costs about 6 minutes, a wrong exclusion hides a failure until GitHub CI. ShellCheck runs on every
# tracked *.sh, so any *.sh anywhere is in the list too.
needed_path() {
  case "$1" in
    *.sh) return 0 ;;
    scripts/* | deploy/* | apps/runner/* | apps/netguard/* | skills/penpot/* | .github/workflows/*) return 0 ;;
    docker-compose*.yml | */docker-compose*.yml) return 0 ;;
    Dockerfile* | */Dockerfile*) return 0 ;;
    .dockerignore) return 0 ;; # scripts/host-deployer.test.sh checks it IS a hand-apply path and excludes .env
    package.json | pnpm-lock.yaml | pnpm-workspace.yaml) return 0 ;;
    docs/35-install-from-images.md) return 0 ;; # scripts/install-images.test.sh checks the guide exists
    apps/site/src/guides/install-boss-man.md) return 0 ;; # scripts/install-images.test.sh checks its compose commands
  esac
  return 1
}

if [ "${1:-}" = "--path" ]; then needed_path "${2:-}"; exit; fi

if [ -n "${CHECK_ALL_FORCE:-}" ]; then echo "run: CHECK_ALL_FORCE is set"; exit 0; fi
if [ -z "${BOSSMAN_MERGE_CHECK:-}" ]; then echo "run: not a merge check run"; exit 0; fi
branch="$(git rev-parse --abbrev-ref HEAD 2>/dev/null)" || { echo "run: cannot read the branch"; exit 0; }
case "$branch" in main | master) echo "run: this is $branch"; exit 0 ;; esac
base="${BASE:-origin/main}"
changed="$(git diff --name-only "$base"...HEAD 2>/dev/null)" || { echo "run: cannot list the changed files against $base"; exit 0; }
[ -n "$changed" ] || { echo "run: no changed files against $base"; exit 0; }
while IFS= read -r f; do
  if needed_path "$f"; then echo "run: $f changed"; exit 0; fi
done <<<"$changed"
echo "skip: no file the shell tests read changed"
exit 1
