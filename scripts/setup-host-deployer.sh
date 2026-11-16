#!/usr/bin/env bash
# Installs (or updates) the host deployer in one go (BOS-1580; docs/30-in-app-updates.md, docs/09-self-deploy.md).
# Run as root on the Docker host, from the Boss Man checkout. Safe to run twice: a second run changes nothing.
#
#   scripts/setup-host-deployer.sh   folders, script copy, .env and COMPOSE_FILE, one-minute timer, check
# The first copy of host-deployer.sh is made here; later refreshes go through scripts/install-deployer.sh (BOS-1588),
# the one copy step that deploys and the "deployer script is behind" card also use.
#   --dir <install folder>   holds src/ (this checkout) and deployer/. Default: the folder above this checkout.
#   --timer auto|cron|systemd|none   how the script runs every minute. auto: systemd if it runs, else cron, else
#                                    it prints what to set up (TrueNAS: the Cron Jobs form values). Default auto.
#   --no-compose             do not touch .env (COMPOSE_FILE, BOSSMAN_DEPLOYER)
#   --recreate-server        run `docker compose up -d server` afterwards when .env changed (restarts Boss Man ~1 min)
#   --no-tick                skip the final trial tick of the deployer
#   --dry-run                say what would change; change nothing
#   --yes                    accepted for the shared installer conventions (BOS-1579); this script never asks
# Output: one line per item, "ok" (already right), "changed" or "would change"; "FAIL" lines end with exit 1.
# Exit: 0 fine, 1 a step failed, 2 bad usage or not allowed (not root, odd layout).
#
# What it never does: write a token, link the copy into the checkout (a merged PR must not change what root runs),
# touch inbox/outbox contents, host.conf, state/ or any backup, or run docker unless --recreate-server.
# Test hooks (scripts/setup-host-deployer.test.sh): INSTALL_DEPLOYER_TEST=1 (no root check, no chown),
# BOSSMAN_ETC (default /etc), BOSSMAN_SYSTEMCTL (default systemctl).
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
SRC="$(cd "$here/.." && pwd)"
B="" TIMER=auto COMPOSE=1 RECREATE=0 TICK=1 DRY=0
usage() { sed -n '2,19p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//' >&2; exit 2; }
while (($#)); do
  case "$1" in
    --dir) [[ -n ${2:-} ]] || usage; B="$2"; shift ;;
    --timer) [[ ${2:-} =~ ^(auto|cron|systemd|none)$ ]] || usage; TIMER="$2"; shift ;;
    --no-compose) COMPOSE=0 ;;
    --recreate-server) RECREATE=1 ;;
    --no-tick) TICK=0 ;;
    --dry-run) DRY=1 ;;
    --yes) ;;
    -h|--help) usage ;;
    *) echo "Unknown option: $1" >&2; usage ;;
  esac
  shift
done

TEST="${INSTALL_DEPLOYER_TEST:-}"
ETC="${BOSSMAN_ETC:-/etc}" SYSTEMCTL="${BOSSMAN_SYSTEMCTL:-systemctl}"
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
if [[ -z $TEST && $(id -u) != 0 ]]; then echo "Run this as root (the deployer copy and its folders belong to root)." >&2; exit 2; fi
[[ -n $B ]] || B="$(dirname "$SRC")"
B="$(cd "$B" 2>/dev/null && pwd)" || { echo "The install folder does not exist." >&2; exit 2; }
if [[ $(cd "$B/src" 2>/dev/null && pwd -P || true) != "$(cd "$SRC" && pwd -P)" ]]; then
  echo "This checkout must be at $B/src (the host deployer looks for it there). Pass --dir with the folder that holds it." >&2; exit 2
fi
D="$B/deployer"
ROOT_USER=root SERVER_UID=1000
[[ -n $TEST ]] && ROOT_USER="$(id -un)" SERVER_UID="$(id -u)"
SERVER_GID="$SERVER_UID"; [[ -n $TEST ]] && SERVER_GID="$(id -g)"

changed=0 failed=0
say() { printf '%-14s %s\n' "$1" "$2"; }
did() { changed=$((changed + 1)); if ((DRY)); then say "would change" "$1"; else say changed "$1"; fi; }
ok() { say ok "$1"; }
bad() { failed=1; say FAIL "$1"; }

owner_of() { stat -c '%u:%g' "$1"; }

# ensure_dir <path> <uid> <gid> <mode>: create or correct one folder; never touches what is inside.
ensure_dir() {
  local p="$1" u="$2" g="$3" m="$4"
  if [[ -L $p ]]; then bad "$p is a link; refusing"; return; fi
  if [[ -d $p && $(owner_of "$p") == "$u:$g" && $(stat -c %a "$p") == "$m" ]]; then ok "folder $p"; return; fi
  did "folder $p (owner $u:$g, mode $m)"
  if ! ((DRY)); then mkdir -p "$p"; [[ -n $TEST ]] || chown "$u:$g" "$p"; chmod "$m" "$p"; fi
}

# write_file <path> <mode> <content>: replace a file only when the content or mode differs (atomic rename).
write_file() {
  local p="$1" m="$2" content="$3"
  if [[ -f $p && ! -L $p && $(cat "$p") == "$content" && $(stat -c %a "$p") == "$m" ]]; then ok "file $p"; return; fi
  did "file $p"
  if ! ((DRY)); then
    local t; t="$(mktemp "$p.XXXXXX")"; printf '%s\n' "$content" >"$t"; chmod "$m" "$t"; mv -f "$t" "$p"
  fi
}

# copy_script: the deployer runs from a COPY of the checkout's script, never a link.
copy_script() {
  local from="$SRC/scripts/host-deployer.sh" to="$D/host-deployer.sh"
  [[ -f $from ]] || { bad "$from is missing"; return; }
  if [[ -L $to ]]; then bad "$to is a link into somewhere else; remove it and run again (a link lets a merged change alter what root runs)"; return; fi
  if ! bash -n "$from"; then bad "$from does not parse; not copying"; return; fi
  if git -C "$SRC" rev-parse --git-dir >/dev/null 2>&1 && ! git -C "$SRC" diff --quiet HEAD -- scripts/host-deployer.sh 2>/dev/null; then
    bad "scripts/host-deployer.sh has uncommitted changes in the checkout; commit or discard them first (root must run reviewed code)"; return
  fi
  local rootown; rootown="$(id -u "$ROOT_USER"):$(id -g "$ROOT_USER")"
  if [[ -f $to ]] && cmp -s "$from" "$to" && [[ $(stat -c %a "$to") == 750 && $(owner_of "$to") == "$rootown" ]]; then
    ok "script copy $to"; return
  fi
  if [[ ! -f $to ]]; then
    # No copy yet: install-deployer.sh only refreshes an existing one, so the first copy is made here.
    did "script copy $to (first copy, from the checkout)"
    if ! ((DRY)); then
      local t; t="$(mktemp "$to.XXXXXX")"; cp "$from" "$t"; chmod 750 "$t"; [[ -n $TEST ]] || chown root:root "$t"; mv -f "$t" "$to"
    fi
  elif cmp -s "$from" "$to"; then
    did "script copy $to (owner and mode corrected)"
    if ! ((DRY)); then chmod 750 "$to"; [[ -n $TEST ]] || chown root:root "$to"; fi
  else
    did "script copy $to (refreshed by install-deployer.sh; the old one is kept as host-deployer.sh.old)"
    if ((DRY)); then BOSSMAN_DEPLOYER="$D" "$SRC/scripts/install-deployer.sh" --dry-run || bad "install-deployer.sh --dry-run reported a problem"
    else
      cp -p "$to" "$to.old"
      BOSSMAN_DEPLOYER="$D" "$SRC/scripts/install-deployer.sh" || bad "install-deployer.sh could not refresh $to (message above)"
    fi
  fi
}

# env_set: .env must name the deployer folder and the compose file that mounts it into the server.
env_changes=0
fix_env() {
  local env="$SRC/.env"
  if [[ ! -f $env ]]; then bad "$env is missing: install Boss Man first (docs/00-first-time-install.md)"; return; fi
  local new="" cf="" have_dep=0 have_cf=0 line dep
  while IFS= read -r line || [[ -n $line ]]; do
    case "$line" in
      BOSSMAN_DEPLOYER=*) have_dep=1; dep="${line#BOSSMAN_DEPLOYER=}"
        [[ $dep == "$D" ]] || say warning "BOSSMAN_DEPLOYER in .env is not this deployer folder; left as it is" ;;
      COMPOSE_FILE=*) have_cf=1; cf="${line#COMPOSE_FILE=}"
        if [[ $cf == *[\"\']* ]]; then bad "COMPOSE_FILE in .env is quoted; add :deploy/truenas-deployer.yml to it by hand"; return; fi
        if [[ :$cf: != *:deploy/truenas-deployer.yml:* ]]; then line="COMPOSE_FILE=$cf:deploy/truenas-deployer.yml"; fi ;;
    esac
    new+="$line"$'\n'
  done <"$env"
  ((have_dep)) || new+="BOSSMAN_DEPLOYER=$D"$'\n'
  ((have_cf)) || new+="COMPOSE_FILE=docker-compose.yml:deploy/truenas-deployer.yml"$'\n'
  if [[ $new == "$(cat "$env")"$'\n' ]]; then ok ".env (BOSSMAN_DEPLOYER, COMPOSE_FILE)"; return; fi
  did ".env (BOSSMAN_DEPLOYER and COMPOSE_FILE; the old file is kept as .env.bak-$(date +%Y%m%d%H%M))"
  env_changes=1
  if ! ((DRY)); then cp -p "$env" "$env.bak-$(date +%Y%m%d%H%M)"; printf '%s' "$new" >"$env"; fi
}

# timer: run the copy every minute (an hourly job makes an approved deploy wait up to an hour).
timer_kind() {
  [[ $TIMER == auto ]] || { echo "$TIMER"; return; }
  if command -v midclt >/dev/null 2>&1; then echo truenas
  elif [[ -d /run/systemd/system ]]; then echo systemd
  elif [[ -d $ETC/cron.d ]]; then echo cron
  else echo none; fi
}
install_timer() {
  local kind; kind="$(timer_kind)"
  case "$kind" in
    systemd)
      write_file "$ETC/systemd/system/boss-man-deployer.service" 644 "[Unit]
Description=Boss Man host deployer (one tick)

[Service]
Type=oneshot
ExecStart=$D/host-deployer.sh
StandardOutput=null"
      write_file "$ETC/systemd/system/boss-man-deployer.timer" 644 "[Unit]
Description=Run the Boss Man host deployer every minute

[Timer]
OnCalendar=minutely
AccuracySec=1s

[Install]
WantedBy=timers.target"
      if ((DRY)); then return; fi
      "$SYSTEMCTL" daemon-reload
      if "$SYSTEMCTL" is-enabled --quiet boss-man-deployer.timer 2>/dev/null && "$SYSTEMCTL" is-active --quiet boss-man-deployer.timer 2>/dev/null; then
        ok "timer boss-man-deployer.timer enabled and running"
      else
        did "timer boss-man-deployer.timer enabled and started"; "$SYSTEMCTL" enable --now boss-man-deployer.timer
      fi ;;
    cron)
      write_file "$ETC/cron.d/boss-man-deployer" 644 "* * * * * root $D/host-deployer.sh > /dev/null" ;;
    truenas)
      say manual "TrueNAS keeps cron jobs in its own database, so add one in System > Advanced > Cron Jobs > Add:"
      say "" "Command $D/host-deployer.sh, Run As User root, Schedule Custom with * in every field,"
      say "" "Hide Standard Output ticked, Hide Standard Error unticked, Enabled ticked." ;;
    *) say manual "No timer set up. Run $D/host-deployer.sh as root every minute (cron or a systemd timer)." ;;
  esac
}

ensure_dir "$D" "$(id -u "$ROOT_USER")" "$(id -g "$ROOT_USER")" 755
ensure_dir "$D/inbox" "$SERVER_UID" "$SERVER_GID" 750
ensure_dir "$D/outbox" "$(id -u "$ROOT_USER")" "$(id -g "$ROOT_USER")" 755
ensure_dir "$D/state" "$(id -u "$ROOT_USER")" "$(id -g "$ROOT_USER")" 700
copy_script
((COMPOSE == 0)) || fix_env
install_timer

if ((TICK && !DRY && !failed)); then
  # One real tick: with no request it only reads main and writes outbox/available.json.
  if "$D/host-deployer.sh" >/dev/null 2>&1 && [[ -f $D/outbox/available.json ]]; then ok "trial tick wrote outbox/available.json"; else bad "trial tick failed: run $D/host-deployer.sh by hand and read the error (can the checkout read its git remote?)"; fi
fi

if ((env_changes && !DRY)); then
  if ((RECREATE)); then
    (cd "$SRC" && docker compose up -d server) || bad "docker compose up -d server failed"
  else
    say next "the server must see the folders: run  cd $SRC && docker compose up -d server  (restarts Boss Man for about a minute), or rerun with --recreate-server"
  fi
fi
if ((failed)); then echo "Something failed; fix the FAIL lines above and run again."; exit 1; fi
if ((changed == 0)); then echo "Nothing to change: the deployer is already installed."; fi
if ((changed > 0 && DRY)); then echo "Dry run: $changed item(s) would change."; fi
# Undo: disable the timer (systemctl disable --now boss-man-deployer.timer, or remove the cron.d file), put back
# .env from .env.bak-*, and remove COMPOSE_FILE's deploy/truenas-deployer.yml; docs/30 "Turn it off".
exit 0
