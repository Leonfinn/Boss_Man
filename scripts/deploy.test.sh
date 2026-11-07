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
  *pg_dump*) echo dump ;; *"config --services"*) echo server ;; *"ps -q"*) echo cid ;; *inspect*) echo "${FAKE_HEALTH:-healthy}" ;;
  *"logs --no-color"*) echo "Error: EACCES: permission denied, open '/app/x.ts'" ;;
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
# BOS-562: a root shell with umask 077 must not leave the checkout unreadable for the server (user node).
git reset -q --hard "$one"; : >"$FAKE_LOG"; rm -f "$t"/backups/bossman-*.sql.gz
(umask 077; PATH="$t/bin:$PATH" scripts/deploy.sh --yes --no-runner --commit "$two" >/dev/null)
[[ $(stat -c %a f) == 644 ]] || { echo "FAIL: umask 077 left f as mode $(stat -c %a f), not 644"; exit 1; }
# A tracked file others can't read: stop before the backup and build, change nothing, name the file and the fix.
git reset -q --hard "$one"; : >"$FAKE_LOG"; rm -f "$t"/backups/bossman-*.sql.gz; chmod 600 f; chmod 700 scripts
if PATH="$t/bin:$PATH" scripts/deploy.sh --yes --no-runner --commit "$two" >"$t/unread.out" 2>&1; then echo "FAIL: deployed with unreadable files"; exit 1; fi
grep -q "^  f$" "$t/unread.out" || { echo "FAIL: f not listed"; exit 1; }
grep -q "^  scripts$" "$t/unread.out" || { echo "FAIL: unreadable files not listed"; cat "$t/unread.out"; exit 1; }
grep -q "chmod go+r" "$t/unread.out" || { echo "FAIL: no fix printed"; exit 1; }
[[ ! -s $FAKE_LOG ]] || { echo "FAIL: ran docker despite unreadable files"; exit 1; }
[[ $(git rev-parse HEAD) == "$one" ]] || { echo "FAIL: moved the checkout despite unreadable files"; exit 1; }
ls "$t"/backups/bossman-*.sql.gz >/dev/null 2>&1 && { echo "FAIL: made a backup despite unreadable files"; exit 1; }
# The printed fix works, and the deploy then goes through.
eval "$(sed -n 's/^  cd /cd /p' "$t/unread.out")"
PATH="$t/bin:$PATH" scripts/deploy.sh --yes --no-runner --commit "$two" >/dev/null || { echo "FAIL: deploy after the fix"; exit 1; }
# Untracked private files (.env at 600, secrets/ at 700) are not checked: the deploy goes through and leaves them private.
git reset -q --hard "$one"; : >"$FAKE_LOG"
echo SECRET=x >.env; chmod 600 .env; mkdir -p secrets; echo k >secrets/key; chmod 600 secrets/key; chmod 700 secrets
PATH="$t/bin:$PATH" scripts/deploy.sh --yes --no-runner --commit "$two" >"$t/private.out" 2>&1 || { echo "FAIL: a private .env or secrets/ stopped the deploy"; cat "$t/private.out"; exit 1; }
grep -q "compose build" "$FAKE_LOG" || { echo "FAIL: did not build with a private .env"; exit 1; }
[[ $(stat -c %a .env) == 600 && $(stat -c %a secrets) == 700 && $(stat -c %a secrets/key) == 600 ]] || { echo "FAIL: deploy changed the modes of .env or secrets/"; exit 1; }
# A server that never gets healthy: the rollback help shows the last lines of the server log.
git reset -q --hard "$one"; : >"$FAKE_LOG"
if FAKE_HEALTH=unhealthy BOSSMAN_HEALTH_TIMEOUT=1 PATH="$t/bin:$PATH" scripts/deploy.sh --yes --no-runner --commit "$two" >"$t/unhealthy.out" 2>&1; then echo "FAIL: an unhealthy server reported success"; exit 1; fi
grep -q "Last 20 lines of the server log" "$t/unhealthy.out" || { echo "FAIL: no log header in the rollback help"; exit 1; }
grep -q "EACCES: permission denied" "$t/unhealthy.out" || { echo "FAIL: rollback help didn't show the server log"; exit 1; }
grep -q "compose logs --no-color --tail 20 server" "$FAKE_LOG" || { echo "FAIL: didn't ask for 20 log lines"; exit 1; }
# The readable-check is one text in the three scripts.
for s in rebuild-live host-deployer; do
  [[ "$(sed -n '/^# BEGIN readable-check/,/^# END readable-check/p' "$here/$s.sh")" == "$(sed -n '/^# BEGIN readable-check/,/^# END readable-check/p' "$here/deploy.sh")" ]] || { echo "FAIL: readable-check in $s.sh differs from deploy.sh"; exit 1; }
done
echo "deploy.test.sh: ok"
