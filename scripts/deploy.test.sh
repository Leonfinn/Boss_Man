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
check packages/shared/src/i.ts yes
check pnpm-lock.yaml yes
check apps/runner-extra/y no
# BOS-1648: only what the image builds COPY in counts; tests beside the code don't, a script the runner image copies does.
check packages/shared/test/i.test.ts no
check apps/runner/test/r.test.ts no
check scripts/check-slot.sh yes
check apps/server/package.json no

# --commit deploys exactly that commit even when main has moved on, using a fake docker.
cd /; t="$(mktemp -d)"; trap 'rm -rf "$d" "$t"' EXIT
git init -q --bare -b main "$t/origin.git"
git clone -q "$t/origin.git" "$t/src" 2>/dev/null; cd "$t/src"; git config user.email t@t; git config user.name t
mkdir scripts; cp "$here/deploy.sh" "$here/prune-build-cache.sh" scripts/; echo 1 >f; git add -A; git commit -qm one; git push -q origin HEAD:main 2>/dev/null; git fetch -q
git branch -q --set-upstream-to=origin/main main; git remote set-head origin main >/dev/null
one="$(git rev-parse HEAD)"; echo 2 >f; git commit -qam two; two="$(git rev-parse HEAD)"; echo 3 >f; git commit -qam three; three="$(git rev-parse HEAD)"
git push -q origin HEAD:main 2>/dev/null; git reset -q --hard "$one"
mkdir "$t/bin"; cat >"$t/bin/docker" <<'FAKE'
#!/usr/bin/env bash
echo "docker $*" >>"$FAKE_LOG"
case "$*" in
  *"builder prune"*) echo "Total: 1GB"; exit "${FAKE_PRUNE_RC:-0}" ;;
  *pg_dump*) echo dump ;; *"config --services"*) printf 'server\nbackup\n' ;; *"ps -q"*) echo cid ;; *inspect*) echo "${FAKE_HEALTH:-healthy}" ;;
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
# BOS-2924: the build cache is pruned once, after the build finished and before anything restarts.
[[ $(grep -c "builder prune --force --filter until=168h" "$FAKE_LOG") == 1 ]] || { echo "FAIL: did not prune the build cache once"; exit 1; }
b=$(grep -n "compose build" "$FAKE_LOG" | head -1 | cut -d: -f1); p=$(grep -n "builder prune" "$FAKE_LOG" | head -1 | cut -d: -f1); u=$(grep -n "compose up -d" "$FAKE_LOG" | head -1 | cut -d: -f1)
((b < p && p < u)) || { echo "FAIL: the prune was not between the build and the restart ($b, $p, $u)"; exit 1; }
# BOS-2176: an update also starts the daily backup service (an older install would never get it otherwise).
grep -q "compose up -d --no-deps backup" "$FAKE_LOG" || { echo "FAIL: did not ensure the daily backup service"; exit 1; }
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
# BOS-867: the restore help follows Guide 10: test the backup, keep a copy, stop at the first error.
grep -q "scripts/restore-test.sh" "$t/unhealthy.out" || { echo "FAIL: rollback help doesn't ask to test the backup"; exit 1; }
grep -q "before-restore-" "$t/unhealthy.out" || { echo "FAIL: rollback help doesn't keep a copy of the current data"; exit 1; }
grep -q "ON_ERROR_STOP=1" "$t/unhealthy.out" || { echo "FAIL: restore load doesn't stop at the first error"; exit 1; }
grep -q "To go back to the old code (does not touch the database)" "$t/unhealthy.out" || { echo "FAIL: the old-code rollback line changed"; exit 1; }
# BOS-874: Guide 10's last two steps: check the restore worked, and how to undo it.
grep -q "api/ready" "$t/unhealthy.out" || { echo "FAIL: rollback help doesn't ask to check the restore"; exit 1; }
grep -q "To undo the restore" "$t/unhealthy.out" || { echo "FAIL: rollback help doesn't say how to undo the restore"; exit 1; }
grep -q "before-restore-" "$t/unhealthy.out" || { echo "FAIL: undo step doesn't use step 3's copy"; exit 1; }
# BOS-882: the undo step must name step 3's file, not work out a new timestamp minutes later (which never matches).
undo="$(grep "To undo the restore" "$t/unhealthy.out")"
! grep -q 'date +%F-%H%M' <<<"$undo" || { echo "FAIL: undo step works out a fresh timestamp instead of naming step 3's file"; exit 1; }
grep -q 'ls -t ../before-restore-\*.sql.gz | head -1' <<<"$undo" || { echo "FAIL: undo step doesn't say how to find step 3's file"; exit 1; }
! grep -Eq '([0-9]{1,3}\.){3}[0-9]{1,3}' "$t/unhealthy.out" || { echo "FAIL: rollback help hard-codes an IP address"; exit 1; }
# A restart (BOS-647): --force at the commit that runs recreates the server (an unchanged image would leave it running),
# leaves the launcher alone and keeps the rollback record, so --rollback still goes back to the release before.
git reset -q --hard "$one"; : >"$FAKE_LOG"
PATH="$t/bin:$PATH" scripts/deploy.sh --yes --no-runner --commit "$two" >/dev/null
[[ $(cat "$t/backups/deploy-status.previous-commit") == "$one" ]] || { echo "FAIL: setup: rollback record"; exit 1; }
: >"$FAKE_LOG"
PATH="$t/bin:$PATH" scripts/deploy.sh --yes --no-runner --force --commit "$two" >"$t/force.out" 2>&1 || { echo "FAIL: --force at the same commit"; cat "$t/force.out"; exit 1; }
# BOS-2924: a build cache prune that fails changes nothing about the result.
: >"$FAKE_LOG"
FAKE_PRUNE_RC=1 PATH="$t/bin:$PATH" scripts/deploy.sh --yes --no-runner --force --commit "$two" >"$t/prunefail.out" 2>&1 || { echo "FAIL: a failing build cache prune failed the deploy"; cat "$t/prunefail.out"; exit 1; }
grep -q "builder prune" "$FAKE_LOG" || { echo "FAIL: the failing prune was not tried"; exit 1; }
grep -q '"result":"deployed"' "$t/backups/deploy-status.json" || { echo "FAIL: status after a failing prune"; exit 1; }
[[ $(git rev-parse HEAD) == "$two" ]] || { echo "FAIL: --force at the same commit moved the checkout"; exit 1; }
grep -q "compose up -d --no-deps --force-recreate server$" "$FAKE_LOG" || { echo "FAIL: --force at the same commit did not recreate the server"; cat "$FAKE_LOG"; exit 1; }
[[ $(cat "$t/backups/deploy-status.previous-commit") == "$one" ]] || { echo "FAIL: --force at the same commit overwrote the rollback record"; exit 1; }
grep -q '"result":"deployed"' "$t/backups/deploy-status.json" || { echo "FAIL: restart status"; exit 1; }
# An ordinary deploy does not recreate anything twice.
git reset -q --hard "$one"; : >"$FAKE_LOG"
PATH="$t/bin:$PATH" scripts/deploy.sh --yes --no-runner --commit "$two" >/dev/null
! grep -q -- "--force-recreate" "$FAKE_LOG" || { echo "FAIL: a normal deploy force-recreated"; exit 1; }
# BOS-1588: a good deploy refreshes the host's copy of the deployer; a refresh that can't be done only warns.
cp "$here/install-deployer.sh" scripts/; printf '#!/usr/bin/env bash\necho fresh\n' >scripts/host-deployer.sh
mkdir -p "$t/deployer"; chmod 755 "$t/deployer"; printf 'stale\n' >"$t/deployer/host-deployer.sh"; chmod 750 "$t/deployer/host-deployer.sh"
git reset -q --hard "$one"; : >"$FAKE_LOG"
PATH="$t/bin:$PATH" scripts/deploy.sh --yes --no-runner --commit "$two" >"$t/refresh.out" 2>&1 || { echo "FAIL: deploy with a deployer copy"; cat "$t/refresh.out"; exit 1; }
cmp -s scripts/host-deployer.sh "$t/deployer/host-deployer.sh" || { echo "FAIL: deploy did not refresh the deployer copy"; exit 1; }
printf 'stale\n' >"$t/deployer/host-deployer.sh"; chmod 777 "$t/deployer"; git reset -q --hard "$one"
PATH="$t/bin:$PATH" scripts/deploy.sh --yes --no-runner --commit "$two" >"$t/refresh.out" 2>&1 || { echo "FAIL: a refresh failure failed the deploy"; cat "$t/refresh.out"; exit 1; }
grep -q "deployer copy was not refreshed" "$t/refresh.out" || { echo "FAIL: no warning when the refresh failed"; exit 1; }
chmod 755 "$t/deployer"
# The readable-check is one text in the three scripts.
for s in rebuild-live host-deployer; do
  [[ "$(sed -n '/^# BEGIN readable-check/,/^# END readable-check/p' "$here/$s.sh")" == "$(sed -n '/^# BEGIN readable-check/,/^# END readable-check/p' "$here/deploy.sh")" ]] || { echo "FAIL: readable-check in $s.sh differs from deploy.sh"; exit 1; }
done
echo "deploy.test.sh: ok"
