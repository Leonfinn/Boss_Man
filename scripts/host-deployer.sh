#!/usr/bin/env bash
# Host deployer (self-deploy phase 1, docs/09-self-deploy.md). Run as root by a TrueNAS cron job
# every minute. Install a COPY of this file in the deployer folder; never run it from the git
# checkout, so a merged change cannot alter what root runs (docs/06-install-truenas.md).
#
#   host-deployer.sh              handle one request, if there is one
#   host-deployer.sh --dry-run    run every check and say what would happen; changes nothing
#   host-deployer.sh --rollback   blue/green only, by hand on the host, as root: go back to the other colour (the
#                                 previous release), also after the 15-minute window. With --dry-run it only checks.
#
# It reads one small request file the server wrote, treats it as data only, checks it, and runs
# one of two fixed actions: scripts/deploy.sh (target "server") or scripts/update-runner.sh
# (target "runner"). Nothing from the request is ever executed or put on a command line unchecked.
#
# Settings: environment, then the optional config file $BOSSMAN_DEPLOYER/host.conf (shell
# KEY=value lines; must be owned by the user running this and not writable by anyone else):
#   BOSSMAN_DEPLOYER   the deployer folder       (the folder this copy is in)
#   REPO               the git checkout          ($BOSSMAN_DEPLOYER/../src)
#   WEBHOOK_URL        POSTed on failure; empty = off
#   WEBHOOK_ON_SUCCESS 1 = also POST on success  (0)
#   RATE_LIMIT_SECONDS min gap between two runs of the same target (600)
#   AVAILABLE_REFRESH_SECONDS  how often to look for a new commit on main (300); sooner when the server
#                              leaves inbox/check ("Deploy latest" found nothing new; only its existence is read)
#   SOAK_SECONDS       blue/green: how long the old colour stays up as a standby after a good swap (900); also
#                      published in available.json, so Boss Man's runner-update trial uses the same length
#   SOAK_CHECK_SECONDS blue/green: how long a failing check during that window is retried before the automatic switch-back (60)
#
# Blue/green (docs/09-self-deploy.md, "Phase 3, part 2"): when COMPOSE_FILE (environment or the checkout's .env)
# names deploy/truenas-bluegreen.yml, target "server" does a zero-downtime colour swap instead of deploy.sh.
# Without that, nothing under the "Blue/green" heading runs.
set -euo pipefail

DRY=0 ROLLBACK=0 ACK=0
for arg in "$@"; do
  case "$arg" in --dry-run) DRY=1 ;; --rollback) ROLLBACK=1 ;; --ack-health) ACK=1 ;; *) echo "Usage: $0 [--dry-run] | --rollback [--dry-run] | --ack-health" >&2; exit 2 ;; esac
done

export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin # cron's PATH is minimal
# The copy lives in the deployer folder, which sits beside the checkout (src) in the install folder.
D="${BOSSMAN_DEPLOYER:-$(cd "$(dirname "$0")" && pwd)}"
REPO="$D/../src"
WEBHOOK_URL="" WEBHOOK_ON_SUCCESS=0 RATE_LIMIT_SECONDS=600 AVAILABLE_REFRESH_SECONDS=300
BG_POLL_SECONDS="${BG_POLL_SECONDS:-2}" BG_READY_SECONDS="${BG_READY_SECONDS:-120}" BG_HANDOVER_SECONDS="${BG_HANDOVER_SECONDS:-30}" SOAK_SECONDS="${SOAK_SECONDS:-900}" SOAK_CHECK_SECONDS="${SOAK_CHECK_SECONDS:-60}"
CONF="$D/host.conf"
if [[ -e $CONF ]]; then
  [[ ! -L $CONF && $(stat -c %u "$CONF") == "$(id -u)" && $(stat -c %a "$CONF") =~ ^[0-7]00$ ]] || { echo "ERROR: $CONF must be a plain file, owned by $(id -un), mode 600." >&2; exit 1; }
  # shellcheck disable=SC1090
  source "$CONF"
fi
INBOX="$D/inbox" OUTBOX="$D/outbox" STATE="$D/state" LOG="$D/deployer.log"
# Files that change how Boss Man runs or deploys. Build-only scripts (make-app-icons, check-*, test-*, lint-migrations, backups) are not on it (BOS-269);
# docs/09-self-deploy.md lists the same files.
INFRA='^(docker-compose[^/]*\.ya?ml$|deploy/|scripts/(deploy|rebuild-live|update-runner|host-deployer)\.sh$|\.dockerignore$|\.npmrc$|\.env|(.*/)?Dockerfile[^/]*$)'
# Under deploy/ but never used by Boss Man's own containers: the Penpot add-on is its own Compose project (docs/15).
NOT_INFRA='^deploy/(penpot|ntfy|ntfy-bluegreen)\.yml$'
# Same rule as needs_runner in scripts/deploy.sh (scripts/host-deployer.test.sh keeps them equal).
RUNNER_PATHS='^(apps/runner/|apps/launcher/|apps/netguard/|packages/shared/|pnpm-lock\.yaml$)'

# Git as root must not run hooks from a checkout that agents' commits land in; deploy.sh inherits this.
export GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.hooksPath GIT_CONFIG_VALUE_0=/dev/null GIT_TERMINAL_PROMPT=0
# Every git command that can write the checkout runs under umask 022: from a root shell or cron with umask 077 it would leave files the server (user node) cannot read (BOS-562).
g() { (umask 022; git -C "$REPO" "$@"); }
# BEGIN readable-check (the same text is in rebuild-live.sh, host-deployer.sh and deploy.sh; deploy.test.sh keeps them equal)
# BOS-562: the server image copies file modes as they are on disk and the server runs as user node, so a git-tracked
# file that others can't read (or a folder they can't read and search) makes it crash at start. Reads modes only and
# changes nothing. Only tracked paths count: .env, secrets/ and the data folder must stay private.
unreadable_tracked() { # checkout folder: the tracked files and folders others can't use, one path per line
  (
    cd "$1" || exit 0
    {
      git ls-files -z | xargs -0 -r stat -c 'f %a %n' --
      { echo .; git -c core.quotepath=off ls-files | awk '{ while (sub("/[^/]*$", "")) print }'; } | sort -u | tr '\n' '\0' | xargs -0 -r stat -c 'd %a %n' --
    } 2>/dev/null | while read -r kind mode path; do
      m=$((8#$mode))
      if [[ $kind == f ]]; then ((m & 4)) || printf '%s\n' "$path"; else (((m & 5) == 5)) || printf '%s\n' "$path"; fi
    done
  ) || true
}
readable_problem() { # checkout folder: prints nothing when all is readable, else the message with the fix
  local dir bad n
  dir="$(cd "$1" && pwd)" || return 0
  bad="$(unreadable_tracked "$dir")"
  [[ -n $bad ]] || return 0
  n="$(grep -c '' <<<"$bad")"
  printf "%s file(s) or folder(s) in %s can't be read by the server, which runs as user node and gets the permissions the files have on disk, so it would crash when it starts (a root shell with umask 077 does this to every file git writes). First %s:\n%s\nFix, then run this again:\n  cd %q && git ls-files -z | xargs -0 chmod go+r && git ls-files | awk '{ while (sub(\"/[^/]*\$\", \"\")) print }' | sort -u | xargs -d '\\\\n' chmod go+rx && chmod go+rx ." \
    "$n" "$dir" "$((n < 10 ? n : 10))" "$(head -n 10 <<<"$bad" | sed 's/^/  /')" "$dir"
}
# END readable-check

now() { date -u +%Y-%m-%dT%H:%M:%SZ; }
log() { ((DRY)) || printf '%s %s\n' "$(now)" "$*" >>"$LOG"; printf '%s\n' "$*"; }
# JSON string literal for a value: escapes \ and ", writes newline/CR/tab as escapes and drops other control characters.
jstr() {
  local s=$1
  s=${s//\\/\\\\}; s=${s//\"/\\\"}; s=${s//$'\n'/\\n}; s=${s//$'\r'/\\r}; s=${s//$'\t'/\\t}
  s=${s//[[:cntrl:]]/}
  printf '"%s"' "$s"
}
json() { # key=value ...: a flat object of strings, written as {"k": "v", ...} and a newline
  local a out="" sep=""
  for a in "$@"; do out+="$sep$(jstr "${a%%=*}"): $(jstr "${a#*=}")"; sep=", "; done
  printf '{%s}\n' "$out"
}
# The value of a top-level string, number or boolean field of a flat JSON text on stdin; empty when absent or not simple.
# Booleans print True/False because callers compare against "True". Only reads; nothing from the text is executed.
jfield() { # field
  local line
  line="$(LC_ALL=C tr -d '\n\r' | LC_ALL=C grep -oE "\"$1\"[[:space:]]*:[[:space:]]*(\"[^\"\\\\]*\"|true|false|-?[0-9]+)" | head -n 1)" || true
  line="${line#*:}"; line="${line#"${line%%[![:space:]]*}"}"
  case $line in true) echo True ;; false) echo False ;; \"*) line="${line#\"}"; printf '%s' "${line%\"}" ;; *) printf '%s' "$line" ;; esac
}

[[ -d $INBOX && -d $OUTBOX ]] || { echo "ERROR: $INBOX and $OUTBOX must exist (docs/06-install-truenas.md, Install the host deployer)." >&2; exit 1; }
mkdir -p "$STATE"
exec 9>"$D/lock"
if ((ROLLBACK)); then flock -w 120 9 || { echo "ERROR: another deployer run holds the lock; try again in a minute." >&2; exit 1; }
else flock -n 9 || exit 0; fi # a run is already going; the next minute tries again

REQ_ID="" TARGET="" COMMIT="" STARTED="" FROM=""
HEALTH_KV=() # the latest whole-stack checklist as key=value pairs (stack, check_*), merged into the status file

write_status() { # result message [backup]
  ((DRY)) && { log "[dry-run] status: $1: $2"; return 0; }
  local ended=""
  [[ $1 == running ]] || ended="$(now)"
  local soak=0 # the standby window this host really uses (BOS-401): the server holds the runner update for it
  if bluegreen_enabled; then soak="$SOAK_SECONDS"; fi
  json id="$REQ_ID" target="$TARGET" result="$1" message="$2" from_commit="$FROM" to_commit="$COMMIT" started="$STARTED" ended="$ended" at="${ended:-$STARTED}" backup="${3:-}" soak_seconds="$soak" ${HEALTH_KV[@]+"${HEALTH_KV[@]}"} >"$OUTBOX/status.json.tmp"
  chmod 644 "$OUTBOX/status.json.tmp"
  mv "$OUTBOX/status.json.tmp" "$OUTBOX/status.json"
  [[ $1 == running ]] || cat "$OUTBOX/status.json" >>"$OUTBOX/history.jsonl"
}

post_webhook() { # result message
  [[ -n $WEBHOOK_URL ]] || return 0
  case $1 in deployed | nothing_new) [[ $WEBHOOK_ON_SUCCESS == 1 ]] || return 0 ;; esac
  if ((DRY)); then log "[dry-run] would POST $1 to the webhook"; return 0; fi
  json result="$1" message="$2" from_commit="$FROM" to_commit="$COMMIT" at="$(now)" |
    curl -fsS --max-time 15 -X POST -H 'Content-Type: application/json' --data-binary @- -K <(printf 'url = "%s"\n' "$WEBHOOK_URL") >/dev/null 2>>"$LOG" || log "The webhook POST failed."
}

finish() { # result message [backup]: record the outcome, tell the owner, stop
  log "$1: $2"
  write_status "$@"
  post_webhook "$1" "$2"
  exit 0
}

# The newest commit on main as the remote says it, read over whatever origin uses (https for a public repo, or an SSH remote with a read-only deploy key for a private one; docs/00 step 2). Empty if unreachable.
remote_tip() { g ls-remote origin refs/heads/main 2>/dev/null | awk '$2 == "refs/heads/main" { print $1 }' || true; }

# Tells the server what is waiting (when main is ahead of what runs), so it can raise the decision.
refresh_available() {
  local f="$OUTBOX/available.json" asked=0
  # rm -f removes a symlink itself, never what it points at.
  if [[ -e $INBOX/check || -L $INBOX/check ]]; then asked=1; ((DRY)) || rm -f "$INBOX/check"; fi
  if ((!asked)) && [[ -e $f && -z $(find "$f" -mmin +$((AVAILABLE_REFRESH_SECONDS / 60)) 2>/dev/null) ]]; then return 0; fi
  ((DRY)) && { log "[dry-run] would refresh $f"; return 0; }
  local head tip commits="$STATE/avail.commits" paths="$STATE/avail.paths"
  head="$(g rev-parse HEAD)"; tip="$(remote_tip)"
  [[ -n $tip ]] || { log "Could not read main from origin; will try again."; return 0; }
  [[ $tip != "$(cat "$STATE/hold" 2>/dev/null)" ]] || tip="$head" # held after a manual rollback until main moves on
  : >"$commits"; : >"$paths"
  if [[ $tip != "$head" ]]; then
    g fetch --quiet origin main || { log "git fetch failed; will try again."; return 0; }
    if g merge-base --is-ancestor "$head" "$tip"; then
      g log --format='%H %s' -n 30 "$head..$tip" >"$commits"
      g diff --name-only "$head" "$tip" >"$paths"
    else
      tip="" # main is not a fast-forward of what runs: nothing can be offered
    fi
  fi
  local out="" sep="" line sha p
  while IFS= read -r line; do
    [[ -n ${line//[[:space:]]/} ]] || continue
    sha="${line%% *}"; out+="$sep{\"sha\": $(jstr "$sha"), \"subject\": $(jstr "${line#* }")}"; sep=", "
  done <"$commits"
  local clist="[$out]" plist="" ilist="" runner=false n=0 ni=0
  sep="" out=""
  while IFS= read -r p; do
    [[ -n ${p//[[:space:]]/} ]] || continue
    if ((n < 300)); then plist+="$sep$(jstr "$p")"; sep=", "; n=$((n + 1)); fi
    if [[ $p =~ $INFRA && ! $p =~ $NOT_INFRA ]] && ((ni < 50)); then ilist+="${ilist:+, }$(jstr "$p")"; ni=$((ni + 1)); fi
    if [[ $p =~ $RUNNER_PATHS ]]; then runner=true; fi
  done <"$paths"
  # What this install really looks like, so the owner's hand-apply steps never guess a folder (BOS-269).
  local srcdir deployerdir bg=false colour="" soak=""
  srcdir="$(cd "$REPO" 2>/dev/null && pwd)" || srcdir=""
  deployerdir="$(cd "$D" 2>/dev/null && pwd)" || deployerdir=""
  if bluegreen_enabled; then bg=true; colour="$(live_colour 2>/dev/null)" || colour=""; fi
  # The standby window as this host really runs it (host.conf's SOAK_SECONDS), so the server's trial wording matches it.
  # A fragment with its own separator and quoting, so the JSON stays valid whatever the setting; absent = not blue/green.
  if [[ $bg == true ]]; then
    if [[ $SOAK_SECONDS =~ ^[0-9]{1,6}$ ]]; then soak=", \"soakSeconds\": $SOAK_SECONDS"; else log "SOAK_SECONDS is not a whole number of seconds; not reporting the trial length."; fi
  fi
  printf '{"version": 1, "checkedAt": %s, "deployed": %s, "tip": %s, "commits": %s, "paths": [%s], "infraPaths": [%s], "runnerChanged": %s, "srcDir": %s, "deployerDir": %s, "bluegreen": %s, "liveColour": %s%s}' \
    "$(jstr "$(now)")" "$(jstr "$head")" "$(jstr "$tip")" "$clist" "$plist" "$ilist" "$runner" "$(jstr "$srcdir")" "$(jstr "$deployerdir")" "$bg" "$(jstr "$colour")" "$soak" >"$f.tmp"
  chmod 644 "$f.tmp"; mv "$f.tmp" "$f"
}

# Host facts (BOS-427, BOS-541): the machine's own name and, for the folders it knows, their owner, group, mode
# and role, read with `stat` only (never their contents). The server's owner-card lint (R6) uses this to refuse a
# step that would run as the owner's login and hit a folder that login can't read, or would open a backup, data
# or secrets folder to everyone. The role is what the folder IS on this host, not what its name looks like: the
# install folder holds the database backups by default, so it carries the "backups" role too. Every folder is
# optional: one that isn't there is skipped, and a stat that fails is skipped too, so a host on another layout
# still gets a record. The file is written mode 644 (no secrets in it) and only replaced when it changed.
write_host_facts() {
  local f="$OUTBOX/host.json"
  ((DRY)) && { log "[dry-run] would write $f"; return 0; }
  local name; name="$(hostname 2>/dev/null || cat /etc/hostname 2>/dev/null || echo localhost)"
  name="${name%%[[:space:]]*}"
  [[ $name =~ ^[A-Za-z0-9_.-]{1,64}$ ]] || name="localhost"
  local rows="" sep="" p d o g m r
  # The install folder (the deployer's parent), the deployer folder, backups, data and the checkout's secrets.
  # One folder can have more than one role (the install folder holds the backups by default), so paths repeat.
  local -a folders=("$D/..:install" "${BOSSMAN_BACKUP_DIR:-$D/..}:backups" "$D:deployer" "${BOSSMAN_DATA:-/srv/boss-man/data}:data" "$REPO/secrets:secrets")
  # Roles by path, in a fixed order (private ones first), so the same host always gets the same row.
  local -A roles=()
  for p in "${folders[@]}"; do
    r="${p##*:}" d="${p%:*}"
    [[ -n $d && -d $d ]] || continue
    d="$(cd "$d" 2>/dev/null && pwd)" || continue
    [[ -n $d ]] || continue
    case " ${roles[$d]:-} " in *" $r "*) continue ;; esac
    case $r in
      backups | data | secrets) roles[$d]="$r${roles[$d]:+ ${roles[$d]}}" ;;
      *) roles[$d]="${roles[$d]:+${roles[$d]} }$r" ;;
    esac
  done
  while IFS= read -r p; do
    [[ -n $p ]] || continue
    o="$(stat -c %U "$p" 2>/dev/null || stat -c %u "$p" 2>/dev/null)" || continue
    g="$(stat -c %G "$p" 2>/dev/null || stat -c %g "$p" 2>/dev/null)" || continue
    m="$(stat -c %a "$p" 2>/dev/null)" || continue
    [[ $m =~ ^[0-7]{3,4}$ ]] || continue
    local rl="" rlsep=""
    for r in ${roles[$p]}; do rl+="$rlsep$(jstr "$r")"; rlsep=", "; done
    rows+="$sep{\"path\": $(jstr "$p"), \"owner\": $(jstr "$o"), \"group\": $(jstr "$g"), \"mode\": \"$m\", \"roles\": [$rl]}"; sep=", "
  done < <(printf '%s\n' "${!roles[@]}" | LC_ALL=C sort)
  printf '{"version": 1, "name": %s, "writtenAt": %s, "ownership": [%s]}\n' "$(jstr "$name")" "$(jstr "$(now)")" "$rows" >"$f.tmp"
  chmod 644 "$f.tmp"; mv "$f.tmp" "$f"
}

# One function per action, so a later phase can change what "deploy the server" means in one place.
do_deploy_server() { (cd "$REPO" && scripts/deploy.sh --yes --no-runner --commit "$COMMIT"); }
# No --now: update-runner.sh builds and checks the image, then asks Boss Man to drain (inbox/drain.json) and returns,
# so this lock is not held while runs finish. The swap itself is reported by the server.
do_update_runner() { (cd "$REPO" && BOSSMAN_DEPLOYER="$D" scripts/update-runner.sh); }

# ---------------------------------------------------------------------------------------------------
# Blue/green (opt-in). Two server colours behind a Caddy proxy; one leads, the other is a standby.
# A swap builds and checks the idle colour, hands the lead over with signals (leader.ts), flips the
# proxy's include file, checks through the proxy, and keeps the old colour as a standby for SOAK_SECONDS
# so it can switch back by itself. The live colour is whatever $D/proxy/active.caddy names: that file is
# the truth, and only this script writes it (root-owned folder, outside the checkout, mounted read-only).
# ---------------------------------------------------------------------------------------------------
bluegreen_enabled() {
  local cf="${COMPOSE_FILE:-}"
  [[ -n $cf ]] || cf="$(grep -s '^COMPOSE_FILE=' "$REPO/.env" | tail -1 | cut -d= -f2- || true)"
  [[ $cf == *truenas-bluegreen.yml* ]]
}
# BOSSMAN_DEPLOYER is exported so the compose file mounts the very folder this script writes to.
compose() { (cd "$REPO" && BOSSMAN_DEPLOYER="$D" docker compose "$@"); }
other_colour() { if [[ $1 == blue ]]; then echo green; else echo blue; fi; }
INCLUDE="$D/proxy/active.caddy"

# The colour the proxy sends traffic to, read from the include. Fails if it is missing or unreadable.
live_colour() {
  local c
  [[ -f $INCLUDE && ! -L $INCLUDE ]] || return 1
  c="$(sed -n 's/^[[:space:]]*reverse_proxy server-\(blue\|green\)\(-front\)\{0,1\}:.*/\1/p' "$INCLUDE" | head -1)"
  [[ -n $c ]] && echo "$c"
}

# True when the proxy can reach the colour by its name on the private "front" network (the compose file has it).
# A real request, not a name lookup: it proves the route the include is about to use.
front_ready() { # colour
  compose exec -T proxy wget -q -T 3 -O /dev/null "http://server-$1-front:3100/api/ready" >>"$LOG" 2>&1
}

# True when the compose files declare the front network for this colour (its -front name is in the resolved config).
front_declared() { # colour
  compose config 2>>"$LOG" | grep -q "server-$1-front"
}

# Sets INCLUDE_FORM (front or old) for a colour. The check is retried, because one failed exec or wget is not proof the
# network is missing. If the compose files declare the front network but the check still fails, the include keeps the
# form it has now (never a silent downgrade); the reason goes to the log and to a note beside the status file.
FRONT_TRIES="${FRONT_TRIES:-4}" FRONT_WAIT="${FRONT_WAIT:-3}"
INCLUDE_FORM=old
choose_include_form() { # colour
  local i cur=old
  for ((i = 1; i <= FRONT_TRIES; i++)); do
    if front_ready "$1"; then INCLUDE_FORM=front; return 0; fi
    if ((i < FRONT_TRIES)); then sleep "$FRONT_WAIT"; fi
  done
  if grep -qs "reverse_proxy server-[a-z]*-front:" "$INCLUDE"; then cur=front; fi
  INCLUDE_FORM=$cur
  if front_declared "$1"; then
    log "WARNING: the front network check for $1 failed $FRONT_TRIES times but the compose files declare it; keeping the $cur include form."
    if ! ((DRY)); then printf '%s: the front network check for %s failed %s times though the compose files declare it; the proxy include keeps the %s form.\n' "$(now)" "$1" "$FRONT_TRIES" "$cur" >"$OUTBOX/proxy-include-note.txt"; fi
  else
    INCLUDE_FORM=old
    log "The compose files have no front network for $1; writing the old include form."
  fi
}

# Rewrites the include for a colour: made in the root-only state folder, then renamed over the old one.
write_include() { # colour
  local dir="$D/proxy" tmp
  [[ $1 == blue || $1 == green ]] || return 1
  # Root's file must never be written through a folder a container can write to.
  if ! [[ -d $dir && ! -L $dir && $(stat -c %u "$dir") == "$(id -u)" && $(stat -c %a "$dir") =~ ^[0-7][0145][0145]$ ]]; then
    log "ERROR: $dir must be a real folder owned by $(id -un) that nobody else can write to."; return 1
  fi
  [[ $(stat -c %d "$STATE") == "$(stat -c %d "$dir")" ]] || { log "ERROR: $STATE and $dir are on different filesystems; the rename would not be atomic."; return 1; }
  tmp="$(mktemp "$STATE/active.XXXXXX")"
  # With the private "front" network (deploy/truenas-bluegreen.yml) the proxy reaches the colour at server-<colour>-front and
  # tells it the one client address Caddy resolved. Without it (compose files not updated yet) the old form is written,
  # so a new copy of this script can never break a swap or a rollback on a host that has not moved yet.
  choose_include_form "$1"
  if [[ $INCLUDE_FORM == front ]]; then
    cat >"$tmp" <<INC
# Written by host-deployer.sh. Do not edit. Live colour: $1
(active) {
	reverse_proxy server-$1-front:{args[0]} {
		header_up X-Forwarded-For {client_ip}
		health_uri {args[1]}
		health_interval 2s
		health_timeout 2s
	}
}
INC
  else
    cat >"$tmp" <<INC
# Written by host-deployer.sh. Do not edit. Live colour: $1
(active) {
	reverse_proxy server-$1:{args[0]} {
		health_uri {args[1]}
		health_interval 2s
		health_timeout 2s
	}
}
INC
  fi
  chmod 644 "$tmp"
  mv -fT "$tmp" "$INCLUDE"
}

# Points the proxy at a colour: rewrite, validate, reload (the admin API stays inside the container). A bad file is put back.
flip_proxy() { # colour
  local was
  was="$(live_colour || true)"
  write_include "$1" || return 1
  if compose exec -T proxy caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile >>"$LOG" 2>&1 &&
    compose exec -T proxy caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile >>"$LOG" 2>&1; then
    return 0
  fi
  log "The proxy refused the new include; putting ${was:-the old one} back."
  if [[ -n $was ]] && write_include "$was"; then compose exec -T proxy caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile >>"$LOG" 2>&1 || true; fi
  return 1
}

# GET a path from inside a container (the colours have node, the proxy has busybox wget); prints the body.
probe() { # service port path
  if [[ $1 == proxy ]]; then compose exec -T proxy wget -q -T 5 -O - "http://127.0.0.1:$2$3"
  else compose exec -T "$1" node -e "fetch('http://127.0.0.1:$2$3').then(async r=>{console.log(await r.text());process.exit(r.ok?0:1)}).catch(()=>process.exit(1))"; fi
}

# Polls /api/ready of a service until it is ok, has this role and (when given) this commit.
wait_ready() { # service role commit seconds
  local end=$((SECONDS + $4)) body
  while :; do
    if body="$(probe "$1" 3100 /api/ready 2>/dev/null)" && [[ $(jfield ok <<<"$body") == True && $(jfield role <<<"$body") == "$2" ]] &&
      { [[ -z $3 ]] || [[ $(jfield commit <<<"$body") == "$3" ]]; }; then return 0; fi
    ((SECONDS < end)) || return 1
    sleep "$BG_POLL_SECONDS"
  done
}

backup_database() {
  local dir="${BOSSMAN_BACKUP_DIR:-$D/..}" old f
  mkdir -p "$dir"
  BG_BACKUP="$dir/bossman-$(date +%F-%H%M).sql.gz"
  (set -o pipefail; umask 077; compose exec -T db pg_dump -U bossman bossman | gzip >"$BG_BACKUP.partial") || { rm -f "$BG_BACKUP.partial"; return 1; }
  { [[ -s $BG_BACKUP.partial ]] && gzip -t "$BG_BACKUP.partial"; } || { rm -f "$BG_BACKUP.partial"; return 1; }
  mv "$BG_BACKUP.partial" "$BG_BACKUP"
  # Same retention as deploy.sh: only bossman-*.sql.gz, newest 14 kept.
  old="$(find "$dir" -maxdepth 1 -type f -name 'bossman-*.sql.gz' -printf '%T@ %p\n' | sort -rn | tail -n +15 | cut -d' ' -f2-)"
  [[ -z $old ]] || while IFS= read -r f; do rm -f -- "$f"; done <<<"$old"
}

BG_RESULT="" BG_MSG="" BG_BACKUP="" BG_LIVE="" BG_IDLE="" BG_PREV=""
bg_fail() { BG_RESULT=$1; BG_MSG=$2; return 1; }
# The last 20 lines of a colour's container log, for a message that says it never came up (BOS-562); short lines, one block.
colour_log_tail() { # colour
  local t
  t="$(compose logs --no-color --tail 20 "server-$1" 2>&1 | cut -c1-200 | head -c 2500 || true)"
  [[ -z $t ]] || printf " Last 20 lines of the server-%s log:\n%s" "$1" "$t"
}

# Reverses a hand-over: demote the new colour, promote the old, point the proxy back, check, stop the new one.
switch_back() {
  local ok=1
  log "Switching back from $BG_IDLE to $BG_LIVE."
  # Never roll back to nothing: with the old colour not running there is nothing to go back to, so the new one is left alone.
  [[ -n $(compose ps -q "server-$BG_LIVE" 2>/dev/null) ]] || { log "server-$BG_LIVE is not running; leaving server-$BG_IDLE as it is."; return 1; }
  compose kill -s USR1 "server-$BG_IDLE" >>"$LOG" 2>&1 || true
  compose kill -s USR2 "server-$BG_LIVE" >>"$LOG" 2>&1 || ok=0
  if ((ok)); then wait_ready "server-$BG_LIVE" leader "" "$BG_HANDOVER_SECONDS" || ok=0; fi
  if ((ok)); then flip_proxy "$BG_LIVE" || ok=0; fi
  if ((ok)); then wait_ready proxy leader "" "$BG_HANDOVER_SECONDS" || ok=0; fi
  if ((ok)); then
    if compose stop "server-$BG_IDLE" >>"$LOG" 2>&1; then plan_stopped "$BG_IDLE"; fi
    g reset --quiet --hard "$BG_PREV" || true
  else
    # The old colour did not take over: put the new one back in charge and keep it running (the checkout stays on what runs).
    log "The switch-back to $BG_LIVE failed; keeping server-$BG_IDLE running."
    flip_proxy "$BG_IDLE" >>"$LOG" 2>&1 || true
    compose kill -s USR2 "server-$BG_IDLE" >>"$LOG" 2>&1 || true
  fi
  ((ok))
}

# What to type on the host when both automatic paths failed (generic: the configured checkout, no fixed paths or names).
recovery_hint() {
  printf 'Look at the host now. In %s run: docker compose ps. To start the colour that should be live and make it lead: docker compose up -d --no-deps server-%s, then docker compose kill -s USR2 server-%s. If server-%s is running, docker compose kill -s USR2 server-%s makes it lead instead. Log: %s' \
    "$REPO" "$BG_LIVE" "$BG_LIVE" "$BG_IDLE" "$BG_IDLE" "$LOG"
}

# After the swap: the proxy answers as the new leader at the new commit, and the portal answers.
verify_live() { # commit seconds: on failure VERIFY_WHY says which check failed and what it saw
  local body=""
  VERIFY_WHY=""
  wait_ready proxy leader "$1" "$2" || { VERIFY_WHY="the server did not answer as the leader at ${1:0:8} through the proxy within ${2}s (last answer: $(probe proxy 3100 /api/ready 2>&1 | head -c 300 || true))"; return 1; }
  local end=$((SECONDS + $2))
  until body="$(probe proxy 3101 /portal.html 2>&1 >/dev/null)"; do
    if ((SECONDS >= end)); then VERIFY_WHY="the portal page did not load through the proxy within ${2}s (${body:0:300})"; return 1; fi
    sleep "$BG_POLL_SECONDS"
  done
}

# ---------------------------------------------------------------------------------------------------
# The whole-stack checklist (DR-020 D, BOS-488). "Healthy" is not "the proxy answers": it is five items, each pass or fail,
# recorded in outbox/health.json and in the status file: the live colour, the other colour in its planned state, exactly one
# leader, the database untouched, and no restarts or OOM kills. Container names come from the compose project; nothing is
# hardcoded beyond the service names the rest of this script already uses.
# ---------------------------------------------------------------------------------------------------
HC_NAMES=(live other leader db restarts)
# shellcheck disable=SC2034 # set and read through printf -v / indirect expansion
HC_live="" HC_other="" HC_leader="" HC_db="" HC_restarts="" HD_live="" HD_other="" HD_leader="" HD_db="" HD_restarts=""
HEALTH_FAILS="" HEALTH_DETAIL=""
hc_set() { printf -v "HC_$1" '%s' "$2"; printf -v "HD_$1" '%s' "$3"; } # item pass|fail detail

# "id startedAt restartCount oomKilled running exitCode" of a service's container (stopped ones too), or "none".
cstate() { # service
  local id
  id="$(compose ps -aq "$1" 2>/dev/null | head -1 || true)"
  [[ $id =~ ^[0-9a-z]{4,64}$ ]] || { echo none; return 0; }
  docker inspect -f '{{.Id}} {{.State.StartedAt}} {{.RestartCount}} {{.State.OOMKilled}} {{.State.Running}} {{.State.ExitCode}}' "$id" 2>/dev/null || echo none
}
running_of() { awk '{ print ($1 == "none") ? "absent" : $5 }' <<<"$1"; } # a cstate line: true, false or absent
colour_role() { jfield role <<<"$(probe "server-$1" 3100 /api/ready 2>/dev/null || true)"; } # colour
# A hung database must not hold the deployer's lock: the connect and the whole call are time-limited, and no answer counts as a failed db item.
pg_start() { (cd "$REPO" && BOSSMAN_DEPLOYER="$D" timeout 15 docker compose exec -T db psql -U bossman -d 'dbname=bossman connect_timeout=5' -Atc 'select pg_postmaster_start_time()' 2>/dev/null | head -1 | tr ' ' '_') || true; }

# What the containers looked like before the deploy: "service id startedAt restarts" lines and one "pg <time>" line.
# The state folder is root-only; the file is only read with awk, never sourced.
baseline_line() { awk -v s="$1" '$1 == s { print; exit }' "$STATE/baseline" 2>/dev/null || true; } # service
baseline_set() { # service: record its container as it is now (also used for a colour the deploy recreated on purpose)
  local st id started restarts f="$STATE/baseline"
  st="$(cstate "$1")"; [[ $st != none ]] || return 0
  read -r id started restarts _ <<<"$st"
  { grep -v "^$1 " "$f" 2>/dev/null || true; } >"$f.tmp"
  printf '%s %s %s %s\n' "$1" "$id" "${started// /_}" "$restarts" >>"$f.tmp"; mv "$f.tmp" "$f"
}
baseline_set_pg() {
  local p f="$STATE/baseline"
  p="$(pg_start)"; [[ -n $p ]] || return 0
  { grep -v '^pg ' "$f" 2>/dev/null || true; } >"$f.tmp"
  printf 'pg %s\n' "$p" >>"$f.tmp"; mv "$f.tmp" "$f"
}
take_baseline() {
  local s
  if ((DRY)); then return 0; fi
  : >"$STATE/baseline"
  for s in server-blue server-green db proxy; do baseline_set "$s" || true; done
  baseline_set_pg || true
}
# Colours the deployer stopped on purpose (soak over, rollback, undone deploy): a stop that is not on this list is a crash.
plan_stopped() { grep -qxs "$1" "$STATE/stopped-by-plan" || printf '%s\n' "$1" >>"$STATE/stopped-by-plan"; } # colour
unplan_stopped() { { grep -vx "$1" "$STATE/stopped-by-plan" 2>/dev/null || true; } >"$STATE/stopped-by-plan.tmp"; mv "$STATE/stopped-by-plan.tmp" "$STATE/stopped-by-plan"; } # colour

# Writes outbox/health.json and keeps the same fields for the status file (HEALTH_KV, read by write_status).
hc_record() { # phase commit
  local i v d kv=() stack=healthy det=()
  HEALTH_FAILS="" HEALTH_DETAIL=""
  for i in "${HC_NAMES[@]}"; do
    v="HC_$i" d="HD_$i"
    kv+=("check_$i=${!v}"); det+=("detail_$i=${!d}")
    if [[ ${!v} != pass ]]; then stack=degraded; HEALTH_FAILS+=" $i"; HEALTH_DETAIL+="${HEALTH_DETAIL:+ }[$i] ${!d}."; fi
  done
  HEALTH_KV=("stack=$stack" "${kv[@]}" "check_detail=$HEALTH_DETAIL")
  if ((DRY)); then return 0; fi
  json at="$(now)" phase="$1" commit="$2" "${HEALTH_KV[@]}" "${det[@]}" >"$OUTBOX/health.json.tmp"
  chmod 644 "$OUTBOX/health.json.tmp"; mv "$OUTBOX/health.json.tmp" "$OUTBOX/health.json"
}

# Runs the checklist. plan = what the other colour should be doing: standby (during the trial) or stopped (after it).
# Returns 1 if any item fails; VERIFY_WHY then says which and what was seen (the live colour's own message first).
stack_check() { # commit seconds phase plan
  local commit=$1 secs=$2 phase=$3 plan=$4 live other st line s why="" bad="" n leaders=0 rolelist="" id started restarts oom running code bid bst bn p bp note=""
  if [[ ! -s $STATE/baseline ]] && ! ((DRY)); then take_baseline; note=" (no baseline from before the deploy; taken now)"; fi
  # 1. The live colour, through the proxy.
  if verify_live "$commit" "$secs"; then
    live="$(live_colour || true)"; st="$(cstate "server-${live:-none}")"
    if [[ $(running_of "$st") == true ]]; then hc_set live pass "server-$live is running and leads at ${commit:0:8} through the proxy"
    else hc_set live fail "server-${live:-?} answers through the proxy but its container is not running"; fi
  else
    why="$VERIFY_WHY"; live="$(live_colour || true)"; hc_set live fail "$VERIFY_WHY"
  fi
  # 2. The other colour in its planned state.
  if [[ -z $live ]]; then hc_set other fail "no live colour is set in the proxy include"
  else
    other="$(other_colour "$live")"; st="$(cstate "server-$other")"; running=absent code=""
    if [[ $st != none ]]; then read -r _ _ _ _ running code <<<"$st"; fi
    if [[ $plan == standby ]]; then
      if [[ $running != true ]]; then hc_set other fail "server-$other should be running as a standby but is $([[ $running == absent ]] && echo missing || echo "stopped (exit code $code)")"
      elif [[ $(colour_role "$other") != standby ]]; then hc_set other fail "server-$other is running but not as a standby (role '$(colour_role "$other")')"
      else hc_set other pass "server-$other is running as a standby"; fi
    else
      if [[ $running == true ]]; then hc_set other fail "server-$other is running but the plan says it should be stopped"
      elif [[ $running == absent ]]; then hc_set other pass "server-$other has no container (nothing to run)"
      elif [[ $code != 0 ]]; then hc_set other fail "server-$other stopped with exit code $code, so it crashed or was killed"
      elif ! grep -qxs "$other" "$STATE/stopped-by-plan"; then hc_set other fail "server-$other is stopped but the deployer did not stop it"
      else hc_set other pass "server-$other was stopped by plan (exit code 0)"; fi
    fi
  fi
  # 3. Exactly one leader across both colours.
  for s in blue green; do
    st="$(cstate "server-$s")"
    if [[ $(running_of "$st") == true ]]; then n="$(colour_role "$s")"; rolelist+="$s=${n:-unknown} "; [[ $n != leader ]] || leaders=$((leaders + 1)); else rolelist+="$s=not running "; fi
  done
  if ((leaders == 1)); then hc_set leader pass "one leader (${rolelist% })"; else hc_set leader fail "$leaders leaders where exactly one is needed (${rolelist% })"; fi
  # 4. The database was neither recreated nor restarted. A planned database step drops state/planned-db to re-baseline once.
  if [[ -f $STATE/planned-db && ! -L $STATE/planned-db ]] && ! ((DRY)); then baseline_set db || true; baseline_set_pg || true; rm -f "$STATE/planned-db"; note=" (a planned database step: baseline renewed)"; fi
  st="$(cstate db)"; line="$(baseline_line db)"; bp="$(awk '$1 == "pg" { print $2; exit }' "$STATE/baseline" 2>/dev/null || true)"
  if [[ $(running_of "$st") != true ]]; then hc_set db fail "the database container is not running"
  elif [[ -z $line ]]; then hc_set db fail "no record of the database from before the deploy, so a restart could not be ruled out"
  else
    read -r id started _ <<<"$st"; read -r _ bid bst _ <<<"$line"; p="$(pg_start)"
    if [[ $id != "$bid" || ${started// /_} != "$bst" ]]; then hc_set db fail "the database container was recreated or restarted (its ID or start time changed)"
    elif [[ -z $p ]]; then hc_set db fail "could not read the database's start time"
    elif [[ -n $bp && $p != "$bp" ]]; then hc_set db fail "the database server process restarted (start time was ${bp//_/ }, now ${p//_/ })"
    else hc_set db pass "same container and start time as before the deploy; Postgres up since ${p//_/ }$note"; fi
  fi
  # 5. No restarts, recreations or OOM kills in the window.
  for s in server-blue server-green db proxy; do
    st="$(cstate "$s")"; [[ $st != none ]] || continue
    read -r id _ restarts oom _ <<<"$st"; line="$(baseline_line "$s")"
    [[ -n $line ]] || { baseline_set "$s" || true; continue; } # a container that did not exist at the start
    read -r _ bid _ bn <<<"$line"
    [[ $oom != true ]] || bad+=" $s was killed for running out of memory."
    [[ $restarts -le $bn ]] || bad+=" $s restarted $((restarts - bn)) time(s)."
    [[ $id == "$bid" ]] || bad+=" $s was recreated."
  done
  if [[ -z $bad ]]; then hc_set restarts pass "no restarts, recreations or OOM kills of either colour, the database or the proxy"; else hc_set restarts fail "${bad# }"; fi
  hc_record "$phase" "$commit"
  [[ -z $HEALTH_FAILS ]] && return 0
  if [[ $HC_live == pass ]]; then VERIFY_WHY="the whole-stack check found:$HEALTH_DETAIL"; else VERIFY_WHY="$why"; fi
  return 1
}

# The stack is degraded but the live colour still serves: switching to the other colour could make it worse, so nothing is
# switched. One page per distinct problem (state/last-health-alert), not one per tick.
health_degraded() { # commit prev
  local sig="$HEALTH_FAILS $1"
  if [[ -f $STATE/last-health-alert && $(cat "$STATE/last-health-alert") == "$sig" ]]; then log "Still degraded (${HEALTH_FAILS# }); already reported."; return 0; fi
  printf '%s\n' "$sig" >"$STATE/last-health-alert"
  REQ_ID="health-$(date +%s)" TARGET=server STARTED="$(now)" FROM="$2" COMMIT="$1"
  finish partial "Boss Man is answering, but the check after the update to ${1:0:8} found a problem:$HEALTH_DETAIL Nothing was switched back by itself. Look at the host: in $REPO run docker compose ps, then docker compose logs for the service named above. When you have looked and the current state is acceptable, run $D/host-deployer.sh --ack-health as root: it records the containers as they are now and re-checks. Log: $LOG"
}

pre_fail() { # message: undo what happened before the hand-over; the live colour was never touched
  if compose stop "server-$BG_IDLE" >>"$LOG" 2>&1; then plan_stopped "$BG_IDLE"; fi
  g reset --quiet --hard "$BG_PREV" || true
  bg_fail failed "$1 The live colour ($BG_LIVE) was not touched. Backup: $BG_BACKUP"
}

do_deploy_bluegreen() {
  local c why="" problem
  BG_PREV="$FROM"
  BG_LIVE="$(live_colour)" || { bg_fail failed "No usable $INCLUDE: do the first blue/green bring-up by hand (docs/06-install-truenas.md, 9d)."; return 1; }
  BG_IDLE="$(other_colour "$BG_LIVE")"
  for c in proxy "server-$BG_LIVE"; do
    [[ -n $(compose ps -q "$c" 2>/dev/null) ]] || { bg_fail failed "The $c container is not running; nothing was changed."; return 1; }
  done
  # Files the server (user node) cannot read would crash the new colour at start (BOS-562): stop before the backup and build.
  problem="$(readable_problem "$REPO")"
  [[ -z $problem ]] || { bg_fail failed "$problem"$'\n'"Nothing was changed."; return 1; }
  rm -f "$STATE/soak" "$STATE/last-health-alert" # a swap while the last one is soaking ends that soak: its standby is about to be rebuilt
  unplan_stopped "$BG_IDLE" # it is about to be rebuilt and started on purpose
  take_baseline # the containers as they are before this deploy touches anything (DR-020 D)

  log "Blue/green: $BG_LIVE is live; building $BG_IDLE at ${COMMIT:0:8}."
  backup_database || { bg_fail failed "The backup failed. Nothing was changed."; return 1; }
  g merge --ff-only --quiet "$COMMIT" || { bg_fail failed "Could not move the checkout to ${COMMIT:0:8}."; return 1; }
  BOSSMAN_COMMIT="$COMMIT" compose build "server-$BG_IDLE" >>"$LOG" 2>&1 || { pre_fail "Building $BG_IDLE failed."; return 1; }
  # Expand-only migrations: the live colour keeps working on the new schema.
  BOSSMAN_MIGRATE_TAG="$BG_IDLE" compose run --rm --no-deps migrate >>"$LOG" 2>&1 || { pre_fail "The migration failed (the database rolled it back)."; return 1; }
  compose up -d --no-deps --force-recreate "server-$BG_IDLE" >>"$LOG" 2>&1 || { pre_fail "Starting $BG_IDLE failed."; return 1; }
  baseline_set "server-$BG_IDLE" || true # recreated on purpose: its new container is the baseline
  # It is a standby because the live colour holds the leader lock; seeing that also shows the lock works.
  wait_ready "server-$BG_IDLE" standby "$COMMIT" "$BG_READY_SECONDS" || { pre_fail "$BG_IDLE did not come up as a standby at ${COMMIT:0:8} within ${BG_READY_SECONDS}s.$(colour_log_tail "$BG_IDLE")"; return 1; }
  # A login-free read straight from the idle colour (not through the proxy).
  [[ $(probe "server-$BG_IDLE" 3100 /api/setup 2>/dev/null | jfield needsSetup) == False ]] || { pre_fail "The smoke test on $BG_IDLE failed (GET /api/setup)."; return 1; }

  log "Smoke test passed. Handing over: demote $BG_LIVE, promote $BG_IDLE."
  compose kill -s USR1 "server-$BG_LIVE" >>"$LOG" 2>&1 || { pre_fail "Could not signal $BG_LIVE."; return 1; }
  # From here the old colour may have let go, so any failure is undone with switch_back.
  wait_ready "server-$BG_LIVE" standby "" "$BG_HANDOVER_SECONDS" || why="$BG_LIVE did not step down."
  [[ -n $why ]] || compose kill -s USR2 "server-$BG_IDLE" >>"$LOG" 2>&1 || why="Could not signal $BG_IDLE."
  [[ -n $why ]] || wait_ready "server-$BG_IDLE" leader "$COMMIT" "$BG_HANDOVER_SECONDS" || why="$BG_IDLE did not become the leader."
  [[ -n $why ]] || flip_proxy "$BG_IDLE" || why="The proxy did not accept the switch to $BG_IDLE."
  [[ -n $why ]] || stack_check "$COMMIT" "$BG_READY_SECONDS" swap standby || why="${VERIFY_WHY:-The checks through the proxy failed.}"
  if [[ -n $why ]]; then
    if switch_back; then bg_fail rolled_back "$why Switched back to $BG_LIVE automatically. Backup: $BG_BACKUP"
    else bg_fail failed "$why The switch-back ALSO failed: $(recovery_hint) Backup: $BG_BACKUP"; fi
    return 1
  fi

  printf 'old=%s new=%s deadline=%s commit=%s prev=%s\n' "$BG_LIVE" "$BG_IDLE" "$(($(date +%s) + SOAK_SECONDS))" "$COMMIT" "$BG_PREV" >"$STATE/soak"
  # Kept after the soak ends: the only release a manual --rollback may go back to (colour, commit).
  printf '%s %s\n' "$BG_LIVE" "$BG_PREV" >"$STATE/previous"
  rm -f "$STATE/hold"
  BG_RESULT=deployed
  BG_MSG="Deployed ${BG_PREV:0:8} to ${COMMIT:0:8}: $BG_IDLE is live; $BG_LIVE stays up as a standby for $((SOAK_SECONDS / 60)) minutes, and the deployer switches back by itself if the checks fail."
}

soak_end() { # old commit prev soakfile: time is up and the live colour is fine
  log "Soak over: stopping the old colour ($1)."
  if compose stop "server-$1" >>"$LOG" 2>&1; then plan_stopped "$1"; else log "Could not stop server-$1."; fi
  rm -f "$4"
  # The end of the window: the same checklist with the old colour now planned to be stopped.
  if ! stack_check "$2" "$SOAK_CHECK_SECONDS" end stopped; then log "End-of-window check: $VERIFY_WHY"; health_degraded "$2" "$3"; fi
}

# Runs every tick, before any request: while an old colour soaks, re-check the live one and switch back if it fails;
# stop the old colour once the time is up.
soak_tick() {
  local f="$STATE/soak" old="" new="" deadline="" commit="" prev=""
  [[ -f $f && ! -L $f ]] || return 0
  # The file is ours, but it is parsed strictly anyway: only this exact shape is accepted.
  eval "$(sed -n 's/^old=\(blue\|green\) new=\(blue\|green\) deadline=\([0-9]\{1,12\}\) commit=\([0-9a-f]\{40\}\) prev=\([0-9a-f]\{40\}\)$/old=\1 new=\2 deadline=\3 commit=\4 prev=\5/p' "$f" | head -1)"
  [[ -n $commit && $old != "$new" ]] || { log "Ignoring a malformed $f."; ((DRY)) || rm -f "$f"; return 0; }
  if ((DRY)); then log "[dry-run] a soak is running: $new live, $old standby until $deadline"; return 0; fi
  [[ $(live_colour || true) == "$new" ]] || { log "The proxy no longer points at $new; ending the soak."; rm -f "$f"; return 0; }
  if stack_check "$commit" "$SOAK_CHECK_SECONDS" soak standby; then
    rm -f "$STATE/last-health-alert"
    if (($(date +%s) >= deadline)); then soak_end "$old" "$commit" "$prev" "$f"; fi
    return 0
  fi
  log "Check failed on $new at ${commit:0:8}: $VERIFY_WHY"
  # The live colour still answers: something else is wrong, and a switch could make it worse. Report it once. The window
  # still ends on time (a failed item the person has to look at must not keep a second server running for ever).
  if [[ $HC_live == pass ]]; then
    # (health_degraded records and exits, so the end of the window comes first: its own end check pages if the problem remains.)
    if (($(date +%s) >= deadline)); then soak_end "$old" "$commit" "$prev" "$f"; fi
    health_degraded "$commit" "$prev"; return 0
  fi
  BG_LIVE="$old" BG_IDLE="$new" BG_PREV="$prev"
  # The record names the commit that failed (to_commit), as a swap-time rollback does, and the one we are back on (from_commit).
  REQ_ID="auto-rollback-$(date +%s)" TARGET=server STARTED="$(now)" FROM="$prev" COMMIT="$commit"
  rm -f "$f"
  if switch_back; then finish rolled_back "The update to ${commit:0:8} was switched back: right after it went live, $VERIFY_WHY. Boss Man went back to the previous version (${prev:0:8}) automatically and is running normally on it."
  else finish failed "The checks on $new failed and the automatic switch-back to $old ALSO failed: $(recovery_hint)"; fi
}

# By hand, any time (also after the soak window): go back to the other colour, i.e. the previous release.
# That colour's container is stopped but its image stays until the next swap rebuilds it. Same hand-over as a swap
# and the same automatic reversal if the checks fail. The database is never touched: the previous release runs on
# the newer schema only while migrations are expand-only (docs/10-migrations.md).
do_rollback_bluegreen() {
  local c why="" body ocommit
  BG_LIVE="$(live_colour)" || { bg_fail failed "No usable $INCLUDE."; return 1; }
  BG_IDLE="$(other_colour "$BG_LIVE")"
  BG_PREV="$(g rev-parse HEAD)"
  for c in proxy "server-$BG_LIVE"; do
    [[ -n $(compose ps -q "$c" 2>/dev/null) ]] || { bg_fail failed "The $c container is not running; nothing was changed."; return 1; }
  done
  docker image inspect "boss-man-server:$BG_IDLE" >/dev/null 2>&1 || { bg_fail failed "There is no image boss-man-server:$BG_IDLE, so there is nothing to go back to. Nothing was changed."; return 1; }
  if ((DRY)); then
    [[ $(cut -d" " -f1 "$STATE/previous" 2>/dev/null) == "$BG_IDLE" ]] || { bg_fail failed "No record that $BG_IDLE holds the previous release (state/previous); a rollback would be refused. Nothing was changed."; return 1; }
    log "[dry-run] would back up, start $BG_IDLE as a standby, hand over from $BG_LIVE, flip the proxy, verify, stop $BG_LIVE"; return 0
  fi
  log "Rollback: $BG_LIVE is live; going back to $BG_IDLE."
  backup_database || { bg_fail failed "The backup failed. Nothing was changed."; return 1; }
  # Not recreated: the stopped container keeps its old image.
  unplan_stopped "$BG_IDLE"
  take_baseline
  compose up -d --no-deps "server-$BG_IDLE" >>"$LOG" 2>&1 || { pre_fail "Starting $BG_IDLE failed."; return 1; }
  wait_ready "server-$BG_IDLE" standby "" "$BG_READY_SECONDS" || { pre_fail "$BG_IDLE did not come up as a standby within ${BG_READY_SECONDS}s."; return 1; }
  body="$(probe "server-$BG_IDLE" 3100 /api/ready 2>/dev/null)" || body=""
  ocommit="$(jfield commit <<<"$body")"
  [[ $ocommit =~ ^[0-9a-f]{40}$ ]] || ocommit=""
  # The stopped colour holds the previous release only if the last swap that went live said so. A deploy that failed
  # after its build leaves a rejected build in that image, and going "back" to it would be going forward to it.
  [[ -n $ocommit && $(cat "$STATE/previous" 2>/dev/null) == "$BG_IDLE $ocommit" ]] || { pre_fail "$BG_IDLE does not hold the previous release (it reports '${ocommit:0:8}', expected the one recorded at the last successful swap). Nothing was changed."; return 1; }
  rm -f "$STATE/soak" # only now: a refusal above keeps the automatic switch-back for the rest of the window
  [[ $(probe "server-$BG_IDLE" 3100 /api/setup 2>/dev/null | jfield needsSetup) == False ]] || { pre_fail "The smoke test on $BG_IDLE failed (GET /api/setup)."; return 1; }
  log "Smoke test passed. Handing over: demote $BG_LIVE, promote $BG_IDLE (code ${ocommit:0:8})."
  compose kill -s USR1 "server-$BG_LIVE" >>"$LOG" 2>&1 || { pre_fail "Could not signal $BG_LIVE."; return 1; }
  wait_ready "server-$BG_LIVE" standby "" "$BG_HANDOVER_SECONDS" || why="$BG_LIVE did not step down."
  [[ -n $why ]] || compose kill -s USR2 "server-$BG_IDLE" >>"$LOG" 2>&1 || why="Could not signal $BG_IDLE."
  [[ -n $why ]] || wait_ready "server-$BG_IDLE" leader "$ocommit" "$BG_HANDOVER_SECONDS" || why="$BG_IDLE did not become the leader."
  [[ -n $why ]] || flip_proxy "$BG_IDLE" || why="The proxy did not accept the switch to $BG_IDLE."
  [[ -n $why ]] || stack_check "$ocommit" "$BG_READY_SECONDS" rollback standby || why="${VERIFY_WHY:-The checks through the proxy failed.}"
  if [[ -n $why ]]; then
    if switch_back; then bg_fail rolled_back "Rollback failed ($why); $BG_LIVE is live again. Backup: $BG_BACKUP"
    else bg_fail failed "Rollback failed ($why) and the switch-back ALSO failed: $(recovery_hint) Backup: $BG_BACKUP"; fi
    return 1
  fi
  # The bad release stays stopped (not removed); the checkout follows what runs.
  if compose stop "server-$BG_LIVE" >>"$LOG" 2>&1; then plan_stopped "$BG_LIVE"; else log "Could not stop server-$BG_LIVE."; fi
  printf '%s\n' "$BG_PREV" >"$STATE/hold" # the release just rejected: refresh_available must not offer it again
  rm -f "$STATE/previous"
  if [[ -n $ocommit ]] && g cat-file -e "$ocommit^{commit}" 2>/dev/null; then g reset --quiet --hard "$ocommit" || log "Could not move the checkout to ${ocommit:0:8}."; fi
  BG_RESULT=rolled_back
  BG_MSG="Rolled back to ${ocommit:0:8}: $BG_IDLE is live; $BG_LIVE is stopped. The database was not changed. Backup: $BG_BACKUP"
  # The end of the rollback: the bad colour is now planned to be stopped; anything else out of place is said in the result.
  if ! stack_check "${ocommit:-$(g rev-parse HEAD)}" 10 end stopped; then BG_MSG+=" WARNING, the whole-stack check afterwards found:$HEALTH_DETAIL"; fi
}

# Reads a field of scripts/deploy.sh's own status file.
# Booleans print True/False because callers compare against "True".
deploy_status_field() { jfield "$1" <"${BOSSMAN_DEPLOY_STATUS:-${BOSSMAN_BACKUP_DIR:-$D/..}/deploy-status.json}" 2>/dev/null || true; }

# A run that was cut off (killed, host restart) leaves status.json saying "running" for ever, the checkout ahead of what
# runs and maybe a soak file for a release that never went live. We hold the lock here, so no run is active: say so
# (the server refuses new deploys while the status is "running"), and make the checkout and soak match what really answers.
# Only files and git are touched; never a container.
recover_interrupted() {
  local sf="$OUTBOX/status.json" st live="" head reset="" sc=""
  [[ -f $sf && ! -L $sf ]] || return 0
  st="$(cat "$sf")"
  [[ $(jfield result <<<"$st") == running ]] || return 0
  ((DRY)) && { log "[dry-run] the last run was cut off (status still 'running'); a real tick would mark it failed"; return 0; }
  REQ_ID="$(jfield id <<<"$st")" TARGET="$(jfield target <<<"$st")" STARTED="$(jfield started <<<"$st")" FROM="$(jfield from_commit <<<"$st")" COMMIT="$(jfield to_commit <<<"$st")"
  head="$(g rev-parse HEAD 2>/dev/null || true)"
  if [[ $TARGET == server ]] && bluegreen_enabled; then
    live="$(jfield commit <<<"$(probe proxy 3100 /api/ready 2>/dev/null || true)")"
    if [[ $live =~ ^[0-9a-f]{40}$ && $live != "$head" ]] && g cat-file -e "$live^{commit}" 2>/dev/null; then
      g reset --quiet --hard "$live" && reset=" The checkout was put back on ${live:0:8}, which is what answers."
    fi
    if [[ -f $STATE/soak && -n $live ]]; then
      sc="$(sed -n 's/.* commit=\([0-9a-f]\{40\}\) .*/\1/p' "$STATE/soak" | head -1)"
      if [[ $sc != "$live" ]]; then rm -f "$STATE/soak"; reset+=" A trial window for ${sc:0:8} was dropped because that version is not the one running."; fi
    fi
  fi
  [[ -z $REQ_ID ]] && REQ_ID="interrupted-$(date +%s)"
  finish failed "The ${TARGET:-deploy} run for ${COMMIT:0:8} was cut off before it finished (the deployer was stopped part-way).$reset Check what runs before deploying again."
}

main() {
  local req="$INBOX/request.json"
  # What this host says about itself (BOS-427), refreshed every tick, so an owner card's steps can be
  # checked against the real folders before they reach the owner.
  write_host_facts || true  # never let a stat failure stop a deploy
  if ((ROLLBACK)); then
    bluegreen_enabled || { echo "ERROR: this install does not use blue/green; use scripts/deploy.sh --rollback." >&2; exit 1; }
    local rrc=0
    REQ_ID="rollback-$(date +%s)" TARGET=server STARTED="$(now)" FROM="$(g rev-parse HEAD)" COMMIT="$FROM"
    do_rollback_bluegreen || rrc=$?
    ((!DRY)) || exit "$rrc"
    COMMIT="$(g rev-parse HEAD)"
    log "${BG_RESULT:-failed}: ${BG_MSG:-Rollback stopped with an error.}"
    write_status "${BG_RESULT:-failed}" "${BG_MSG:-Rollback stopped with an error. See $LOG on the host.}" "$BG_BACKUP"
    post_webhook "${BG_RESULT:-failed}" "${BG_MSG:-Rollback failed.}"
    exit "$rrc"
  fi
  if ((ACK)); then
    bluegreen_enabled || { echo "ERROR: this install does not use blue/green." >&2; exit 1; }
    ((!DRY)) || { echo "[dry-run] --ack-health would record every container as it is now and re-run the checklist."; exit 0; }
    local ap=stopped
    [[ -f $STATE/soak && ! -L $STATE/soak ]] && ap=standby
    take_baseline; rm -f "$STATE/last-health-alert" "$STATE/planned-db"
    if stack_check "$(g rev-parse HEAD)" "$SOAK_CHECK_SECONDS" ack "$ap"; then log "Health accepted: baseline renewed; the checklist passes."; exit 0; fi
    log "Baseline renewed, but the checklist still fails: $VERIFY_WHY"; exit 1
  fi
  recover_interrupted
  if bluegreen_enabled; then soak_tick; fi
  if [[ ! -e $req && ! -L $req ]]; then refresh_available; exit 0; fi

  # Take the file by renaming it: the server can then no longer change it, and a symlink is
  # moved as a symlink rather than followed.
  local mine="$STATE/request.$$.json"
  if ((DRY)); then cp -P "$req" "$mine"; else mv -T "$req" "$mine"; fi
  trap 'rm -f "$mine"' EXIT
  STARTED="$(now)"; FROM="$(g rev-parse HEAD 2>/dev/null || true)"

  [[ -f $mine && ! -L $mine && $(stat -c %s "$mine") -le 4096 ]] || finish rejected "Rejected: the request file is not a plain file under 4 KB."
  # The request is untrusted: it must be one flat object whose five fields are plain strings of safe characters.
  # Whitespace is dropped first, so the shape check below is one strict pattern; nothing is evaluated or sourced.
  local k flat id target commit at by
  [[ $(LC_ALL=C tr -d '\0' <"$mine" | wc -c) -eq $(stat -c %s "$mine") ]] || finish rejected "Rejected: the request file does not match the expected format."
  flat="$(LC_ALL=C tr -d ' \t\r\n' <"$mine")"
  local pair='"[A-Za-z]{1,32}":"[A-Za-z0-9_.:+-]{0,64}"'
  [[ $flat =~ ^\{$pair(,$pair)*\}$ ]] || finish rejected "Rejected: the request file does not match the expected format."
  for k in id target commit requestedAt approvedBy; do
    [[ $(grep -oE "\"$k\":" <<<"${flat//,/$'\n'}" | wc -l) -eq 1 ]] || finish rejected "Rejected: the request file does not match the expected format."
  done
  id="$(jfield id <<<"$flat")" target="$(jfield target <<<"$flat")" commit="$(jfield commit <<<"$flat")"
  at="$(jfield requestedAt <<<"$flat")" by="$(jfield approvedBy <<<"$flat")"
  [[ $id =~ ^[0-9a-fA-F-]{36}$ && $target =~ ^(server|runner)$ && $commit =~ ^[0-9a-f]{40}$ && $by =~ ^[A-Za-z0-9_.-]{1,64}$ && $at =~ ^[0-9T:.+Z-]{10,40}$ ]] ||
    finish rejected "Rejected: the request file does not match the expected format."
  REQ_ID=$id TARGET=$target COMMIT=$commit

  # Accept both spacings: history lines written by older versions may be compact.
  if [[ -s $OUTBOX/history.jsonl ]] && grep -qE "\"id\":[[:space:]]*\"$REQ_ID\"" "$OUTBOX/history.jsonl"; then
    finish rejected "Rejected: this request was already handled."
  fi

  local head tip last wait problem
  head="$FROM"
  [[ -n $head ]] || finish failed "The checkout at $REPO is not a git repository."
  if [[ $TARGET == server ]]; then
    tip="$(remote_tip)"
    [[ -n $tip ]] || finish rejected "Rejected: could not read main from GitHub. Try again in a few minutes."
    # The offer the owner approved was stale: drop it, so the next minute writes one for the real tip.
    [[ $COMMIT == "$tip" ]] || { rm -f "$OUTBOX/available.json"; finish rejected "Rejected: ${COMMIT:0:8} is not the tip of main (${tip:0:8}). Approve the latest deploy instead."; }
  else
    # Runners are built from what is checked out, which is what the server deploy put there.
    [[ $COMMIT == "$head" ]] || finish rejected "The runners were not updated. They can only be rebuilt from the version the server runs, which is ${head:0:8}, and you asked for ${COMMIT:0:8} (the server update to it may still be running, or was switched back). Nothing is broken and nothing needs doing now: once the server runs the version you want, use Build and update runners in Settings."
  fi

  last="$(cat "$STATE/last-$TARGET" 2>/dev/null || echo 0)"
  wait=$((last + RATE_LIMIT_SECONDS - $(date +%s)))
  ((wait <= 0)) || finish rejected "Rejected: only one $TARGET deploy every $((RATE_LIMIT_SECONDS / 60)) minutes. Try again in $(((wait + 59) / 60)) minute(s)."

  if [[ $TARGET == server ]]; then
    [[ $head != "$COMMIT" ]] || finish nothing_new "Nothing new: ${head:0:8} is already deployed."
    g fetch --quiet origin main || finish rejected "Rejected: git fetch from GitHub failed."
    g cat-file -e "$COMMIT^{commit}" 2>/dev/null || finish rejected "Rejected: commit ${COMMIT:0:8} is not in the repository after fetching."
    g merge-base --is-ancestor "$head" "$COMMIT" || finish rejected "Rejected: ${COMMIT:0:8} is not a fast-forward of the deployed ${head:0:8}."
    local infra
    infra="$(g diff --name-only "$head" "$COMMIT" | grep -E "$INFRA" | { grep -Ev "$NOT_INFRA" || true; } | head -5 | paste -sd, - || true)"
    [[ -z $infra ]] || finish rejected "Rejected: this change touches deployment files ($infra). Deploy it by hand on the host: scripts/deploy.sh"
  fi

  if ((DRY)); then
    if [[ $TARGET == server ]]; then problem="$(readable_problem "$REPO")"; [[ -z $problem ]] || log "[dry-run] the real run would stop: $problem"; fi
    log "[dry-run] checks passed: would run: $(if [[ $TARGET != server ]]; then echo "scripts/update-runner.sh"; elif bluegreen_enabled; then echo "a blue/green swap to ${COMMIT:0:8}"; else echo "scripts/deploy.sh --yes --no-runner --commit ${COMMIT:0:8}"; fi)"
    exit 0
  fi

  printf '%s\n' "$(date +%s)" >"$STATE/last-$TARGET"
  if [[ -f $LOG && $(stat -c %s "$LOG") -gt 1000000 ]]; then tail -n 2000 "$LOG" >"$LOG.tmp" && mv "$LOG.tmp" "$LOG"; fi
  write_status running "Running: $TARGET ${COMMIT:0:8}"
  log "Running the $TARGET action for ${COMMIT:0:8} (request $REQ_ID)."
  local rc=0 result msg
  if [[ $TARGET == server ]] && bluegreen_enabled; then
    do_deploy_bluegreen >>"$LOG" 2>&1 || rc=$?
    [[ $BG_RESULT == deployed ]] || BG_MSG="${BG_MSG:-The blue/green swap stopped with an error (exit $rc).} See $LOG on the host."
    finish "${BG_RESULT:-failed}" "$BG_MSG" "$BG_BACKUP"
  fi
  if [[ $TARGET == server ]]; then do_deploy_server >>"$LOG" 2>&1 || rc=$?; else do_update_runner >>"$LOG" 2>&1 || rc=$?; fi
  if [[ $TARGET == server ]]; then
    result="$(deploy_status_field result)"; msg="$(deploy_status_field message)"
    [[ $(deploy_status_field to_commit) == "$COMMIT" ]] || { result=""; msg=""; }
  else
    result=""; msg=""
  fi
  if ((rc == 0)); then
    [[ $result == nothing_new ]] || result=deployed
    if [[ $TARGET == server ]]; then msg="Deployed ${head:0:8} to ${COMMIT:0:8}."; else msg="New runner image ready (commit ${COMMIT:0:8}); Boss Man is waiting for runs to finish, then swaps the runners and reports the result."; fi
  else
    case $result in partial | rolled_back) ;; *) result=failed ;; esac
    msg="${msg:-The $TARGET action stopped with an error (exit $rc).} See $LOG on the host."
  fi
  finish "$result" "$msg" "$(deploy_status_field backup)"
}

main
