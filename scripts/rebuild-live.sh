#!/usr/bin/env bash
# Rebuilds the live blue/green colour in place (docs/06, "Rebuild the live colour in place"), for a change
# the host deployer refuses (a Dockerfile, compose or script change) or a colour built from an older image.
# For ordinary app changes use Settings → Updates → Deploy latest instead: that swaps colours with no downtime.
#
# One step, so the server is never left on standby: back up the database, build the live colour at the
# checkout's commit, migrate, recreate it, tell it to take charge (SIGUSR2), and wait until /api/ready says
# it leads at that commit. Stops at the first failure and says which step. The UI is down for about 20-30s.
#
#   scripts/rebuild-live.sh            the colour the proxy points at ($BOSSMAN_DEPLOYER/proxy/active.caddy)
#   scripts/rebuild-live.sh green      name it yourself
set -euo pipefail
cd "$(dirname "$0")/.."
# Defaults follow the install layout: <install folder>/src (this checkout) and <install folder>/deployer.
INSTALL_DIR="$(cd .. && pwd)"
D="${BOSSMAN_DEPLOYER:-$INSTALL_DIR/deployer}"
BACKUP_DIR="${BOSSMAN_BACKUP_DIR:-$INSTALL_DIR}"
WAIT_SECONDS="${REBUILD_WAIT_SECONDS:-180}" POLL_SECONDS="${REBUILD_POLL_SECONDS:-3}"
export BOSSMAN_DEPLOYER="$D"
step() { printf '\n== %s\n' "$*"; }
die() { printf '\nSTOPPED: %s\n' "$*" >&2; exit 1; }

# The live colour, read the way host-deployer.sh reads it; the include is never followed through a symlink.
colour="${1:-}"
if [[ -z $colour ]]; then
  include="$D/proxy/active.caddy"
  [[ -f $include && ! -L $include ]] || die "can't find which colour is live ($include). Name it: scripts/rebuild-live.sh blue|green"
  colour="$(sed -n 's/^[[:space:]]*reverse_proxy server-\(blue\|green\):.*/\1/p' "$include" | head -1)"
fi
[[ $colour == blue || $colour == green ]] || die "the colour must be blue or green, not '$colour'."
commit="$(git rev-parse HEAD)"
echo "Rebuilding the live colour, $colour, at commit ${commit:0:7}."

step "1/5 Back up the database"
backup="$BACKUP_DIR/rebuild-$(date +%F-%H%M).sql.gz"
mkdir -p "$BACKUP_DIR"
(umask 077; docker compose exec -T db pg_dump -U bossman bossman | gzip >"$backup.partial") || { rm -f "$backup.partial"; die "the backup failed; nothing was changed."; }
{ [[ -s $backup.partial ]] && gzip -t "$backup.partial"; } || { rm -f "$backup.partial"; die "the backup is empty or damaged; nothing was changed."; }
mv "$backup.partial" "$backup"
# Same retention as deploy.sh and the host deployer: only rebuild-*.sql.gz, newest 14 kept.
old="$(find "$BACKUP_DIR" -maxdepth 1 -type f -name 'rebuild-*.sql.gz' -printf '%T@ %p\n' | sort -rn | tail -n +15 | cut -d' ' -f2-)"
[[ -z $old ]] || while IFS= read -r f; do rm -f -- "$f"; done <<<"$old"
ls -l "$backup"

step "2/5 Build server-$colour"
BOSSMAN_COMMIT="$commit" docker compose build "server-$colour" || die "the build failed; $colour still runs its old image. Backup: $backup"

step "3/5 Migrate"
BOSSMAN_MIGRATE_TAG="$colour" docker compose run --rm --no-deps migrate || die "the migration failed; $colour still runs its old image. Backup: $backup"

step "4/5 Restart server-$colour"
docker compose up -d --no-deps --force-recreate "server-$colour" || die "the restart failed. Backup: $backup"

step "5/5 Tell it to take charge and wait until it leads at ${commit:0:7}"
# The host (TrueNAS) has no node, jq or python, so /api/ready is read inside the container, which prints "ok role commit"
# (or nothing while the server isn't answering). Green starts as a standby and only contests the leader lock after
# SIGUSR2; blue contests anyway, so the signal is harmless there. A signal sent before the server is listening is lost
# (node as PID 1 ignores it), so the first one goes out only once /api/ready answers, then again every 30 s while standby.
probe() { docker compose exec -T "server-$colour" node -e "fetch('http://127.0.0.1:3100/api/ready').then(async r=>{const o=await r.json();console.log(String(o.ok===true),o.role||'-',o.commit||'-')}).catch(()=>{})" 2>/dev/null || true; }
end=$((SECONDS + WAIT_SECONDS)) ok="" role="" got="" sent=-1 answer="" last_role="none (it never answered)"
while :; do
  answer="$(probe)"
  ok="" role="" got=""
  read -r ok role got <<<"$answer" || true
  if [[ -n $role ]]; then last_role="$role"; fi
  if [[ $ok == true && $role == leader && $got == "$commit" ]]; then
    echo "server-$colour leads at ${commit:0:7}. Done. Backup: $backup"
    exit 0
  fi
  if [[ $role == standby ]] && { ((sent < 0)) || ((SECONDS - sent >= 30)); }; then
    echo "server-$colour is a standby; telling it to take charge."
    docker compose kill -s SIGUSR2 "server-$colour" >/dev/null 2>&1 || true; sent=$SECONDS
  fi
  ((SECONDS < end)) || break
  sleep "$POLL_SECONDS"
done
echo "Last answer from /api/ready: ${answer:-none}"
docker compose logs --tail 200 "server-$colour" 2>&1 | grep LEADER | tail -5 || true
die "server-$colour didn't become leader at ${commit:0:7} within ${WAIT_SECONDS}s. Last role seen: $last_role. To tell it to take charge by hand: docker compose kill -s SIGUSR2 server-$colour. If another colour is running, it may hold the lock: docker compose ps. Backup: $backup"
