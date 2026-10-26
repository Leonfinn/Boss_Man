#!/usr/bin/env bash
# Host deployer (self-deploy phase 1, docs/09-self-deploy.md). Run as root by a TrueNAS cron job
# every minute. Install a COPY of this file in the deployer folder; never run it from the git
# checkout, so a merged change cannot alter what root runs (docs/06-install-truenas.md).
#
#   host-deployer.sh              handle one request, if there is one
#   host-deployer.sh --dry-run    run every check and say what would happen; changes nothing
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
#   SOAK_SECONDS       blue/green: how long the old colour stays up as a standby after a good swap (900)
#
# Blue/green (docs/09-self-deploy.md, "Phase 3, part 2"): when COMPOSE_FILE (environment or the checkout's .env)
# names deploy/truenas-bluegreen.yml, target "server" does a zero-downtime colour swap instead of deploy.sh.
# Without that, nothing under the "Blue/green" heading runs.
set -euo pipefail

DRY=0
case "${1:-}" in --dry-run) DRY=1 ;; "") ;; *) echo "Usage: $0 [--dry-run]" >&2; exit 2 ;; esac

export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin # cron's PATH is minimal
# The copy lives in the deployer folder, which sits beside the checkout (src) in the install folder.
D="${BOSSMAN_DEPLOYER:-$(cd "$(dirname "$0")" && pwd)}"
REPO="$D/../src"
WEBHOOK_URL="" WEBHOOK_ON_SUCCESS=0 RATE_LIMIT_SECONDS=600 AVAILABLE_REFRESH_SECONDS=300
BG_POLL_SECONDS="${BG_POLL_SECONDS:-2}" BG_READY_SECONDS="${BG_READY_SECONDS:-120}" BG_HANDOVER_SECONDS="${BG_HANDOVER_SECONDS:-30}" SOAK_SECONDS="${SOAK_SECONDS:-900}"
CONF="$D/host.conf"
if [[ -e $CONF ]]; then
  [[ ! -L $CONF && $(stat -c %u "$CONF") == "$(id -u)" && $(stat -c %a "$CONF") =~ ^[0-7]00$ ]] || { echo "ERROR: $CONF must be a plain file, owned by $(id -un), mode 600." >&2; exit 1; }
  # shellcheck disable=SC1090
  source "$CONF"
fi
INBOX="$D/inbox" OUTBOX="$D/outbox" STATE="$D/state" LOG="$D/deployer.log"
INFRA='^(docker-compose[^/]*\.ya?ml$|deploy/|scripts/|\.github/|\.gitea/|\.dockerignore$|\.npmrc$|\.env|(.*/)?Dockerfile[^/]*$)'
# Same rule as needs_runner in scripts/deploy.sh (scripts/host-deployer.test.sh keeps them equal).
RUNNER_PATHS='^(apps/runner/|apps/launcher/|packages/shared/|pnpm-lock\.yaml$)'

# Git as root must not run hooks from a checkout that agents' commits land in; deploy.sh inherits this.
export GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.hooksPath GIT_CONFIG_VALUE_0=/dev/null GIT_TERMINAL_PROMPT=0
g() { git -C "$REPO" "$@"; }

now() { date -u +%Y-%m-%dT%H:%M:%SZ; }
log() { ((DRY)) || printf '%s %s\n' "$(now)" "$*" >>"$LOG"; printf '%s\n' "$*"; }
json() { python3 -I -c 'import json,sys; print(json.dumps(dict(a.split("=", 1) for a in sys.argv[1:])))' "$@"; }

[[ -d $INBOX && -d $OUTBOX ]] || { echo "ERROR: $INBOX and $OUTBOX must exist (docs/06-install-truenas.md, Install the host deployer)." >&2; exit 1; }
mkdir -p "$STATE"
exec 9>"$D/lock"
flock -n 9 || exit 0 # a run is already going; the next minute tries again

REQ_ID="" TARGET="" COMMIT="" STARTED="" FROM=""

write_status() { # result message [backup]
  ((DRY)) && { log "[dry-run] status: $1: $2"; return 0; }
  local ended=""
  [[ $1 == running ]] || ended="$(now)"
  json id="$REQ_ID" target="$TARGET" result="$1" message="$2" from_commit="$FROM" to_commit="$COMMIT" started="$STARTED" ended="$ended" at="${ended:-$STARTED}" backup="${3:-}" >"$OUTBOX/status.json.tmp"
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

# The newest commit on main as the remote says it, read with the deploy key. Empty if unreachable.
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
  python3 -I - "$head" "$tip" "$commits" "$paths" "$INFRA" "$RUNNER_PATHS" "$(now)" >"$f.tmp" <<'PY'
import json, re, sys
head, tip, cf, pf, infra, runner, at = sys.argv[1:]
commits = [dict(zip(("sha", "subject"), l.rstrip("\n").split(" ", 1))) for l in open(cf) if l.strip()]
paths = [l.rstrip("\n") for l in open(pf) if l.strip()]
print(json.dumps({"version": 1, "checkedAt": at, "deployed": head, "tip": tip, "commits": commits,
                  "paths": paths[:300], "infraPaths": [p for p in paths if re.search(infra, p)][:50],
                  "runnerChanged": any(re.search(runner, p) for p in paths)}))
PY
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
  c="$(sed -n 's/^[[:space:]]*reverse_proxy server-\(blue\|green\):.*/\1/p' "$INCLUDE" | head -1)"
  [[ -n $c ]] && echo "$c"
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
jfield() { python3 -I -c 'import json,sys; print(json.load(sys.stdin).get(sys.argv[1], ""))' "$1" 2>/dev/null || true; }

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
  compose exec -T db pg_dump -U bossman bossman | gzip >"$BG_BACKUP.partial" || { rm -f "$BG_BACKUP.partial"; return 1; }
  { [[ -s $BG_BACKUP.partial ]] && gzip -t "$BG_BACKUP.partial"; } || { rm -f "$BG_BACKUP.partial"; return 1; }
  mv "$BG_BACKUP.partial" "$BG_BACKUP"
  # Same retention as deploy.sh: only bossman-*.sql.gz, newest 14 kept.
  old="$(find "$dir" -maxdepth 1 -type f -name 'bossman-*.sql.gz' -printf '%T@ %p\n' | sort -rn | tail -n +15 | cut -d' ' -f2-)"
  [[ -z $old ]] || while IFS= read -r f; do rm -f -- "$f"; done <<<"$old"
}

BG_RESULT="" BG_MSG="" BG_BACKUP="" BG_LIVE="" BG_IDLE="" BG_PREV=""
bg_fail() { BG_RESULT=$1; BG_MSG=$2; return 1; }

# Reverses a hand-over: demote the new colour, promote the old, point the proxy back, check, stop the new one.
switch_back() {
  local ok=1
  log "Switching back from $BG_IDLE to $BG_LIVE."
  compose kill -s USR1 "server-$BG_IDLE" >>"$LOG" 2>&1 || true
  compose kill -s USR2 "server-$BG_LIVE" >>"$LOG" 2>&1 || ok=0
  if ((ok)); then wait_ready "server-$BG_LIVE" leader "" "$BG_HANDOVER_SECONDS" || ok=0; fi
  if ((ok)); then flip_proxy "$BG_LIVE" || ok=0; fi
  if ((ok)); then wait_ready proxy leader "" "$BG_HANDOVER_SECONDS" || ok=0; fi
  compose stop "server-$BG_IDLE" >>"$LOG" 2>&1 || true
  g reset --quiet --hard "$BG_PREV" || true
  ((ok))
}

# After the swap: the proxy answers as the new leader at the new commit, and the portal answers.
verify_live() { # commit seconds
  wait_ready proxy leader "$1" "$2" && probe proxy 3101 /portal.html >/dev/null 2>&1
}

pre_fail() { # message: undo what happened before the hand-over; the live colour was never touched
  compose stop "server-$BG_IDLE" >>"$LOG" 2>&1 || true
  g reset --quiet --hard "$BG_PREV" || true
  bg_fail failed "$1 The live colour ($BG_LIVE) was not touched. Backup: $BG_BACKUP"
}

do_deploy_bluegreen() {
  local c why=""
  BG_PREV="$FROM"
  BG_LIVE="$(live_colour)" || { bg_fail failed "No usable $INCLUDE: do the first blue/green bring-up by hand (docs/06-install-truenas.md, 9d)."; return 1; }
  BG_IDLE="$(other_colour "$BG_LIVE")"
  for c in proxy "server-$BG_LIVE"; do
    [[ -n $(compose ps -q "$c" 2>/dev/null) ]] || { bg_fail failed "The $c container is not running; nothing was changed."; return 1; }
  done
  rm -f "$STATE/soak" # a swap while the last one is soaking ends that soak: its standby is about to be rebuilt

  log "Blue/green: $BG_LIVE is live; building $BG_IDLE at ${COMMIT:0:8}."
  backup_database || { bg_fail failed "The backup failed. Nothing was changed."; return 1; }
  g merge --ff-only --quiet "$COMMIT" || { bg_fail failed "Could not move the checkout to ${COMMIT:0:8}."; return 1; }
  BOSSMAN_COMMIT="$COMMIT" compose build "server-$BG_IDLE" >>"$LOG" 2>&1 || { pre_fail "Building $BG_IDLE failed."; return 1; }
  # Expand-only migrations: the live colour keeps working on the new schema.
  BOSSMAN_MIGRATE_TAG="$BG_IDLE" compose run --rm migrate >>"$LOG" 2>&1 || { pre_fail "The migration failed (the database rolled it back)."; return 1; }
  compose up -d --no-deps --force-recreate "server-$BG_IDLE" >>"$LOG" 2>&1 || { pre_fail "Starting $BG_IDLE failed."; return 1; }
  # It is a standby because the live colour holds the leader lock; seeing that also shows the lock works.
  wait_ready "server-$BG_IDLE" standby "$COMMIT" "$BG_READY_SECONDS" || { pre_fail "$BG_IDLE did not come up as a standby at ${COMMIT:0:8} within ${BG_READY_SECONDS}s."; return 1; }
  # A login-free read straight from the idle colour (not through the proxy).
  [[ $(probe "server-$BG_IDLE" 3100 /api/setup 2>/dev/null | jfield needsSetup) == False ]] || { pre_fail "The smoke test on $BG_IDLE failed (GET /api/setup)."; return 1; }

  log "Smoke test passed. Handing over: demote $BG_LIVE, promote $BG_IDLE."
  compose kill -s USR1 "server-$BG_LIVE" >>"$LOG" 2>&1 || { pre_fail "Could not signal $BG_LIVE."; return 1; }
  # From here the old colour may have let go, so any failure is undone with switch_back.
  wait_ready "server-$BG_LIVE" standby "" "$BG_HANDOVER_SECONDS" || why="$BG_LIVE did not step down."
  [[ -n $why ]] || compose kill -s USR2 "server-$BG_IDLE" >>"$LOG" 2>&1 || why="Could not signal $BG_IDLE."
  [[ -n $why ]] || wait_ready "server-$BG_IDLE" leader "$COMMIT" "$BG_HANDOVER_SECONDS" || why="$BG_IDLE did not become the leader."
  [[ -n $why ]] || flip_proxy "$BG_IDLE" || why="The proxy did not accept the switch to $BG_IDLE."
  [[ -n $why ]] || verify_live "$COMMIT" "$BG_READY_SECONDS" || why="The checks through the proxy failed."
  if [[ -n $why ]]; then
    if switch_back; then bg_fail rolled_back "$why Switched back to $BG_LIVE automatically. Backup: $BG_BACKUP"
    else bg_fail failed "$why The switch-back ALSO failed: look at the NAS now (docker compose ps; $LOG). Backup: $BG_BACKUP"; fi
    return 1
  fi

  printf 'old=%s new=%s deadline=%s commit=%s prev=%s\n' "$BG_LIVE" "$BG_IDLE" "$(($(date +%s) + SOAK_SECONDS))" "$COMMIT" "$BG_PREV" >"$STATE/soak"
  BG_RESULT=deployed
  BG_MSG="Deployed ${BG_PREV:0:8} to ${COMMIT:0:8}: $BG_IDLE is live; $BG_LIVE stays up as a standby for $((SOAK_SECONDS / 60)) minutes, and the deployer switches back by itself if the checks fail."
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
  if verify_live "$commit" 10; then
    if (($(date +%s) >= deadline)); then
      log "Soak over: stopping the old colour ($old)."
      compose stop "server-$old" >>"$LOG" 2>&1 || log "Could not stop server-$old."
      rm -f "$f"
    fi
    return 0
  fi
  BG_LIVE="$old" BG_IDLE="$new" BG_PREV="$prev"
  REQ_ID="auto-rollback-$(date +%s)" TARGET=server STARTED="$(now)" FROM="$commit" COMMIT="$prev"
  rm -f "$f"
  if switch_back; then finish rolled_back "The checks on $new failed during the standby window; switched back to $old automatically (code back at ${prev:0:8})."
  else finish failed "The checks on $new failed and the automatic switch-back to $old ALSO failed: look at the NAS now (docker compose ps; $LOG)."; fi
}

# Reads a field of scripts/deploy.sh's own status file.
deploy_status_field() { python3 -I -c 'import json,sys; print(json.load(open(sys.argv[1])).get(sys.argv[2], ""))' "${BOSSMAN_DEPLOY_STATUS:-${BOSSMAN_BACKUP_DIR:-$D/..}/deploy-status.json}" "$1" 2>/dev/null || true; }

main() {
  local req="$INBOX/request.json"
  if bluegreen_enabled; then soak_tick; fi
  if [[ ! -e $req && ! -L $req ]]; then refresh_available; exit 0; fi

  # Take the file by renaming it: the server can then no longer change it, and a symlink is
  # moved as a symlink rather than followed.
  local mine="$STATE/request.$$.json"
  if ((DRY)); then cp -P "$req" "$mine"; else mv -T "$req" "$mine"; fi
  trap 'rm -f "$mine"' EXIT
  STARTED="$(now)"; FROM="$(g rev-parse HEAD 2>/dev/null || true)"

  [[ -f $mine && ! -L $mine && $(stat -c %s "$mine") -le 4096 ]] || finish rejected "Rejected: the request file is not a plain file under 4 KB."
  local parsed
  parsed="$(python3 -I - "$mine" <<'PY'
import json, re, sys
try:
    d = json.load(open(sys.argv[1]))
except Exception:
    sys.exit(1)
ok = isinstance(d, dict) and all(isinstance(d.get(k), str) for k in ("id", "target", "commit", "requestedAt", "approvedBy"))
ok = ok and re.fullmatch(r"[0-9a-fA-F-]{36}", d["id"]) and d["target"] in ("server", "runner") and re.fullmatch(r"[0-9a-f]{40}", d["commit"])
ok = ok and re.fullmatch(r"[A-Za-z0-9_.-]{1,64}", d["approvedBy"]) and re.fullmatch(r"[0-9T:.+Z-]{10,40}", d["requestedAt"])
if not ok:
    sys.exit(1)
print(d["id"], d["target"], d["commit"])
PY
)" || finish rejected "Rejected: the request file does not match the expected format."
  read -r REQ_ID TARGET COMMIT <<<"$parsed"

  if [[ -s $OUTBOX/history.jsonl ]] && grep -qF "\"id\": \"$REQ_ID\"" "$OUTBOX/history.jsonl"; then
    finish rejected "Rejected: this request was already handled."
  fi

  local head tip last wait
  head="$FROM"
  [[ -n $head ]] || finish failed "The checkout at $REPO is not a git repository."
  if [[ $TARGET == server ]]; then
    tip="$(remote_tip)"
    [[ -n $tip ]] || finish rejected "Rejected: could not read main from GitHub. Try again in a few minutes."
    # The offer the owner approved was stale: drop it, so the next minute writes one for the real tip.
    [[ $COMMIT == "$tip" ]] || { rm -f "$OUTBOX/available.json"; finish rejected "Rejected: ${COMMIT:0:8} is not the tip of main (${tip:0:8}). Approve the latest deploy instead."; }
  else
    # Runners are built from what is checked out, which is what the server deploy put there.
    [[ $COMMIT == "$head" ]] || finish rejected "Rejected: runners are updated only to the commit that is deployed (${head:0:8}), not ${COMMIT:0:8}."
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
    infra="$(g diff --name-only "$head" "$COMMIT" | grep -E "$INFRA" | head -5 | paste -sd, - || true)"
    [[ -z $infra ]] || finish rejected "Rejected: this change touches deployment files ($infra). Deploy it by hand at the NAS: scripts/deploy.sh"
  fi

  if ((DRY)); then
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
    [[ $BG_RESULT == deployed ]] || BG_MSG="${BG_MSG:-The blue/green swap stopped with an error (exit $rc).} See $LOG on the NAS."
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
    msg="${msg:-The $TARGET action stopped with an error (exit $rc).} See $LOG on the NAS."
  fi
  finish "$result" "$msg" "$(deploy_status_field backup)"
}

main
