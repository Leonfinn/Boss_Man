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
check apps/netguard/netguard.sh yes
check packages/shared/i.ts yes
check pnpm-lock.yaml yes
check apps/runner-extra/y no

# --commit deploys exactly that commit even when main has moved on, using a fake docker.
cd /; t="$(mktemp -d)"; trap 'rm -rf "$d" "$t"' EXIT
git init -q --bare -b main "$t/origin.git"
git clone -q "$t/origin.git" "$t/src" 2>/dev/null; cd "$t/src"; git config user.email t@t; git config user.name t
mkdir scripts; cp "$here/deploy.sh" scripts/; echo 1 >f; git add -A; git commit -qm one; git push -q origin HEAD:main 2>/dev/null; git fetch -q
git branch -q --set-upstream-to=origin/main main; git remote set-head origin main >/dev/null
one="$(git rev-parse HEAD)"; echo 2 >f; git commit -qam two; two="$(git rev-parse HEAD)"; echo 3 >f; git commit -qam three; three="$(git rev-parse HEAD)"
git push -q origin HEAD:main 2>/dev/null; git reset -q --hard "$one"
mkdir "$t/bin"; cat >"$t/bin/docker" <<'FAKE'
#!/usr/bin/env bash
echo "docker $*" >>"$FAKE_LOG"
case "$*" in
  *pg_dump*) echo dump ;; *"config --services"*) echo server ;; *"ps -q"*) echo cid ;; *inspect*) echo healthy ;;
esac
FAKE
chmod +x "$t/bin/docker"
umask 022 # a default host umask: the script must tighten it itself
export FAKE_LOG="$t/docker.log" BOSSMAN_BACKUP_DIR="$t/backups"
PATH="$t/bin:$PATH" scripts/deploy.sh --yes --no-runner --commit "$two" >/dev/null
[[ $(git rev-parse HEAD) == "$two" ]] || { echo "FAIL: --commit did not land on the requested commit"; exit 1; }
grep -q '"result":"deployed"' "$t/backups/deploy-status.json" || { echo "FAIL: status result"; exit 1; }
grep -q "\"to_commit\":\"$two\"" "$t/backups/deploy-status.json" || { echo "FAIL: status commit"; exit 1; }
grep -q "compose up -d" "$FAKE_LOG" || { echo "FAIL: did not restart"; exit 1; }
! grep -E "compose (up|run) " "$FAKE_LOG" | grep -v -- "--no-deps" | grep -q . || { echo "FAIL: a compose up/run without --no-deps"; exit 1; }
for f in "$t"/backups/bossman-*.sql.gz; do [[ "$(stat -c %a "$f")" == 600 ]] || { echo "FAIL: backup is not mode 600 under umask 022"; exit 1; }; done
git reset -q --hard "$three"
if PATH="$t/bin:$PATH" scripts/deploy.sh --no-runner --commit "$two" >/dev/null 2>&1; then echo "FAIL: went backwards"; exit 1; fi
if scripts/deploy.sh --commit abc >/dev/null 2>&1; then echo "FAIL: short hash accepted"; exit 1; fi
# With no BOSSMAN_BACKUP_DIR, backups and the status go to the install folder: the one holding the checkout.
git reset -q --hard "$one"
(unset BOSSMAN_BACKUP_DIR; PATH="$t/bin:$PATH" scripts/deploy.sh --yes --no-runner --commit "$two" >/dev/null)
grep -q "\"to_commit\":\"$two\"" "$t/deploy-status.json" || { echo "FAIL: default backup folder is not the install folder"; exit 1; }
ls "$t"/bossman-*.sql.gz >/dev/null || { echo "FAIL: no backup in the install folder"; exit 1; }
# A blue/green install is not deployed by this script.
git reset -q --hard "$one"; : >"$FAKE_LOG"
if COMPOSE_FILE=docker-compose.yml:deploy/truenas-bluegreen.yml PATH="$t/bin:$PATH" scripts/deploy.sh --yes --no-runner --commit "$two" >"$t/bg.out" 2>&1; then echo "FAIL: deploy.sh ran on a blue/green install"; exit 1; fi
grep -q "blue/green" "$t/bg.out" || { echo "FAIL: blue/green guard message"; exit 1; }
[[ ! -s $FAKE_LOG ]] || { echo "FAIL: blue/green guard ran docker"; exit 1; }
echo "deploy.test.sh: ok"
