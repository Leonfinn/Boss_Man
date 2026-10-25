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
D="${BOSSMAN_DEPLOYER:-/mnt/NVME_Apps/Container_files/boss-man/deployer}"
BACKUP_DIR="${BOSSMAN_BACKUP_DIR:-/mnt/NVME_Apps/Container_files/boss-man}"
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
docker compose exec -T db pg_dump -U bossman bossman | gzip >"$backup.partial" || { rm -f "$backup.partial"; die "the backup failed; nothing was changed."; }
{ [[ -s $backup.partial ]] && gzip -t "$backup.partial"; } || { rm -f "$backup.partial"; die "the backup is empty or damaged; nothing was changed."; }
mv "$backup.partial" "$backup"
ls -l "$backup"

step "2/5 Build server-$colour"
BOSSMAN_COMMIT="$commit" docker compose build "server-$colour" || die "the build failed; $colour still runs its old image. Backup: $backup"

step "3/5 Migrate"
BOSSMAN_MIGRATE_TAG="$colour" docker compose run --rm migrate || die "the migration failed; $colour still runs its old image. Backup: $backup"

step "4/5 Restart server-$colour and tell it to take charge"
docker compose up -d --no-deps --force-recreate "server-$colour" || die "the restart failed. Backup: $backup"
# Green starts as a standby and only contests the leader lock after SIGUSR2; blue contests anyway, so it's harmless there.
docker compose kill -s SIGUSR2 "server-$colour" || die "couldn't signal server-$colour; send it by hand: docker compose kill -s SIGUSR2 server-$colour"

step "5/5 Wait until it leads at ${commit:0:7}"
field() { python3 -I -c 'import json,sys; print(json.load(sys.stdin).get(sys.argv[1], ""))' "$1" 2>/dev/null || true; }
end=$((SECONDS + WAIT_SECONDS)) body="" sent=$SECONDS
while :; do
  body="$(docker compose exec -T "server-$colour" node -e "fetch('http://127.0.0.1:3100/api/ready').then(async r=>{console.log(await r.text())}).catch(()=>{})" 2>/dev/null || true)"
  role="$(field role <<<"$body")"
  if [[ $(field ok <<<"$body") == True && $role == leader && $(field commit <<<"$body") == "$commit" ]]; then
    echo "server-$colour leads at ${commit:0:7}. Done. Backup: $backup"
    exit 0
  fi
  # A server that came up after the first signal missed it: ask again every 30 seconds while it's a standby.
  if [[ $role == standby ]] && ((SECONDS - sent >= 30)); then docker compose kill -s SIGUSR2 "server-$colour" >/dev/null 2>&1 || true; sent=$SECONDS; fi
  ((SECONDS < end)) || break
  sleep "$POLL_SECONDS"
done
echo "Last answer from /api/ready: ${body:-none}"
docker compose logs --tail 200 "server-$colour" 2>&1 | grep LEADER | tail -5 || true
die "server-$colour didn't become leader at ${commit:0:7} within ${WAIT_SECONDS}s. If another colour is running, it may hold the lock: docker compose ps. Backup: $backup"
