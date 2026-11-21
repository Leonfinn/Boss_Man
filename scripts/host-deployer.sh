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
# one of three fixed actions: scripts/deploy.sh (target "server"), scripts/update-runner.sh
# (target "runner"), or a restart of the server at the commit that already runs (target "restart",
# BOS-647: a blue/green swap to a fresh copy, or deploy.sh --force on a single server; it never
# fetches or moves the checkout). Nothing from the request is ever executed or put on a command line unchecked.
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
#   DEPLOY_MIN_FREE_MB     memory (MB) that must be free before an update request is taken; empty = worked out (BOS-420):
#                          the build allowance + 1024, and on blue/green also room for a second server: a freshly started
#                          one (DEPLOY_NEW_SERVER_MB), or BOSSMAN_SERVER_MEMORY when that cap is smaller. Never what the live
#                          server uses now: a leaking server would hold back the update that replaces it. Published in
#                          outbox/headroom.json, with the live server's own use (liveServerMb) beside it.
#   DEPLOY_BUILD_MEMORY_MB what an image build needs (3072); the deployer logs the lowest free memory of each update to tune it
#   DEPLOY_NEW_SERVER_MB   blue/green: what a freshly started server colour needs (4096)
#   STAGING_DIR            the staging install folder (its own checkout, docs/22-staging.md). Empty = the staging lane is off.
#                          With it set, inbox/staging-request.json (the same five-field format, target "staging") deploys a
#                          commit that is on main to staging with scripts/deploy-staging.sh, runs scripts/smoke-staging.sh, and
#                          writes outbox/staging-status.json and outbox/staging-lane.json. Never touches production's files.
#   STAGING_RATE_LIMIT_SECONDS  min gap between two staging deploys (300)
#   STAGING_TIMEOUT_SECONDS     longest a staging deploy may run before it is stopped (1800). The lane shares the deployer's one lock, so
#                               a production request that arrives meanwhile waits for it (at most this long, and an urgent one too).
# The smoke checks sign in with an optional smoke account: a file $BOSSMAN_DEPLOYER/smoke-credentials (same rules as host.conf:
# plain file, owned by the user running this, mode 600) holding smoke_username=<name> and smoke_password=<password>. Without it those checks are skipped.
#
# Blue/green (docs/09-self-deploy.md, "Phase 3, part 2"): when COMPOSE_FILE (environment or the checkout's .env)
# names deploy/truenas-bluegreen.yml, target "server" does a zero-downtime colour swap instead of deploy.sh.
# Without that, nothing under the "Blue/green" heading runs.
set -euo pipefail

DRY=0 ROLLBACK=0 ACK=0 FACTS=0
for arg in "$@"; do
  case "$arg" in --dry-run) DRY=1 ;; --rollback) ROLLBACK=1 ;; --ack-health) ACK=1 ;; --facts) FACTS=1 ;; *) echo "Usage: $0 [--dry-run] | --rollback [--dry-run] | --ack-health | --facts" >&2; exit 2 ;; esac
done

export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin # cron's PATH is minimal
# The copy lives in the deployer folder, which sits beside the checkout (src) in the install folder.
D="${BOSSMAN_DEPLOYER:-$(cd "$(dirname "$0")" && pwd)}"
REPO="$D/../src"
WEBHOOK_URL="" WEBHOOK_ON_SUCCESS=0 RATE_LIMIT_SECONDS=600 AVAILABLE_REFRESH_SECONDS=300
STAGING_DIR="" STAGING_RATE_LIMIT_SECONDS=300 STAGING_TIMEOUT_SECONDS=1800 # the staging lane (BOS-1472); off while STAGING_DIR is empty
BG_STOP_SECONDS="${BG_STOP_SECONDS:-60}" # a planned stop's grace before Docker sends SIGKILL (BOS-794); the server's shutdown drains work
[[ $BG_STOP_SECONDS =~ ^[0-9]{1,4}$ ]] || BG_STOP_SECONDS=60
# BOS-2058 (rule b): the idle colour's build has an end of its own. A build that hangs is stopped here, the update fails
# and the live colour stays; the server's "server-build" wait ends at 45 min, so this stays inside it.
BG_BUILD_SECONDS="${BG_BUILD_SECONDS:-2400}"
[[ $BG_BUILD_SECONDS =~ ^[0-9]{1,5}$ ]] || BG_BUILD_SECONDS=2400
BG_POLL_SECONDS="${BG_POLL_SECONDS:-2}" BG_READY_SECONDS="${BG_READY_SECONDS:-120}" BG_HANDOVER_SECONDS="${BG_HANDOVER_SECONDS:-30}" SOAK_SECONDS="${SOAK_SECONDS:-900}" SOAK_CHECK_SECONDS="${SOAK_CHECK_SECONDS:-60}"
DEPLOY_MIN_FREE_MB="${DEPLOY_MIN_FREE_MB:-}" DEPLOY_BUILD_MEMORY_MB="${DEPLOY_BUILD_MEMORY_MB:-3072}" DEPLOY_NEW_SERVER_MB="${DEPLOY_NEW_SERVER_MB:-4096}"
# Where memory is read from (the tests point these at files of their own).
MEMINFO="${BOSSMAN_MEMINFO:-/proc/meminfo}" CGROUP_DIR="${BOSSMAN_CGROUP_DIR:-/sys/fs/cgroup}"
CONF="$D/host.conf"
if [[ -e $CONF ]]; then
  [[ ! -L $CONF && $(stat -c %u "$CONF") == "$(id -u)" && $(stat -c %a "$CONF") =~ ^[0-7]00$ ]] || { echo "ERROR: $CONF must be a plain file, owned by $(id -un), mode 600." >&2; exit 1; }
  # shellcheck disable=SC1090
  source "$CONF"
fi
INBOX="$D/inbox" OUTBOX="$D/outbox" STATE="$D/state" LOG="$D/deployer.log"
# Files that change how Boss Man runs or deploys. Build-only scripts (make-app-icons, check-*, test-*, lint-migrations, backups) are not on it (BOS-269);
# docs/09-self-deploy.md lists the same files. scripts/host-deployer.sh stays on the list (BOS-1588, security review): it is
# what root runs, so a change to it is applied by the owner on the hand-apply card; that hand deploy then refreshes the copy
# itself with scripts/install-deployer.sh (also on the list, as it runs as root).
INFRA='^(docker-compose[^/]*\.ya?ml$|deploy/|scripts/(deploy|rebuild-live|update-runner|host-deployer|install-deployer)\.sh$|\.dockerignore$|\.npmrc$|\.env|(.*/)?Dockerfile[^/]*$)'
# Under deploy/ but never used by Boss Man's own containers: the Penpot add-on is its own Compose project (docs/15).
NOT_INFRA='^deploy/(penpot|ntfy|ntfy-bluegreen)\.yml$'
# Same rule as needs_runner in scripts/deploy.sh (scripts/host-deployer.test.sh keeps them equal) and RUNNER_CODE_PATHS in
# packages/shared/src/go-live.ts: what the runner, launcher and netguard images COPY in, read from their Dockerfiles (BOS-1648).
RUNNER_PATHS='^(apps/runner/Dockerfile$|apps/runner/package\.json$|apps/runner/src/|apps/runner/claude-pack/|apps/launcher/Dockerfile$|apps/launcher/package\.json$|apps/launcher/tsconfig\.json$|apps/launcher/tsconfig\.build\.json$|apps/launcher/src/|apps/netguard/Dockerfile$|apps/netguard/netguard\.sh$|packages/shared/package\.json$|packages/shared/src/|scripts/check-slot\.sh$|scripts/scan-added-lines\.mjs$|scripts/scan-allow\.txt$|package\.json$|pnpm-workspace\.yaml$|pnpm-lock\.yaml$|tsconfig\.base\.json$|NOTICE$)'

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
REFUSAL=0 # 1 while a rate-limit refusal is recorded: write_status then leaves status.json alone (BOS-1469)
RESTART=0 # 1 while a "restart" request runs the blue/green swap: same commit, different messages, no rollback record
HEALTH_KV=() # the latest whole-stack checklist as key=value pairs (stack, check_*), merged into the status file
REQ_KV=()    # what the request asked for when it differs from what runs (BOS-753): requested_commit, runner_changed
PICK_NOTE="" # why the commit that runs is not the one the owner approved (BOS-753), added to every message after the pick

write_status() { # result message [backup]
  ((DRY)) && { log "[dry-run] status: $1: $2"; return 0; }
  local ended=""
  [[ $1 == running ]] || ended="$(now)"
  local soak=0 # the standby window this host really uses (BOS-401): the server holds the runner update for it
  if bluegreen_enabled; then soak="$SOAK_SECONDS"; fi
  # BOS-1469: a rate-limit refusal goes to refused.json, never over status.json, so it can't replace the result of the run that really happened.
  local out=status.json
  ((REFUSAL)) && out=refused.json
  json id="$REQ_ID" target="$TARGET" result="$1" message="$2" from_commit="$FROM" to_commit="$COMMIT" started="$STARTED" ended="$ended" at="${ended:-$STARTED}" backup="${3:-}" soak_seconds="$soak" ${REQ_KV[@]+"${REQ_KV[@]}"} ${HEALTH_KV[@]+"${HEALTH_KV[@]}"} >"$OUTBOX/$out.tmp"
  chmod 644 "$OUTBOX/$out.tmp"
  mv "$OUTBOX/$out.tmp" "$OUTBOX/$out"
  [[ $1 == running ]] || cat "$OUTBOX/$out" >>"$OUTBOX/history.jsonl"
}

post_webhook() { # result message
  [[ -n $WEBHOOK_URL ]] || return 0
  case $1 in deployed | nothing_new) [[ $WEBHOOK_ON_SUCCESS == 1 ]] || return 0 ;; esac
  if ((DRY)); then log "[dry-run] would POST $1 to the webhook"; return 0; fi
  json result="$1" message="$2" from_commit="$FROM" to_commit="$COMMIT" at="$(now)" |
    curl -fsS --max-time 15 -X POST -H 'Content-Type: application/json' --data-binary @- -K <(printf 'url = "%s"\n' "$WEBHOOK_URL") >/dev/null 2>>"$LOG" || log "The webhook POST failed."
}

finish() { # result message [backup]: record the outcome, tell the owner, stop
  local msg="$2${PICK_NOTE:+ $PICK_NOTE}"
  log "$1: $msg"
  write_status "$1" "$msg" "${3:-}"
  post_webhook "$1" "$msg"
  exit 0
}

# The newest commit on main as the remote says it, read over whatever origin uses (https for a public repo, or an SSH remote with a read-only deploy key for a private one; docs/00 step 2). Empty if unreachable.
remote_tip() { g ls-remote origin refs/heads/main 2>/dev/null | awk '$2 == "refs/heads/main" { print $1 }' || true; }

# The merge commits Boss Man's merge gate checked (BOS-753), one full hash per line, written by the server into
# inbox/checked beside each request. Untrusted like the request: only a plain file under 256 KB is read, and only
# lines that are exactly a 40-character hash are kept. It can only narrow the choice below: every commit picked
# from it must still be on main, a fast-forward of what runs, and free of deployment files.
checked_list() {
  local f="$INBOX/checked"
  [[ -f $f && ! -L $f && $(stat -c %s "$f") -le 262144 ]] || return 0
  LC_ALL=C grep -xE '[0-9a-f]{40}' "$f" 2>/dev/null || true
}

# BOS-753: the owner approved COMMIT, but main has moved on to tip since the offer was written. An approval means
# "deploy the newest checked version", so walk main's own history (first parents: the merges themselves, never a
# branch's commits) from the tip back to the approved commit, and take the newest one that the merge gate checked
# and that needs no hand-apply. None: the approved commit itself, which is still on main and is what was approved.
# Sets COMMIT and PICK_NOTE. Every later check (fast-forward, deployment files, rate limit) still runs on the result.
pick_newest_checked() { # head approved tip
  local head=$1 approved=$2 tip=$3 c checked unchecked=0 hand=0 why="" infra
  checked="$(checked_list)"
  # Newest first; never a commit the running version already contains, so whatever is picked is a fast-forward of it.
  while IFS= read -r c; do
    [[ -n $c ]] || continue
    if ! grep -qxF "$c" <<<"$checked"; then unchecked=$((unchecked + 1)); continue; fi
    infra="$(g diff --name-only "$head" "$c" | grep -E "$INFRA" | { grep -Ev "$NOT_INFRA" || true; } || true)"
    if [[ -n $infra ]]; then hand=$((hand + 1)); continue; fi
    COMMIT=$c
    break
  done < <(g rev-list --first-parent "$tip" "^$approved" "^$head" 2>/dev/null || true)
  if [[ $COMMIT != "$approved" ]]; then
    if [[ $COMMIT == "$tip" ]]; then
      why="main had moved on to ${tip:0:8} by the time the deployer ran, so the deployer took that newest checked version instead."
    elif ((unchecked)); then
      why="main had moved on to ${tip:0:8} by the time the deployer ran, but the newest $unchecked commit(s) have not passed their merge check yet. ${COMMIT:0:8} is the newest one that has, so the deployer took it instead; the rest come in the next update."
    else
      why="main had moved on to ${tip:0:8} by the time the deployer ran, but the newer commits change deployment files and have to be applied by hand. ${COMMIT:0:8} is the newest checked one without them, so the deployer took it instead; the rest come in the next update."
    fi
    PICK_NOTE="You approved ${approved:0:8}; $why It includes everything you approved."
    return 0
  fi
  if [[ -z $checked ]]; then why="Boss Man did not say which newer commits passed their merge check"
  elif ((hand && !unchecked)); then why="the newer commits change deployment files and have to be applied by hand"
  else why="none of the newer commits has passed its merge check yet"; fi
  # The approved commit is already in what runs (a newer version went live since the card was raised): nothing to add.
  if g merge-base --is-ancestor "$approved" "$head" 2>/dev/null; then COMMIT=$head; fi
  PICK_NOTE="Main has moved on to ${tip:0:8} since you approved ${approved:0:8}, but $why, so the deployer kept to ${COMMIT:0:8}; the newer commits come in the next update."
}

# ---------------------------------------------------------------------------------------------------
# Which services an update changes (BOS-487, DR-020 B and C). Read from the rendered compose settings of each service,
# never from file paths: a comment-only edit changes nothing, a changed memory limit changes the database. The server
# deploy still rolls only the server colours (do_deploy_bluegreen and deploy.sh never start db or proxy); a changed
# db/proxy is reported here so Boss Man can raise its own owner step with a backup. SERVICE_COMPARE=0 (host.conf) turns
# this off; any failure to render is logged and reported as "not checked", and never blocks an update.
# ---------------------------------------------------------------------------------------------------
SERVICE_COMPARE="${SERVICE_COMPARE:-1}"
# The services whose settings only the owner's own step applies (the server deploy never touches them).
OWNER_SERVICES="db proxy"
RENDER_DIR="$STATE/render"

# stdin: `docker compose config`; prints "service hash" per service. For a Compose without `config --hash`.
hash_block() { # name block
  printf '%s %s\n' "$1" "$(printf '%s' "$2" | sha256sum | cut -d' ' -f1)"
}
split_hash() {
  local line name="" blk="" ins=0
  while IFS= read -r line; do
    if [[ $line == services:* ]]; then ins=1; continue; fi
    if [[ $line =~ ^[^[:space:]] ]]; then
      [[ -z $name ]] || hash_block "$name" "$blk"
      name="" blk="" ins=0; continue
    fi
    ((ins)) || continue
    if [[ $line =~ ^\ \ ([A-Za-z0-9_.-]+):[[:space:]]*$ ]]; then
      [[ -z $name ]] || hash_block "$name" "$blk"
      name="${BASH_REMATCH[1]}" blk=""
    fi
    blk+="$line"$'\n'
  done
  [[ -z $name ]] || hash_block "$name" "$blk"
}

# The compose project this host runs, taken from the live stack's own label; else COMPOSE_PROJECT_NAME; else the
# checkout folder's name the way Compose normalises it. Empty if nothing can be told (the render then fails).
compose_project() {
  local cid p=""
  cid="$(compose ps -q db 2>/dev/null | head -n 1)" || cid=""
  if [[ -n $cid ]]; then p="$(docker inspect -f '{{index .Config.Labels "com.docker.compose.project"}}' "$cid" 2>/dev/null)" || p=""; fi
  [[ -n $p ]] || p="${COMPOSE_PROJECT_NAME:-}"
  [[ -n $p ]] || p="$(grep -s '^COMPOSE_PROJECT_NAME=' "$REPO/.env" | tail -1 | cut -d= -f2- | tr -d "'\"" || true)"
  [[ -n $p ]] || p="$(basename "$(cd "$REPO" 2>/dev/null && pwd)" | tr '[:upper:]' '[:lower:]' | tr -cd 'a-z0-9_-')"
  printf '%s' "$p"
}

# "service hash" lines for a commit, on stdout. The commit is unpacked into one fixed folder (the same path for every
# commit, so relative bind mounts render the same and don't look like a change), with the checkout's own .env, and
# rendered under the live project's name and a pinned BOSSMAN_COMMIT, so nothing differs but the settings themselves.
# Nothing in the checkout is touched. Returns non-zero (and logs why) when it can't render.
unpack_commit() { (set -o pipefail; g archive "$1" | tar -x -C "$RENDER_DIR"); } # commit: into $RENDER_DIR
render_hashes() { # commit project
  local commit=$1 project=$2 out="" rc=0
  [[ -n $project ]] || { log "Service compare: could not tell the compose project name."; return 1; }
  rm -rf "$RENDER_DIR"; mkdir -p "$RENDER_DIR"
  # A function and not `if ! ( … ) 2>>"$LOG"`: bash does not apply the `!` when a group's or subshell's own redirect
  # fails, so that form would carry on unpacked (BOS-1689). scripts/negated-redirect.test.sh guards the pattern.
  if ! unpack_commit "$commit" 2>>"$LOG"; then
    log "Service compare: could not unpack ${commit:0:8}."; rm -rf "$RENDER_DIR"; return 1
  fi
  # The commit may carry its own .env or secrets (even a link to another file): remove them first, so the copy below
  # can never write through a link to some other file. This folder holds a copy of the host's .env (secrets): it lives
  # in $STATE, which is root-only, and is removed straight after the render (a run killed in between leaves it until
  # the next refresh, which starts by removing it).
  rm -rf "$RENDER_DIR/.env" "$RENDER_DIR/secrets"
  [[ ! -f $REPO/.env ]] || cp "$REPO/.env" "$RENDER_DIR/.env"
  [[ ! -d $REPO/secrets ]] || ln -s "$REPO/secrets" "$RENDER_DIR/secrets"
  out="$(cd "$RENDER_DIR" && BOSSMAN_DEPLOYER="$D" BOSSMAN_COMMIT=compare timeout 120 docker compose --project-name "$project" config --hash '*' 2>>"$LOG")" || rc=$?
  if ((rc != 0)) || ! grep -qE '^[A-Za-z0-9_.-]+ [0-9a-f]{8,}$' <<<"$out"; then
    # An older Compose has no --hash: hash each service's block of the rendered file instead.
    out="$(cd "$RENDER_DIR" && BOSSMAN_DEPLOYER="$D" BOSSMAN_COMMIT=compare timeout 120 docker compose --project-name "$project" config 2>>"$LOG" | split_hash)" || out=""
  fi
  rm -rf "$RENDER_DIR"
  out="$(grep -E '^[A-Za-z0-9_.-]+ [0-9a-f]{8,}$' <<<"$out" || true)"
  [[ -n $out ]] || { log "Service compare: the compose settings of ${commit:0:8} could not be rendered (see above); not comparing."; return 1; }
  printf '%s\n' "$out"
}

# Names whose hash differs between two "service hash" lists, including services that were added or removed.
changed_between() { # old-file new-file
  LC_ALL=C join -a1 -a2 -e MISSING -o 0,1.2,2.2 <(LC_ALL=C sort "$1") <(LC_ALL=C sort "$2") | awk '$2 != $3 { print $1 }'
}

service_container() { compose ps -q "$1" 2>/dev/null | head -n 1 || true; } # service: its container id, empty if none

# A service is "pending" when the live checkout's settings for it differ from what it last ran with and it has not been
# recreated since: the container id is the proof (a recreate gives a new one, a plain restart or reboot keeps it). The
# first look records the present state as applied. Reads state; writes only $STATE/applied-services.
pending_services() { # live-hashes-file: prints the pending service names
  local f="$STATE/applied-services" svc hash cid sh0 scid new="" line
  for svc in $OWNER_SERVICES; do
    hash="$(awk -v s="$svc" '$1 == s { print $2 }' "$1")"
    [[ -n $hash ]] || continue # the live stack has no such service
    cid="$(service_container "$svc")"
    [[ -n $cid ]] || { line="$(grep -E "^$svc " "$f" 2>/dev/null || true)"; [[ -z $line ]] || new+="$line"$'\n'; continue; } # not running: no verdict, keep what we knew
    line="$(grep -E "^$svc " "$f" 2>/dev/null || true)"
    if [[ -z $line ]]; then new+="$svc $hash $cid"$'\n'; continue; fi
    read -r _ sh0 scid <<<"$line"
    if [[ $sh0 == "$hash" ]]; then new+="$svc $hash $cid"$'\n'
    elif [[ $scid != "$cid" ]]; then new+="$svc $hash $cid"$'\n' # recreated since: applied
    else new+="$line"$'\n'; echo "$svc"; fi
  done
  printf '%s' "$new" >"$f.tmp" && mv "$f.tmp" "$f"
}

# Sets SVC_CHANGED (space-separated names), SVC_CHECKED (true/false), SVC_PENDING, DB_STARTED and DB_CID for available.json.
service_report() { # live-commit tip-commit (tip empty or equal to live: nothing to compare)
  SVC_CHANGED="" SVC_CHECKED=false SVC_PENDING="" DB_STARTED="" DB_CID=""
  [[ $SERVICE_COMPARE == 1 ]] || { log "Service compare is off (SERVICE_COMPARE in host.conf)."; return 0; }
  local project live="$STATE/svc.live" next="$STATE/svc.tip"
  project="$(compose_project)"
  render_hashes "$1" "$project" >"$live" || { rm -f "$live"; return 0; }
  if [[ -n $2 && $2 != "$1" ]]; then
    render_hashes "$2" "$project" >"$next" || { rm -f "$live" "$next"; return 0; }
    SVC_CHANGED="$(changed_between "$live" "$next" | tr '\n' ' ')"
  fi
  SVC_CHECKED=true
  SVC_PENDING="$(pending_services "$live" | tr '\n' ' ')"
  DB_CID="$(service_container db)"
  if [[ -n $DB_CID ]]; then DB_STARTED="$(docker inspect -f '{{.State.StartedAt}}' "$DB_CID" 2>/dev/null || true)"; fi
  rm -f "$live" "$next"
}
json_names() { # space-separated names: a JSON array of strings
  local n out="" sep=""
  for n in $1; do out+="$sep$(jstr "$n")"; sep=", "; done
  printf '[%s]' "$out"
}

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
      # The whole range, never a page of it: the card's change count, its ticket list and the "urgent fix" heading are all
      # read from this list. Until BOS-1826 it stopped at the newest 30 (-n 30), so a long gap between deploys showed
      # "30 changes" and dropped older merges, live fixes among them. A line is ~120 bytes, so even 1,000 commits is small.
      g log --format='%H %s' "$head..$tip" >"$commits"
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
  local clist="[$out]" plist="" ilist="" runner=false
  sep="" out=""
  # Every changed path, uncapped (BOS-1826): the card counts files and migrations from this list and looks in it for
  # scripts/host-deployer.sh, which git lists late (paths are sorted), so the old 300-path cap could hide the copy step.
  while IFS= read -r p; do
    [[ -n ${p//[[:space:]]/} ]] || continue
    plist+="$sep$(jstr "$p")"; sep=", "
    if [[ $p =~ $INFRA && ! $p =~ $NOT_INFRA ]]; then ilist+="${ilist:+, }$(jstr "$p")"; fi
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
  # Which services the update changes, and which of db/proxy still run with older settings than the live checkout (BOS-487).
  service_report "$head" "$tip"
  local svc
  svc=", \"changedServices\": $(json_names "$SVC_CHANGED"), \"servicesChecked\": $SVC_CHECKED, \"pendingServices\": $(json_names "$SVC_PENDING")"
  if [[ -n $DB_CID ]]; then svc+=", \"dbContainerId\": $(jstr "$DB_CID"), \"dbStartedAt\": $(jstr "$DB_STARTED")"; fi
  printf '{"version": 1, "checkedAt": %s, "deployed": %s, "tip": %s, "commits": %s, "paths": [%s], "infraPaths": [%s], "runnerChanged": %s, "srcDir": %s, "deployerDir": %s, "bluegreen": %s, "liveColour": %s%s%s}' \
    "$(jstr "$(now)")" "$(jstr "$head")" "$(jstr "$tip")" "$clist" "$plist" "$ilist" "$runner" "$(jstr "$srcdir")" "$(jstr "$deployerdir")" "$bg" "$(jstr "$colour")" "$soak" "$svc" >"$f.tmp"
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
  local extra; extra="$(host_extra_facts 2>/dev/null)" || extra=""
  printf '{"version": 1, "name": %s, "writtenAt": %s, "ownership": [%s]%s}\n' "$(jstr "$name")" "$(jstr "$(now)")" "$rows" "$extra" >"$f.tmp"
  chmod 644 "$f.tmp"; mv "$f.tmp" "$f"
}

# ---------------------------------------------------------------------------------------------------
# Memory headroom (BOS-420). On 3 Nov an update started on a full host, built an image and ran a second server
# beside the live one, and the host ran out of memory. So: every tick the deployer publishes how much memory is
# free and how much an update needs (outbox/headroom.json, its own file beside host.json), the server waits for
# a quiet host before it sends a request, and a request that still arrives while memory is short stays in the
# inbox (the floor) unless the owner chose "Update now anyway" ("quiet":"override" in the request). Each update's
# lowest free memory and highest swap use are logged, so the allowance can be set from real numbers.
# Works on any Linux host: /proc/meminfo, plus a container memory limit it doesn't show (an LXC without lxcfs).
# ---------------------------------------------------------------------------------------------------
MEM_TOTAL="" MEM_AVAIL="" SWAP_TOTAL="" SWAP_USED="" NEED_MB="" NEED_FROM="" NEW_SERVER_MB="" LIVE_SERVER_MB="" HOLDING=""
num_file() { local v; v="$(head -c 64 "$1" 2>/dev/null)" || return 0; v="${v//[[:space:]]/}"; if [[ $v =~ ^[0-9]{1,20}$ ]]; then printf '%s' "$v"; fi; }
meminfo_kb() { local v; v="$(awk -v k="$1:" '$1 == k { print $2; exit }' "$MEMINFO" 2>/dev/null)" || return 0; if [[ $v =~ ^[0-9]{1,15}$ ]]; then printf '%s' "$v"; fi; }

read_memory() { # sets MEM_TOTAL, MEM_AVAIL, SWAP_TOTAL, SWAP_USED in MB; left empty when this host can't say
  local t a f b c max cur st sf
  MEM_TOTAL="" MEM_AVAIL="" SWAP_TOTAL="" SWAP_USED=""
  t="$(meminfo_kb MemTotal)"; a="$(meminfo_kb MemAvailable)"
  [[ -n $t ]] || return 0
  if [[ -z $a ]]; then # kernels before 3.14
    f="$(meminfo_kb MemFree)" b="$(meminfo_kb Buffers)" c="$(meminfo_kb Cached)"
    [[ -n $f ]] || return 0
    a=$((f + ${b:-0} + ${c:-0}))
  fi
  MEM_TOTAL=$((t / 1024)) MEM_AVAIL=$((a / 1024))
  # A limit on this machine's own cgroup that /proc/meminfo doesn't reflect: cgroup v2, else v1. A "limit" bigger
  # than the RAM (v1 says unlimited with a huge number) is no limit.
  # Use counts page cache the kernel can drop, so the inactive part of it is taken off (the working set, as
  # Docker and Kubernetes count it).
  local stat="$CGROUP_DIR/memory.stat" key=inactive_file inact
  max="$(num_file "$CGROUP_DIR/memory.max")" cur="$(num_file "$CGROUP_DIR/memory.current")"
  if [[ -z $max ]]; then
    max="$(num_file "$CGROUP_DIR/memory/memory.limit_in_bytes")" cur="$(num_file "$CGROUP_DIR/memory/memory.usage_in_bytes")"
    stat="$CGROUP_DIR/memory/memory.stat" key=total_inactive_file
  fi
  inact="$(awk -v k="$key" '$1 == k { print $2; exit }' "$stat" 2>/dev/null)" || inact=""
  if [[ -n $cur && $inact =~ ^[0-9]{1,20}$ ]] && ((inact < cur)); then cur=$((cur - inact)); fi
  if [[ -n $max && -n $cur ]] && ((max / 1048576 < MEM_TOTAL)); then
    MEM_TOTAL=$((max / 1048576))
    if ((max > cur)); then c=$(((max - cur) / 1048576)); else c=0; fi
    ((c >= MEM_AVAIL)) || MEM_AVAIL=$c
  fi
  st="$(meminfo_kb SwapTotal)" sf="$(meminfo_kb SwapFree)"
  if [[ -n $st && -n $sf ]]; then SWAP_TOTAL=$((st / 1024)) SWAP_USED=$(((st > sf ? st - sf : 0) / 1024)); fi
}

to_mb() { # a Compose memory size (bytes, or a number with b, k, m or g): prints MB; nothing when it isn't one
  local v="${1,,}"
  v="${v//[\"\' ]/}"
  [[ $v =~ ^([0-9]{1,13})([bkmg]?)b?$ ]] || return 0
  local n=$((10#${BASH_REMATCH[1]}))
  case ${BASH_REMATCH[2]} in g) echo $((n * 1024)) ;; m) echo "$n" ;; k) echo $((n / 1024)) ;; *) echo $((n / 1048576)) ;; esac
}

live_server_mb() { # what the live server container uses now, in MB; nothing when Docker can't say
  local colour id u
  colour="$(live_colour 2>/dev/null)" || return 0
  id="$(cd "$REPO" && BOSSMAN_DEPLOYER="$D" timeout 20 docker compose ps -q "server-$colour" 2>/dev/null | head -n 1)" || return 0
  [[ $id =~ ^[0-9A-Za-z]{1,64}$ ]] || return 0
  u="$(timeout 20 docker stats --no-stream --format '{{.MemUsage}}' "$id" 2>/dev/null | head -n 1)" || return 0
  awk '{ v = $1; if (!match(v, /^[0-9]+(\.[0-9]+)?/)) exit; n = substr(v, 1, RLENGTH); u = substr(v, RLENGTH + 1)
         if (u ~ /^[Gg]/) n *= 1024; else if (u ~ /^[Kk]/) n /= 1024; else if (u !~ /^[Mm]/) n /= 1048576
         printf "%d\n", n }' <<<"$u"
}

need_memory() { # sets NEED_MB (free memory an update needs) and NEED_FROM (where the number came from); on blue/green also
  # NEW_SERVER_MB (the room a second, freshly started colour gets) and LIVE_SERVER_MB (what the live colour uses now).
  local build=$DEPLOY_BUILD_MEMORY_MB server=0 lim="" cap fresh=$DEPLOY_NEW_SERVER_MB
  NEED_MB="" NEED_FROM="" NEW_SERVER_MB="" LIVE_SERVER_MB=""
  if bluegreen_enabled; then
    # Reported, never used for the need: a leaking live server (17.5 GB on 7 Nov) would hold back the update that replaces it.
    LIVE_SERVER_MB="$(live_server_mb || true)"
    [[ $LIVE_SERVER_MB =~ ^[0-9]{1,9}$ ]] || LIVE_SERVER_MB=""
  fi
  if [[ -n $DEPLOY_MIN_FREE_MB ]]; then
    if [[ $DEPLOY_MIN_FREE_MB =~ ^[0-9]{1,7}$ ]]; then NEED_MB=$((10#$DEPLOY_MIN_FREE_MB)) NEED_FROM=setting; return 0; fi
    log "DEPLOY_MIN_FREE_MB is not a whole number of MB; working the need out instead."
  fi
  [[ $build =~ ^[0-9]{1,7}$ ]] || build=3072
  NEED_FROM=build
  if bluegreen_enabled; then # the new colour runs beside the live one until the window ends: room for a second server
    [[ $fresh =~ ^[0-9]{1,7}$ ]] || fresh=4096
    server=$((10#$fresh)) NEED_FROM=fresh
    lim="${BOSSMAN_SERVER_MEMORY:-$(grep -s '^BOSSMAN_SERVER_MEMORY=' "$REPO/.env" | tail -n 1 | cut -d= -f2- || true)}"
    cap="$(to_mb "$lim")"
    if [[ -n $cap ]] && ((cap > 0 && cap < server)); then server=$cap NEED_FROM=limit; fi # the cap is all it can ever take
    NEW_SERVER_MB=$server
  fi
  NEED_MB=$((10#$build + server + 1024))
}

# The floor: true when this request must stay in the inbox for now. Only a fixed string is looked for here; the
# request is checked properly once it is taken. A host that can't read its memory never holds. Only a server update
# is held: Boss Man waits for a quiet host, asks the owner after 30 minutes and can send "Update now" only for those.
# A runner update has none of that (it drains runs itself), so holding it here would leave it stuck with no card.
held_for_memory() { # request file
  local body
  [[ -f $1 && ! -L $1 && -n $MEM_AVAIL && -n $NEED_MB ]] || return 1
  ((MEM_AVAIL < NEED_MB)) || return 1
  body="$(head -c 4096 "$1" | LC_ALL=C tr -d ' \t\r\n')"
  [[ $body == *'"target":"server"'* ]] || return 1
  if [[ $body == *'"quiet":"override"'* ]]; then
    log "Only $MEM_AVAIL MB free and an update needs $NEED_MB MB, but the owner chose to update now: taking the request."
    return 1
  fi
  if ((DRY)); then log "[dry-run] would hold the request: $MEM_AVAIL MB free, an update needs $NEED_MB MB ($NEED_FROM)"; return 0; fi
  # Logged once per hold, not every minute.
  [[ -e $STATE/holding ]] || log "Holding the update request: $MEM_AVAIL MB free, an update needs $NEED_MB MB ($NEED_FROM). It is taken when memory frees up, or when the owner chooses Update now."
  : >"$STATE/holding"
  return 0
}

write_headroom() {
  local f="$OUTBOX/headroom.json" out="" c="" low="" step="" swap=""
  ((DRY)) && { log "[dry-run] would write $f"; return 0; }
  if [[ -n $MEM_TOTAL ]]; then out+=", \"totalMb\": $MEM_TOTAL, \"availableMb\": $MEM_AVAIL"; fi
  if [[ -n $SWAP_TOTAL ]]; then out+=", \"swapTotalMb\": $SWAP_TOTAL, \"swapUsedMb\": $SWAP_USED"; fi
  if [[ -n $NEED_MB ]]; then out+=", \"needMb\": $NEED_MB, \"needFrom\": $(jstr "$NEED_FROM")"; fi
  if [[ -n $NEW_SERVER_MB ]]; then out+=", \"newServerMb\": $NEW_SERVER_MB"; fi
  if [[ -n $LIVE_SERVER_MB ]]; then out+=", \"liveServerMb\": $LIVE_SERVER_MB"; fi
  if [[ -n $HOLDING ]]; then out+=", \"holding\": $(jstr "$HOLDING")"; fi
  if [[ -f $STATE/last-update ]]; then read -r c low step swap <"$STATE/last-update" || true; fi
  if [[ $c =~ ^[0-9a-f]{40}$ && $low =~ ^[0-9]{1,9}$ && $step =~ ^[a-z-]{1,32}$ && $swap =~ ^[0-9]{1,9}$ ]]; then
    out+=", \"lastUpdate\": {\"commit\": $(jstr "$c"), \"lowMb\": $low, \"lowAt\": $(jstr "$step"), \"swapPeakMb\": $swap}"
  fi
  printf '{"version": 1, "writtenAt": %s%s}\n' "$(jstr "$(now)")" "$out" >"$f.tmp"
  chmod 644 "$f.tmp"; mv "$f.tmp" "$f"
}

# During an update: keep the lowest free memory (and the step it was seen at) and the highest swap use.
mem_sample() { # step
  ((DRY)) && return 0
  local f="$STATE/mem-low" low="" step="" swap="" c=""
  read_memory
  [[ -n $MEM_AVAIL ]] || return 0
  if [[ -f $f ]]; then read -r low step swap c <"$f" || true; fi
  [[ $low =~ ^[0-9]{1,9}$ ]] || low=""
  [[ $swap =~ ^[0-9]{1,9}$ ]] || swap=0
  if [[ -z $low ]] || ((MEM_AVAIL < low)); then low=$MEM_AVAIL step=$1; fi
  if ((${SWAP_USED:-0} > swap)); then swap=$SWAP_USED; fi
  printf '%s %s %s %s\n' "$low" "$step" "$swap" "${c:-$COMMIT}" >"$f"
}
mem_start() { ((DRY)) || rm -f "$STATE/mem-low"; mem_sample "$1"; }
mem_report() { # once the update is over: one log line, kept for headroom.json's lastUpdate
  local f="$STATE/mem-low" low="" step="" swap="" c=""
  [[ -f $f ]] || return 0
  read -r low step swap c <"$f" || true
  rm -f "$f"
  [[ $low =~ ^[0-9]{1,9}$ && $step =~ ^[a-z-]{1,32}$ && $swap =~ ^[0-9]{1,9}$ && $c =~ ^[0-9a-f]{40}$ ]] || return 0
  log "Memory during the update to ${c:0:8}: lowest free $low MB (at $step), swap use peaked at $swap MB."
  printf '%s %s %s %s\n' "$c" "$low" "$step" "$swap" >"$STATE/last-update"
}

# BOS-419 (DR-008, DR-023, DR-024): more allowlisted host facts, as a JSON fragment that starts with ", " so it can be
# appended to host.json. Every section is optional and a section that fails is left out, so an older server (which
# ignores unknown fields) and a host with no docker both still get a record. Nothing here reads a key, token, auth
# file or the contents of .env: only the keys on the PORT_KEYS list below, and only values that look like an address
# or a port. Everything the deployer runs is fixed in this file; nothing comes from a request or from the server.
PORT_KEYS="BOSSMAN_BIND BOSSMAN_HOST_PORT BOSSMAN_PORTAL_BIND BOSSMAN_PORTAL_HOST_PORT PENPOT_BIND PENPOT_HOST_PORT NTFY_BIND NTFY_HOST_PORT"
REPO_PROBE_SECONDS="${REPO_PROBE_SECONDS:-3600}"
ADDON_SERVICES="tailscale:tailscale ntfy:ntfy penpot:penpot-frontend" # add-on name:Compose service label
have_docker() { command -v docker >/dev/null 2>&1; }
dk() { timeout 10 docker "$@" 2>/dev/null; }
env_value() { # key: the value of KEY in the checkout's .env (environment first); only called for keys on PORT_KEYS
  local v="${!1:-}"
  [[ -n $v ]] || v="$(grep -s "^$1=" "$REPO/.env" | tail -1 | cut -d= -f2- || true)"
  v="${v%\"}"; v="${v#\"}"
  printf '%s' "$v"
}
# The sha256 of one file as 64 hex characters, or empty when it can't be read (BOS-990).
file_sha256() {
  local s
  [[ -r $1 ]] && s="$(sha256sum "$1" 2>/dev/null | cut -d' ' -f1)" || s=""
  [[ $s =~ ^[0-9a-f]{64}$ ]] && printf '%s' "$s"
  return 0
}
host_extra_facts() {
  local out="" sep=", "
  # --- repo access: how origin is reached and whether a read works. The URL itself is never reported (it can carry a token).
  local url kind="none" ohost="" creds=false probe="skipped" probed=""
  url="$(g remote get-url origin 2>/dev/null)" || url=""
  case $url in
    https://*) kind=https ;;
    http://*) kind=http ;;
    ssh://* | *@*:*) kind=ssh ;;
    "") kind=none ;;
    *) kind=other ;;
  esac
  if [[ $kind != none && $kind != other ]]; then
    ohost="${url#*://}"; [[ $url == *://* ]] || ohost="$url"
    [[ $ohost == *@* && ${ohost%%@*} != *[/]* ]] && { [[ $kind == https || $kind == http ]] && creds=true; ohost="${ohost#*@}"; }
    ohost="${ohost%%[/:]*}"
    [[ $ohost =~ ^[A-Za-z0-9_.-]{1,255}$ ]] || ohost=""
  fi
  local why=""
  if [[ $kind != none ]]; then
    local cache="$STATE/repo-probe" now_s; now_s="$(date +%s)"
    if [[ -f $cache && $(stat -c %Y "$cache" 2>/dev/null || echo 0) -gt $((now_s - REPO_PROBE_SECONDS)) ]]; then
      # The cache is three fields: what the probe found, when, and (BOS-986) why it failed, base64 so a line with
      # spaces in it round-trips. An older cache with two fields leaves the reason empty.
      local b64=""
      read -r probe probed b64 <"$cache" || true
      [[ -n $b64 ]] && why="$(printf '%s' "$b64" | base64 -d 2>/dev/null || true)"
    else
      # A read over whatever origin uses: anonymous for https (no credential helper, no prompt), the host's own key for ssh
      # (BatchMode: never asks). Only ok/failed, when, and one redacted error line are kept (BOS-986).
      # BOS-986: ask for the ref a deploy actually needs (`refs/heads/main`), not `HEAD`. A read-only deploy key on
      # GitHub can refuse the `HEAD` symref while `refs/heads/main` reads fine, which made the probe say "failed" on a
      # host whose deploys all work. `HEAD` is kept as a fallback for a repo whose default branch is not main (the
      # deployer reads main itself, so a failed main read is only a probe failure when HEAD fails too).
      local errf="$STATE/repo-probe.err" rc=0 ok=0
      : >"$errf" 2>/dev/null || true
      # BOS-1584: the probe must reach origin exactly as a deploy's `g fetch` does. Git ranks GIT_SSH_COMMAND above the
      # checkout's `core.sshCommand` (where the docs put the deploy key, `-i key -o IdentitiesOnly=yes`), so setting
      # GIT_SSH_COMMAND to a bare `ssh` dropped the key and said "Permission denied (publickey)" on a host whose
      # deploys work. Start from the command a deploy would use (the environment's, else the checkout's setting, else
      # `ssh`) and only add the no-prompt options; ssh keeps the first value of an option, so the key stays.
      local sshbase="${GIT_SSH_COMMAND:-}"
      [[ -n $sshbase ]] || sshbase="$(g config --get core.sshCommand 2>/dev/null || true)"
      [[ -n $sshbase ]] || sshbase="ssh"
      local probe_ssh="$sshbase -o BatchMode=yes -o ConnectTimeout=10"
      if (GIT_SSH_COMMAND="$probe_ssh" timeout 20 git -C "$REPO" ls-remote origin refs/heads/main >/dev/null 2>"$errf"); then ok=1; else rc=$?; fi
      if ((!ok)) && (GIT_SSH_COMMAND="$probe_ssh" timeout 20 git -C "$REPO" ls-remote origin HEAD >/dev/null 2>"$errf"); then ok=1; else ((ok)) || rc=$?; fi
      if ((ok)); then probe=ok; else probe=failed; fi
      probed="$(now)"
      # One short line saying which part failed, secret-free: drop anything that looks like a URL or a credential,
      # cut every token to 80 characters, and keep 200 characters in all.
      if [[ $probe == failed ]]; then
        local -a lines=()
        if [[ -s $errf ]]; then mapfile -t lines <"$errf"; fi
        ((${#lines[@]})) || lines=("git ls-remote exited with status $rc")
        # "ssh: Could not resolve hostname <host>: Name or service not known": the host is replaced, so a VPN-only
        # name can't leak, and the message after it stays (it says what to do).
        # Only substitute the host when there is one: an empty $ohost (a local-path origin) would make the sed
        # expression an empty regex, which GNU sed refuses.
        local sedh=""; [[ -n $ohost ]] && sedh="s#$ohost#<code host>#g; "
        why="$(printf '%s\n' "${lines[@]}" | grep -v '^[[:space:]]*$' | grep -v '^Warning:' | head -n 1 | cut -c1-200 \
          | sed -E "${sedh}s#[A-Za-z][A-Za-z0-9+.-]*://[^[:space:]]+#<address>#g; s/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+/<user>@<host>/g; s/[A-Za-z0-9_-]{20,}/<key>/g" || true)"
        [[ -n $why ]] || why="git ls-remote exited with status $rc"
      fi
      rm -f "$errf" 2>/dev/null || true
      printf '%s %s %s\n' "$probe" "$probed" "$(printf '%s' "$why" | base64 -w0 2>/dev/null || printf '%s' "$why" | base64 | tr -d '\n')" >"$cache" 2>/dev/null || true
    fi
    [[ $probe =~ ^(ok|failed)$ ]] || probe=failed
    [[ $probe == ok ]] && why=""
  fi
  out+="$sep\"repo\": {\"origin\": $(jstr "$kind"), \"originHost\": $(jstr "$ohost"), \"embeddedCredentials\": $creds, \"probe\": $(jstr "$probe"), \"probedAt\": $(jstr "$probed"), \"probeWhy\": $(jstr "$why")}"
  # --- folders and the compose setup
  local srcdir deployerdir installdir cf cfl="" cfsep="" cflseen="" f bg=false colour=""
  srcdir="$(cd "$REPO" 2>/dev/null && pwd)" || srcdir=""
  deployerdir="$(cd "$D" 2>/dev/null && pwd)" || deployerdir=""
  installdir="$(cd "$D/.." 2>/dev/null && pwd)" || installdir=""
  cf="${COMPOSE_FILE:-}"; [[ -n $cf ]] || cf="$(grep -s '^COMPOSE_FILE=' "$REPO/.env" | tail -1 | cut -d= -f2- || true)"
  cf="${cf%\"}"; cf="${cf#\"}"
  for f in ${cf//[:,]/ }; do
    [[ $f =~ ^[A-Za-z0-9_./-]{1,200}$ ]] || continue
    # BOS-986: one entry per file, in the order the owner wrote them. A file named twice (or the same file under
    # two spellings, e.g. deploy/tailscale.yml and ./deploy/tailscale.yml) would mount it twice; Compose errors on
    # that, so the panel showed duplicates on Docker01.
    f="${f#./}"; f="${f//\/.\//\/}"
    [[ " $cflseen " == *" $f "* ]] && continue
    cflseen+=" $f"; cfl+="$cfsep$(jstr "$f")"; cfsep=", "
  done
  if bluegreen_enabled; then bg=true; colour="$(live_colour 2>/dev/null)" || colour=""; fi
  out+="$sep\"paths\": {\"install\": $(jstr "$installdir"), \"src\": $(jstr "$srcdir"), \"deployer\": $(jstr "$deployerdir")}"
  out+="$sep\"compose\": {\"files\": [$cfl], \"bluegreen\": $bg, \"liveColour\": $(jstr "$colour")}"
  # --- DR-052: the .env file the stack starts with, so an owner card can name it ({{host.env.file}}) instead of
  # saying ".env". This deployer runs every compose command from $REPO with no --env-file, so Compose reads the .env
  # there; that file is reported only when it exists. The server never works it out from the src folder itself.
  local envfile=""
  [[ -n $srcdir && -f $srcdir/.env ]] && envfile="$srcdir/.env"
  [[ $envfile =~ ^/[A-Za-z0-9_./-]{1,300}$ ]] && out+="$sep\"env\": {\"file\": $(jstr "$envfile")}"
  # --- BOS-990: the fingerprint (sha256) of the script this deployer is running from, and of the copy in the checkout
  # (the version that is live). The server compares them: different means the host's copy needs the owner's copy step.
  out+="$sep\"deployer\": {\"scriptSha\": $(jstr "$(file_sha256 "${BASH_SOURCE[0]:-$0}")"), \"repoSha\": $(jstr "$(file_sha256 "$REPO/scripts/host-deployer.sh")")}"
  # --- addresses and ports
  local addrs="" asep="" a n=0 ports="" psep="" k v
  while IFS= read -r a; do
    [[ $a =~ ^[0-9a-fA-F:.]{3,45}$ && $a != 127.* && $a != ::1 && $a != fe80:* ]] || continue
    ((n < 16)) || break; addrs+="$asep$(jstr "$a")"; asep=", "; n=$((n + 1))
  done < <(if command -v ip >/dev/null 2>&1; then ip -o addr show scope global 2>/dev/null | awk '{ sub("/.*", "", $4); print $4 }'; else hostname -I 2>/dev/null | tr ' ' '\n'; fi || true)
  for k in $PORT_KEYS; do
    v="$(env_value "$k")"; [[ $v =~ ^[A-Za-z0-9_.:-]{1,64}$ ]] || continue
    ports+="$psep$(jstr "$k"): $(jstr "$v")"; psep=", "
  done
  out+="$sep\"network\": {\"addresses\": [$addrs], \"ports\": {$ports}}"
  # --- the ntfy add-on's own address (NTFY_BASE_URL in .env): what the phone app must be pointed at. Only a plain https
  # address is reported (no login part, query or #), so nothing secret can ride along.
  local nbase
  nbase="$(env_value NTFY_BASE_URL)"; nbase="${nbase%/}"
  # The ntfy container's name (found by its Compose service label) is reported too, so the phone page can print a
  # `docker exec` command that fits this host. Only a plain container name is kept.
  local nparts="" ncont=""
  [[ $nbase =~ ^https://[A-Za-z0-9.-]{1,253}(:[0-9]{1,5})?(/[A-Za-z0-9._~/-]{0,100})?$ ]] && nparts="\"baseUrl\": $(jstr "$nbase")"
  if have_docker; then
    ncont="$(dk ps --filter "label=com.docker.compose.service=ntfy" --format '{{.Names}}' | head -n1)" || ncont=""
    [[ $ncont =~ ^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$ ]] || ncont=""
  fi
  [[ -n $ncont ]] && nparts+="${nparts:+, }\"container\": $(jstr "$ncont")"
  # Does the running ntfy container share a Docker network with a running Boss Man server container? The server
  # publishes to the name "ntfy", which only resolves on a shared network (under blue/green that needs
  # deploy/ntfy-bluegreen.yml). "running" alone does not prove the server can reach it. Reported only when both are
  # found; names of networks never leave this function.
  if [[ -n $ncont ]]; then
    local sids="" sid snets nnets reach=false n svcname
    # shellcheck disable=SC2016 # the braces are a Go template for docker, not shell expansion
    nnets="$(dk inspect -f '{{range $k, $v := .NetworkSettings.Networks}}{{$k}} {{end}}' "$ncont")" || nnets=""
    for svcname in server server-blue server-green; do # label filters are ANDed, so one call each
      sids+="$(dk ps --filter "label=com.docker.compose.service=$svcname" --format '{{.ID}}' || true) "
    done
    if [[ -n $nnets && -n $sids ]]; then
      for sid in $sids; do
        # shellcheck disable=SC2016 # Go template for docker
        snets="$(dk inspect -f '{{range $k, $v := .NetworkSettings.Networks}}{{$k}} {{end}}' "$sid")" || snets=""
        for n in $snets; do
          [[ " $nnets " == *" $n "* ]] && reach=true
        done
      done
      nparts+="${nparts:+, }\"serverReach\": $reach"
    fi
  fi
  # BOS-1589: after an ntfy restart a phone that does not reconnect gets no push. Two host facts make that visible:
  # when this ntfy container last started, and how many subscribers (open phone connections) it has right now.
  # Subscribers come from ntfy's own metrics, served on an in-container-only port (deploy/ntfy.yml), read with
  # `docker exec`; nothing is published. A count of 0 shortly after startedAt is a silent phone. Left out when unreadable.
  if [[ -n $ncont ]]; then
    local nstart nsubs
    # shellcheck disable=SC2016 # Go template for docker
    nstart="$(dk inspect -f '{{.State.StartedAt}}' "$ncont")" || nstart=""
    [[ $nstart =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:.]+Z$ ]] && nparts+="${nparts:+, }\"startedAt\": $(jstr "$nstart")"
    nsubs="$(dk exec "$ncont" wget -qO- http://localhost:9090/metrics </dev/null | sed -n 's/^ntfy_subscribers_total \([0-9][0-9]*\).*/\1/p' | head -n1)" || nsubs=""
    [[ $nsubs =~ ^[0-9]{1,9}$ ]] && nparts+="${nparts:+, }\"subscribers\": $nsubs"
  fi
  [[ -n $nparts ]] && out+="$sep\"ntfy\": {$nparts}"
  # --- BOS-1004: can this host seal a phone-login password? (openssl is what "Create phone login" needs)
  if command -v openssl >/dev/null 2>&1; then out+="$sep\"phoneLogin\": {\"openssl\": true}"; else out+="$sep\"phoneLogin\": {\"openssl\": false}"; fi
  # --- BOS-770: each BOSSMAN_NETGUARD_ALLOW line in .env, in file order, as its host:port entries only. Compose uses
  # only the last line, so two or more means an earlier list is silently ignored. Nothing else on the line is kept
  # (any token that isn't host:port is dropped), and no other key is read.
  local nlines="" nlsep="" nl tok toks tsep nc=0 envfound=false
  local -a ntoks
  [[ -r $REPO/.env ]] && envfound=true
  while IFS= read -r nl; do
    ((nc < 16)) || break
    nl="${nl#*=}"; nl="${nl%%[[:space:]]#*}"; nl="${nl//[\"\']/}"
    IFS=$', \t' read -r -a ntoks <<<"$nl" || true
    toks="" tsep=""
    for tok in "${ntoks[@]}"; do [[ $tok =~ ^[A-Za-z0-9.-]{1,253}:[0-9]{1,5}$ ]] && { toks+="$tsep$(jstr "$tok")"; tsep=", "; }; done
    nlines+="${nlsep}[$toks]"; nlsep=", "; nc=$((nc + 1))
  done < <(grep -sE '^[[:space:]]*(export[[:space:]]+)?BOSSMAN_NETGUARD_ALLOW[[:space:]]*=' "$REPO/.env" || true)
  out+="$sep\"netguardEnv\": {\"envFound\": $envfound, \"lines\": [$nlines]}"
  # --- memory, in kB, from /proc/meminfo
  local mt ma
  mt="$(awk '/^MemTotal:/ { print $2 }' /proc/meminfo 2>/dev/null)" || mt=""
  ma="$(awk '/^MemAvailable:/ { print $2 }' /proc/meminfo 2>/dev/null)" || ma=""
  if [[ $mt =~ ^[0-9]+$ && $ma =~ ^[0-9]+$ ]]; then out+="$sep\"memory\": {\"totalKb\": $mt, \"availableKb\": $ma}"; fi
  # --- add-ons (DR-023): found by their Compose service label; only not_set_up | stopped | needs_login | running
  local pair name svc state ids ts adds="" adsep=""
  for pair in $ADDON_SERVICES; do
    name="${pair%%:*}" svc="${pair#*:}" state=not_set_up
    if have_docker; then
      ids="$(dk ps -a --filter "label=com.docker.compose.service=$svc" --format '{{.ID}} {{.State}}')" || ids=""
      if [[ -n $ids ]]; then
        if grep -q ' running$' <<<"$ids"; then state=running; else state=stopped; fi
      fi
    fi
    if [[ $name == tailscale ]]; then
      ts=""
      if command -v tailscale >/dev/null 2>&1; then ts="$(timeout 10 tailscale status --json 2>/dev/null | jfield BackendState)" || ts=""
      elif [[ $state == running ]]; then
        ts="$(dk exec "$(head -n1 <<<"$ids" | cut -d' ' -f1)" tailscale status --json | jfield BackendState)" || ts=""
      fi
      case $ts in
        Running) state=running ;;
        NeedsLogin | NeedsMachineAuth) state=needs_login ;;
        Stopped | Starting) state=stopped ;;
      esac
    fi
    adds+="$adsep$(jstr "$name"): $(jstr "$state")"; adsep=", "
  done
  out+="$sep\"addons\": {$adds}"
  # --- read-only checks (DR-024), chosen by name from this fixed list
  # BOS-986: container_status counts only containers that are not running AND are meant to be. A one-shot setup or
  # init container that finished (exit 0, restart policy "no") is not a fault, and neither is the blue/green standby
  # (its window is over). Anything else stopped is named with its exit code and since when, so the panel can say
  # which. A running container that is failing its health check counts as unhealthy too.
  # Only fields `docker ps` really has are asked for here (`ExitCode` is not one of them, so it comes from inspect).
  local checks="" csep="" total=0 notrun=0 unhealthy=0 maxrestart=0 line r
  local stopping="" ssep2="" seen_ids=""
  if have_docker; then
    local cid cname cstate_str cstatus csince csvc
    local -A exit_code=()
    # Read the stack once. `docker ps` has no exit-code field (`ExitCode` is not one of the names it accepts, and
    # asking for it makes real Docker fail), so `docker inspect` is asked afterwards for the containers that aren't
    # up. The listing is kept in a temp file so the loop can read it and the ids can be inspected before it starts.
    local listing="$STATE/containers.tsv"
    dk ps -a --filter label=com.docker.compose.project --format '{{.ID}}\t{{.Names}}\t{{.State}}\t{{.Status}}\t{{.RunningFor}}\t{{.Label "com.docker.compose.project"}}\t{{.Label "com.docker.compose.service"}}' >"$listing" 2>/dev/null || : >"$listing"
    local ids_nonrunning=""
    while IFS=$'\t' read -r cid _ cstate_str _; do
      [[ -n $cid && $cstate_str != running ]] && ids_nonrunning+=" $cid"
    done <"$listing"
    if [[ -n ${ids_nonrunning// /} ]]; then
      local -a idsarr=() ecodes=()
      read -r -a idsarr <<<"${ids_nonrunning# }"
      mapfile -t ecodes < <(dk inspect -f '{{.State.ExitCode}}' "${idsarr[@]}" 2>/dev/null || true)
      local i
      for i in "${!idsarr[@]}"; do exit_code["${idsarr[i]}"]="${ecodes[i]:-}"; done
    fi
    # Is the live colour's server container running? (BOS-1584: the standby filter below needs it.)
    local live_up=false
    if [[ -n $colour ]]; then
      while IFS=$'\t' read -r _ _ cstate_str _ _ _ csvc; do
        [[ $csvc == "server-$colour" && $cstate_str == running ]] && live_up=true
      done <"$listing"
    fi
    while IFS=$'\t' read -r cid cname cstate_str cstatus csince _ csvc; do
      [[ -n $cstate_str ]] || continue
      # One entry per container name: a stack run twice on one host (BOS-986's duplicate compose-file entry on
      # Docker01) holds two containers with the same name. Replicas have their own index (bm-worker-1 and
      # bm-worker-2), so a stopped replica beside a running one is still counted and named.
      if [[ -n $cname ]]; then
        [[ " $seen_ids " == *" $cname "* ]] && continue
        seen_ids+=" $cname"
      fi
      total=$((total + 1))
      if [[ $cstate_str == running ]]; then
        # A container that is up but failing its health check ("Up 2 minutes (unhealthy)") is a problem too.
        [[ $cstatus == *unhealthy* ]] && unhealthy=$((unhealthy + 1))
        continue
      fi
      [[ $cstate_str == restarting ]] && unhealthy=$((unhealthy + 1))
      local cexit="${exit_code[$cid]:-}"
      # Meant to stop: a one-shot whose job is done. That means a migrate/netguard helper, or any service Compose
      # starts with `restart: "no"`, and only when it exited 0. A cleanly stopped server or database has a restart
      # policy of "unless-stopped", so it still counts.
      local one_shot=false
      if [[ $cname == *-migrate-* || $cname == *-netguard-* || $csvc == migrate || $csvc == netguard ]]; then one_shot=true; fi
      local rp
      rp="$(dk inspect -f '{{.HostConfig.RestartPolicy.Name}}' "$cid" 2>/dev/null || true)"
      [[ $rp == no ]] && one_shot=true
      [[ $one_shot == true && $cexit == 0 ]] && continue
      # The blue/green standby: a server colour that is stopped (exit 0) is the colour the proxy isn't sending traffic
      # to. The deployer leaves it running for SOAK_SECONDS after a swap; this report cannot tell a failed swap from a
      # finished window, so a stopped colour is never counted as "not running" (a colour that crashed exits non-zero
      # and is counted below).
      if [[ $cexit == 0 && $csvc =~ ^server-(blue|green)$ ]]; then continue; fi
      # BOS-1584: the standby after a swap is stopped with `docker stop`, which ends in exit 137 when the server does not
      # quit within the grace time. So when the live colour is known and its container is up, the other colour is meant
      # to be stopped whatever its exit code. A crashed live colour is never hidden: it is the one that is not up.
      if [[ -n $colour && $csvc =~ ^server-(blue|green)$ && $csvc != "server-$colour" && $live_up == true ]]; then continue; fi
      notrun=$((notrun + 1))
      # `exit` is a string, never bare: if instead of a number inspect returns nothing (the container was removed
      # between ps and inspect, or inspect was denied), a bare value would leave `"exit": ,` and break the whole
      # host.json. The server accepts a string and the flatten step skips an empty one.
      local cexit_s="${cexit//[^0-9-]/}"
      stopping+="$ssep2{\"name\": $(jstr "$cname"), \"status\": $(jstr "$cstate_str"), \"exit\": $(jstr "$cexit_s"), \"since\": $(jstr "$csince")}"; ssep2=", "
    done <"$listing"
    rm -f "$listing" 2>/dev/null || true
    checks+="$csep\"container_status\": {\"total\": $total, \"notRunning\": $notrun, \"unhealthy\": $unhealthy, \"stopped\": [$stopping]}"; csep=", "
    maxrestart=0
    while read -r r; do [[ $r =~ ^[0-9]+$ ]] && ((r > maxrestart)) && maxrestart=$r; done < <(dk ps -aq --filter label=com.docker.compose.project | xargs -r docker inspect -f '{{.RestartCount}}' 2>/dev/null || true)
    checks+="$csep\"restart_counts\": {\"max\": $maxrestart}"; csep=", "
  fi
  local sizes="" ssep="" sf sz
  for sf in "$OUTBOX/history.jsonl" "$LOG" "$STATE/hold"; do
    sz="$(stat -c %s "$sf" 2>/dev/null)" || continue
    sizes+="$ssep$(jstr "$(basename "$sf")"): $sz"; ssep=", "
  done
  checks+="$csep\"state_file_sizes\": {$sizes}"
  out+="$sep\"checks\": {$checks}"
  printf '%s' "$out"
}

# One function per action, so a later phase can change what "deploy the server" means in one place.
do_deploy_server() { (cd "$REPO" && BOSSMAN_DEPLOYER="$D" scripts/deploy.sh --yes --no-runner --commit "$COMMIT"); }
# A restart on a single server (BOS-647): --force rebuilds and recreates what is checked out; --commit pins it to the
# commit the request named, which main() has already checked is HEAD, so nothing new can come in.
do_restart_server() { (cd "$REPO" && BOSSMAN_DEPLOYER="$D" scripts/deploy.sh --yes --no-runner --force --commit "$COMMIT"); }
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
		health_timeout 5s
		health_fails 3
		lb_try_duration 15s
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
		health_timeout 5s
		health_fails 3
		lb_try_duration 15s
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
  ensure_daily_backup
}

# The daily backup service (BOS-2176). Swaps name the services they start and use --no-deps, so an install made before
# that service existed would never start it: every swap and rollback starts it here, right after its own backup. A no-op
# when it already runs; a failure (an older Compose file without the service, a Docker hiccup) never stops the swap.
ensure_daily_backup() {
  compose up -d --no-deps backup >>"$LOG" 2>&1 || log "Note: the daily backup service did not start (docker compose up -d backup); the swap goes on."
  return 0
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
    stop_colour "$BG_IDLE" || true
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
unplan_stopped() { { grep -vx "$1" "$STATE/stopped-by-plan" 2>/dev/null || true; } >"$STATE/stopped-by-plan.tmp"; mv "$STATE/stopped-by-plan.tmp" "$STATE/stopped-by-plan"; rm -f "$STATE/stop-took.$1"; } # colour
# A planned stop of a colour (BOS-794): an explicit grace longer than the server's SIGTERM shutdown, and the time it took is
# logged and kept (state/stop-took.<colour>), so a slow shutdown that still ended in SIGKILL (exit 137) stays visible.
stop_colour() { # colour
  local t0=$SECONDS
  if compose stop -t "$BG_STOP_SECONDS" "server-$1" >>"$LOG" 2>&1; then
    plan_stopped "$1"; printf '%s\n' "$((SECONDS - t0))" >"$STATE/stop-took.$1"
    log "Stopped server-$1 in $((SECONDS - t0))s (grace ${BG_STOP_SECONDS}s)."
    return 0
  fi
  log "Could not stop server-$1."; return 1
}

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
  local commit=$1 secs=$2 phase=$3 plan=$4 live other st line s why="" bad="" n leaders=0 rolelist="" id started restarts oom running code bid bst bn p bp took note=""
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
    oom=false
    if [[ $st != none ]]; then read -r _ _ _ oom running code <<<"$st"; fi
    if [[ $plan == standby ]]; then
      if [[ $running != true ]]; then hc_set other fail "server-$other should be running as a standby but is $([[ $running == absent ]] && echo missing || echo "stopped (exit code $code)")"
      elif [[ $(colour_role "$other") != standby ]]; then hc_set other fail "server-$other is running but not as a standby (role '$(colour_role "$other")')"
      else hc_set other pass "server-$other is running as a standby"; fi
    else
      if [[ $running == true ]]; then hc_set other fail "server-$other is running but the plan says it should be stopped"
      elif [[ $running == absent ]]; then hc_set other pass "server-$other has no container (nothing to run)"
      # The plan first (BOS-794): a planned stop that outlived its grace ends in SIGKILL (137) and is still a planned stop.
      # Both colours are restart: unless-stopped, so a crash or OOM kill alone would have been restarted, not left stopped.
      elif ! grep -qxs "$other" "$STATE/stopped-by-plan"; then
        if [[ $code != 0 ]]; then hc_set other fail "server-$other stopped with exit code $code, so it crashed or was killed"
        else hc_set other fail "server-$other is stopped but the deployer did not stop it"; fi
      elif [[ $oom == true ]]; then hc_set other fail "server-$other was killed for running out of memory (exit code $code)"
      else
        took="$(cat "$STATE/stop-took.$other" 2>/dev/null || true)"; [[ $took =~ ^[0-9]+$ ]] || took=""
        case $code in
          0) hc_set other pass "server-$other was stopped by plan (exit code 0)" ;;
          143) hc_set other pass "server-$other was stopped by plan (exit code 143, SIGTERM)" ;;
          137) hc_set other pass "server-$other was stopped by plan; it did not shut down in time and needed SIGKILL${took:+ after ${took}s} (exit code 137)" ;;
          *) hc_set other fail "server-$other was stopped by plan but exited with code $code" ;;
        esac
      fi
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
  stop_colour "$BG_IDLE" || true
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

  if ((RESTART)); then log "Blue/green restart: $BG_LIVE is live; building a fresh $BG_IDLE at the same commit (${COMMIT:0:8})."
  else log "Blue/green: $BG_LIVE is live; building $BG_IDLE at ${COMMIT:0:8}."; fi
  mem_start before-build
  backup_database || { bg_fail failed "The backup failed. Nothing was changed."; return 1; }
  g merge --ff-only --quiet "$COMMIT" || { bg_fail failed "Could not move the checkout to ${COMMIT:0:8}."; return 1; }
  local brc=0
  (cd "$REPO" && BOSSMAN_DEPLOYER="$D" BOSSMAN_COMMIT="$COMMIT" timeout -k 30 "$BG_BUILD_SECONDS" docker compose build "server-$BG_IDLE") >>"$LOG" 2>&1 || brc=$?
  if ((brc == 124 || brc == 137)); then pre_fail "Building $BG_IDLE did not finish within $((BG_BUILD_SECONDS / 60)) minutes, so it was stopped."; return 1; fi
  ((brc == 0)) || { pre_fail "Building $BG_IDLE failed."; return 1; }
  mem_sample after-build
  # Expand-only migrations: the live colour keeps working on the new schema.
  BOSSMAN_MIGRATE_TAG="$BG_IDLE" compose run --rm --no-deps migrate >>"$LOG" 2>&1 || { pre_fail "The migration failed (the database rolled it back)."; return 1; }
  compose up -d --no-deps --force-recreate "server-$BG_IDLE" >>"$LOG" 2>&1 || { pre_fail "Starting $BG_IDLE failed."; return 1; }
  baseline_set "server-$BG_IDLE" || true # recreated on purpose: its new container is the baseline
  # It is a standby because the live colour holds the leader lock; seeing that also shows the lock works.
  wait_ready "server-$BG_IDLE" standby "$COMMIT" "$BG_READY_SECONDS" || { pre_fail "$BG_IDLE did not come up as a standby at ${COMMIT:0:8} within ${BG_READY_SECONDS}s.$(colour_log_tail "$BG_IDLE")"; return 1; }
  # A login-free read straight from the idle colour (not through the proxy).
  [[ $(probe "server-$BG_IDLE" 3100 /api/setup 2>/dev/null | jfield needsSetup) == False ]] || { pre_fail "The smoke test on $BG_IDLE failed (GET /api/setup)."; return 1; }
  mem_sample standby-up

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
  mem_sample after-handover

  printf 'old=%s new=%s deadline=%s commit=%s prev=%s\n' "$BG_LIVE" "$BG_IDLE" "$(($(date +%s) + SOAK_SECONDS))" "$COMMIT" "$BG_PREV" >"$STATE/soak"
  BG_RESULT=deployed
  if ((RESTART)); then
    # The colour just rebuilt held the release before this one, so no stopped colour holds it any more: without the
    # record, --rollback refuses with its own clear message instead of "going back" to the code that runs now.
    # The hold (a release rejected by a rollback) stays: main has not moved, so it must still not be offered.
    rm -f "$STATE/previous"
    BG_MSG="Restarted at ${COMMIT:0:8}: a fresh $BG_IDLE is live; $BG_LIVE stays up as a standby for $((SOAK_SECONDS / 60)) minutes, and the deployer switches back by itself if the checks fail. The one-step rollback to the release before this one is no longer available."
    return 0
  fi
  # Kept after the soak ends: the only release a manual --rollback may go back to (colour, commit).
  printf '%s %s\n' "$BG_LIVE" "$BG_PREV" >"$STATE/previous"
  rm -f "$STATE/hold"
  BG_MSG="Deployed ${BG_PREV:0:8} to ${COMMIT:0:8}: $BG_IDLE is live; $BG_LIVE stays up as a standby for $((SOAK_SECONDS / 60)) minutes, and the deployer switches back by itself if the checks fail."
}

soak_end() { # old commit prev soakfile: time is up and the live colour is fine
  log "Soak over: stopping the old colour ($1)."
  stop_colour "$1" || true
  rm -f "$4"
  mem_report
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
  mem_sample window
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
    # If control comes back from soak_end its end check passed (stopping the old colour fixed it): nothing to page.
    if (($(date +%s) >= deadline)); then soak_end "$old" "$commit" "$prev" "$f"; return 0; fi
    health_degraded "$commit" "$prev"; return 0
  fi
  mem_report
  BG_LIVE="$old" BG_IDLE="$new" BG_PREV="$prev"
  # The record names the commit that failed (to_commit), as a swap-time rollback does, and the one we are back on (from_commit).
  REQ_ID="auto-rollback-$(date +%s)" TARGET=server STARTED="$(now)" FROM="$prev" COMMIT="$commit"
  rm -f "$f"
  # A restart's window (BOS-647) has the same commit on both sides: the old copy runs the same version.
  if [[ $commit == "$prev" ]]; then
    TARGET=restart
    if switch_back; then finish rolled_back "The fresh copy started by the restart was switched back: right after it went live, $VERIFY_WHY. Boss Man went back to the copy it ran before (same version, ${commit:0:8}) automatically and is running normally on it."
    else finish failed "The checks on the restarted $new failed and the automatic switch-back to $old ALSO failed: $(recovery_hint)"; fi
  fi
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
  stop_colour "$BG_LIVE" || true
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
  if [[ $TARGET == server || $TARGET == restart ]] && bluegreen_enabled; then
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

# ---- The staging lane (BOS-1472, docs/22-staging.md) ----
# Staging has its own request, status and history files, so it never shares a slot with production's. It runs under the
# same lock as everything else (one deployer run at a time), and only when no production request is waiting. It deploys
# commits that are on main, with the staging checkout's own scripts/deploy-staging.sh, then the smoke checks. Nothing from
# the request reaches a command line unchecked: the commit is 40 hex characters and must be an ancestor of origin/main.
S_ID="" S_COMMIT="" S_STARTED="" S_KV=()
write_staging_status() { # result message
  ((DRY)) && { log "[dry-run] staging status: $1: $2"; return 0; }
  local ended=""
  case $1 in running | held) ;; *) ended="$(now)" ;; esac
  json id="$S_ID" target=staging result="$1" message="$2" to_commit="$S_COMMIT" started="$S_STARTED" ended="$ended" at="${ended:-$S_STARTED}" ${S_KV[@]+"${S_KV[@]}"} >"$OUTBOX/staging-status.json.tmp"
  chmod 644 "$OUTBOX/staging-status.json.tmp"
  mv "$OUTBOX/staging-status.json.tmp" "$OUTBOX/staging-status.json"
  [[ -z $ended ]] || cat "$OUTBOX/staging-status.json" >>"$OUTBOX/staging-history.jsonl"
}
staging_done() { log "staging $1: $2"; write_staging_status "$1" "$2"; return 0; } # result message: record the outcome; the tick goes on
staging_lane_file() { # tells the server whether the lane is on, so it only offers a staging target when it can be used
  ((DRY)) && return 0
  local on=false origin=""; [[ -z $STAGING_DIR ]] || on=true
  # Which repository the staging checkout follows (credentials, if any, dropped). The server offers the staging target only to a
  # company whose project is this repository, so another company's fork can never ask this host to deploy (BOS-1472 review).
  if [[ $on == true ]]; then origin="$(staging_git remote get-url origin 2>/dev/null | sed -E 's#//[^@/]*@#//#' | head -n 1 || true)"; fi
  json configured="$on" origin="$origin" >"$OUTBOX/staging-lane.json.tmp"
  chmod 644 "$OUTBOX/staging-lane.json.tmp"; mv "$OUTBOX/staging-lane.json.tmp" "$OUTBOX/staging-lane.json"
}
staging_git() { (umask 022; git -c safe.directory="$STAGING_DIR" -C "$STAGING_DIR" "$@"); }
smoke_credentials_ok() { # the smoke account file: a plain file of ours, mode 600
  local f="$D/smoke-credentials"
  [[ -f $f && ! -L $f && $(stat -c %u "$f") == "$(id -u)" && $(stat -c %a "$f") =~ ^[0-7]00$ ]]
}
# A staging deploy that was cut off (host restart, killed deployer, out of memory) leaves staging-status.json at "running" for
# ever, and the server then refuses every later staging request. Same rule as recover_interrupted: we hold the lock here, so
# nothing is running; say so. Files only; no container is touched.
recover_staging_interrupted() {
  local sf="$OUTBOX/staging-status.json" st
  [[ -f $sf && ! -L $sf ]] || return 0
  st="$(cat "$sf")"
  [[ $(jfield result <<<"$st") == running ]] || return 0
  ((DRY)) && { log "[dry-run] the last staging run was cut off (status still 'running'); a real tick would mark it failed"; return 0; }
  S_ID="$(jfield id <<<"$st")" S_COMMIT="$(jfield to_commit <<<"$st")" S_STARTED="$(jfield started <<<"$st")" S_KV=(smoke=skipped)
  [[ -z $S_ID ]] && S_ID="interrupted-$(date +%s)"
  staging_done failed "The staging deploy of ${S_COMMIT:0:8} was cut off before it finished (the deployer was stopped part-way). Check what staging runs, then ask again; scripts/deploy-staging.sh --rollback in the staging folder puts the last good commit back."
}
staging_tick() {
  local sreq="$INBOX/staging-request.json"
  staging_lane_file
  [[ -e $sreq || -L $sreq ]] || return 0
  if [[ -z $STAGING_DIR ]]; then
    # Lane off: answer once so the requester isn't left waiting, and drop the file.
    S_ID="" S_COMMIT="" S_STARTED="$(now)"
    # Read the id only from a plain file (a symlink could point at a file the server can't read) and only if it looks like a UUID.
    if [[ -f $sreq && ! -L $sreq ]]; then S_ID="$(jfield id <"$sreq" 2>/dev/null || true)"; fi
    [[ $S_ID =~ ^[0-9a-fA-F-]{36}$ ]] || S_ID=""
    ((DRY)) || rm -f "$sreq"
    staging_done rejected "Rejected: staging is not configured on this host (STAGING_DIR in host.conf is empty)."; return 0
  fi
  [[ $STAGING_RATE_LIMIT_SECONDS =~ ^[0-9]{1,6}$ && $STAGING_TIMEOUT_SECONDS =~ ^[0-9]{1,6}$ ]] || { log "STAGING_RATE_LIMIT_SECONDS and STAGING_TIMEOUT_SECONDS must be whole numbers; the staging lane is skipped."; return 0; }
  # Staging must not starve production: held while an update would not have the memory it needs (BOS-420's numbers).
  if [[ -n ${MEM_AVAIL:-} && -n ${NEED_MB:-} ]] && ((MEM_AVAIL < NEED_MB)); then
    S_ID="" S_COMMIT="" S_STARTED="$(now)"; S_KV=()
    if [[ -f $sreq && ! -L $sreq ]]; then S_ID="$(jfield id <"$sreq" 2>/dev/null || true)"; fi
    [[ -z $S_ID || ! $S_ID =~ ^[0-9a-fA-F-]{36}$ ]] && S_ID=""
    write_staging_status held "Held: only $MEM_AVAIL MB of memory is free and an update needs $NEED_MB MB. The staging deploy runs when memory frees up."
    return 0
  fi
  local mine="$STATE/staging-request.$$.json"
  if ((DRY)); then cp -P "$sreq" "$mine"; else mv -T "$sreq" "$mine"; fi
  S_STARTED="$(now)" S_ID="" S_COMMIT="" S_KV=()
  local flat id commit target at by k
  if [[ ! -f $mine || -L $mine ]] || (($(stat -c %s "$mine") > 4096)) || [[ $(LC_ALL=C tr -d '\0' <"$mine" | wc -c) -ne $(stat -c %s "$mine") ]]; then
    rm -f "$mine"; staging_done rejected "Rejected: the request file is not a plain file under 4 KB."; return 0
  fi
  flat="$(LC_ALL=C tr -d ' \t\r\n' <"$mine")"; rm -f "$mine"
  local pair='"[A-Za-z]{1,32}":"[A-Za-z0-9_.:+-]{0,64}"'
  local ok=1
  [[ $flat =~ ^\{$pair(,$pair)*\}$ ]] || ok=0
  if ((ok)); then for k in id target commit requestedAt approvedBy; do
    [[ $(grep -oE "\"$k\":" <<<"${flat//,/$'\n'}" | wc -l) -eq 1 ]] || ok=0
  done; fi
  id="$(jfield id <<<"$flat")" target="$(jfield target <<<"$flat")" commit="$(jfield commit <<<"$flat")"
  at="$(jfield requestedAt <<<"$flat")" by="$(jfield approvedBy <<<"$flat")"
  [[ $id =~ ^[0-9a-fA-F-]{36}$ && $target == staging && $commit =~ ^[0-9a-f]{40}$ && $by =~ ^[A-Za-z0-9_.-]{1,64}$ && $at =~ ^[0-9T:.+Z-]{10,40}$ ]] || ok=0
  if ((!ok)); then staging_done rejected "Rejected: the staging request file does not match the expected format."; return 0; fi
  S_ID=$id S_COMMIT=$commit
  if [[ -s $OUTBOX/staging-history.jsonl ]] && grep -qE "\"id\":[[:space:]]*\"$id\"" "$OUTBOX/staging-history.jsonl"; then
    staging_done rejected "Rejected: this staging request was already handled."; return 0
  fi
  [[ -d $STAGING_DIR/.git || -f $STAGING_DIR/.git ]] || { staging_done failed "The staging folder (STAGING_DIR) is not a git checkout."; return 0; }
  [[ -x $STAGING_DIR/scripts/deploy-staging.sh ]] || { staging_done failed "The staging checkout has no scripts/deploy-staging.sh to run."; return 0; }
  # Only merged work: staging's launcher holds the host's Docker socket, so a commit nobody reviewed must not go there unasked.
  staging_git fetch --quiet origin main || { staging_done rejected "Rejected: git fetch from GitHub failed in the staging checkout."; return 0; }
  if ! staging_git cat-file -e "$commit^{commit}" 2>/dev/null || ! staging_git merge-base --is-ancestor "$commit" origin/main; then
    staging_done rejected "Rejected: ${commit:0:8} is not on main. Staging only takes merged commits, because its launcher holds the host's Docker socket."; return 0
  fi
  # A commit from before the lane existed has no smoke script: it can't be checked, so it isn't deployed.
  if ! staging_git cat-file -e "$commit:scripts/smoke-staging.sh" 2>/dev/null; then
    staging_done rejected "Rejected: ${commit:0:8} is older than the staging lane (it has no scripts/smoke-staging.sh), so it can't be checked. Ask for a newer commit on main."; return 0
  fi
  local last wait
  last="$(cat "$STATE/last-staging" 2>/dev/null || echo 0)"
  wait=$((last + STAGING_RATE_LIMIT_SECONDS - $(date +%s)))
  if ((wait > 0)); then staging_done rejected "Rejected: only one staging deploy every $((STAGING_RATE_LIMIT_SECONDS / 60)) minutes. Try again in $(((wait + 59) / 60)) minute(s)."; return 0; fi
  if ((DRY)); then log "[dry-run] staging checks passed: would run scripts/deploy-staging.sh ${commit:0:8} in the staging folder, then the smoke checks"; return 0; fi

  printf '%s\n' "$(date +%s)" >"$STATE/last-staging"
  write_staging_status running "Running: staging ${commit:0:8}"
  log "Running the staging deploy for ${commit:0:8} (request $id)."
  local before="" rc=0
  have_docker && before="$(docker ps -q --filter "label=com.docker.compose.project=${SMOKE_PRODUCTION_PROJECT:-boss-man}" 2>/dev/null | sort | paste -sd, - || true)"
  # BOSSMAN_PRODUCTION_DIRS: staging's isolation checks compare against production's folder, wherever it is.
  (cd "$STAGING_DIR" && BOSSMAN_PRODUCTION_DIRS="$REPO" timeout "$STAGING_TIMEOUT_SECONDS" scripts/deploy-staging.sh "$commit") >>"$LOG" 2>&1 || rc=$?
  if ((rc != 0)); then
    S_KV=(smoke=skipped)
    staging_done failed "The staging deploy of ${commit:0:8} stopped with an error (exit $rc). The deployer log on the host has the details. Staging was not rolled back: scripts/deploy-staging.sh --rollback in the staging folder does that."; return 0
  fi
  # The smoke checks, from the checkout just deployed (merged code, like the deploy script itself).
  local sm="$STAGING_DIR/scripts/smoke-staging.sh" out="" src=0 name res why img="" failed=""
  if [[ -x $sm ]]; then
    if smoke_credentials_ok; then export SMOKE_CREDENTIALS="$D/smoke-credentials"; else unset SMOKE_CREDENTIALS; fi
    out="$(SMOKE_PRODUCTION_BEFORE="$before" timeout 300 "$sm" "$STAGING_DIR" "$commit" 2>>"$LOG")" || src=$?
    while IFS=$'\t' read -r name res why; do
      [[ $name =~ ^[a-z_]{1,32}$ && $res =~ ^(pass|fail|skipped)$ ]] || continue
      S_KV+=("check_$name=$res" "why_$name=${why:0:200}")
      [[ $res != fail ]] || failed+="${failed:+, }$name"
      if [[ $name == runner && $why =~ image\ ([A-Za-z0-9._-]{1,64})$ ]]; then img="${BASH_REMATCH[1]}"; fi
    done <<<"$out"
    if [[ -n $failed ]]; then S_KV=(smoke=failed failed_checks="$failed" "${S_KV[@]}")
    elif ((src != 0)); then S_KV=(smoke=failed failed_checks=smoke-script "${S_KV[@]}")
    else S_KV=(smoke=passed "${S_KV[@]}"); fi
  else
    S_KV=(smoke=skipped)
  fi
  [[ -z $img ]] || S_KV+=(runner_image="$img")
  staging_done deployed "Staging runs ${commit:0:8}.${failed:+ Smoke checks failed: $failed.}"
}

# BOS-1004: "Create phone login". The server asks (inbox/phone-login.json) for the phone's read-only ntfy user; this
# makes it inside the ntfy container and hands the password back sealed (RSA-OAEP) to a public key that only the
# server's memory holds the private half of. The password is never written anywhere in the clear: not the inbox, the
# outbox, the history, the log or the webhook, and never on a command line (it reaches ntfy through the environment).
# The request is data only. Every field is checked against its own pattern, and the only commands that run inside the
# container are these fixed ones: ntfy user list | user add | user change-pass | access <user> <topic> read-only.
PHONE_USER='phone-read' # the only account this request may make or reset: the server is not trusted to pick another (an owner's admin login would be one reset away)
# BOS-1581: action "setup" makes (or finds) the one account Boss Man itself publishes with, write-only on the topic, and
# one access token for it. Same rules: the user is fixed here, and the token goes back sealed like the password does.
PUBLISH_USER='bossman-publish'
PHONE_SEAL_OPTS=(-pkeyopt rsa_padding_mode:oaep -pkeyopt rsa_oaep_md:sha256 -pkeyopt rsa_mgf1_md:sha256)
PL_USER=""
phone_result() { # id result message [sealed]: the answer the server polls for. Only the sealed (encrypted) password is ever in it.
  json id="$1" result="$2" message="$3" sealed="${4:-}" at="$(now)" >"$OUTBOX/phone-login.json.tmp"
  chmod 644 "$OUTBOX/phone-login.json.tmp"; mv "$OUTBOX/phone-login.json.tmp" "$OUTBOX/phone-login.json"
  printf '%s %s %s %s\n' "$(now)" "$1" "$2" "${PL_USER:--}" >>"$STATE/phone-login.log" # history: no secret
  log "Phone login $2 (request $1, user ${PL_USER:--})."
}
ntfy_exec() { # container-id args...: a fixed ntfy command in the container; a NTFY_PASSWORD set by the caller is passed on through the environment
  local cid=$1; shift
  timeout 30 docker exec -e NTFY_PASSWORD "$cid" ntfy "$@" </dev/null 2>&1
}
phone_setup_run() { # id user topic workdir cid: BOS-1581. Make or find the publish user, its write-only access and its token; seal the token.
  local id=$1 user=$2 topic=$3 td=$4 cid=$5 out pw tok made=0
  # Only fixed commands: ntfy user list | user add | access <user> <topic> write-only | token list <user> | token add <user>.
  # Running it again finds all three and adds nothing. The token is only ever in the sealed answer.
  if ! out="$(ntfy_exec "$cid" user list)"; then phone_result "$id" failed "Failed: ntfy could not list its users: $(head -n 1 <<<"$out" | cut -c1-160)"; return 0; fi
  if ! grep -qE "^user $user( |$)" <<<"$out"; then
    # The account needs a password to exist; nobody is ever shown it (Boss Man signs in with the token), so it is thrown away.
    pw="$(LC_ALL=C tr -dc 'A-Za-z0-9' </dev/urandom 2>/dev/null | head -c 24)" || true
    [[ ${#pw} -eq 24 ]] || { phone_result "$id" failed "Failed: could not make a password."; return 0; }
    out="$(NTFY_PASSWORD="$pw" ntfy_exec "$cid" user add --role=user "$user")" || { phone_result "$id" failed "Failed: ntfy could not add the user: $(head -n 1 <<<"${out//$pw/***}" | cut -c1-160)"; return 0; }
    made=1
  fi
  out="$(ntfy_exec "$cid" access "$user" "$topic" write-only)" || { phone_result "$id" failed "Failed: ntfy refused the write-only access on topic $topic: $(head -n 1 <<<"$out" | cut -c1-160). Press the button again to retry."; return 0; }
  out="$(ntfy_exec "$cid" token list "$user")" || { phone_result "$id" failed "Failed: ntfy could not list the tokens of $user: $(head -n 1 <<<"$out" | cut -c1-160)"; return 0; }
  tok="$(grep -oE 'tk_[a-z0-9]{29}' <<<"$out" | head -n 1 || true)"
  if [[ -z $tok ]]; then
    out="$(ntfy_exec "$cid" token add "$user")" || { phone_result "$id" failed "Failed: ntfy could not make a token for $user: $(head -n 1 <<<"$out" | cut -c1-160)"; return 0; }
    tok="$(grep -oE 'tk_[a-z0-9]{29}' <<<"$out" | head -n 1 || true)"
    made=1
  fi
  [[ $tok =~ ^tk_[a-z0-9]{29}$ ]] || { phone_result "$id" failed "Failed: ntfy answered in a form this deployer did not expect, so no token was read."; return 0; }
  local sealed
  sealed="$(printf '%s' "$tok" | openssl pkeyutl -encrypt -pubin -keyform DER -inkey "$td/pub.der" "${PHONE_SEAL_OPTS[@]}" 2>/dev/null | base64 -w0)" || sealed=""
  [[ $sealed =~ ^[A-Za-z0-9+/]{100,}={0,2}$ ]] || { phone_result "$id" failed "Failed: could not seal the token."; return 0; }
  if ((made)); then phone_result "$id" setup "Made the publish user $user with write-only access to topic $topic and a token." "$sealed"
  else phone_result "$id" setup "The publish user $user, its write-only access to topic $topic and its token were already there. Nothing was changed." "$sealed"; fi
}
phone_login_run() { # file: handle one request; never exits the deployer
  local f=$1 flat k id action user topic pubkey now_s last
  PL_USER=""
  [[ -f $f && ! -L $f && $(stat -c %s "$f") -le 2048 ]] || { log "Phone login request ignored: not a plain file under 2 KB."; return 0; }
  [[ $(LC_ALL=C tr -d '\0' <"$f" | wc -c) -eq $(stat -c %s "$f") ]] || { log "Phone login request ignored: unexpected format."; return 0; }
  flat="$(LC_ALL=C tr -d ' \t\r\n' <"$f")"
  local pair='"[A-Za-z]{1,32}":"[A-Za-z0-9+/=_.:-]{0,1024}"'
  [[ $flat =~ ^\{$pair(,$pair)*\}$ ]] || { log "Phone login request ignored: unexpected format."; return 0; }
  [[ $(tr ',' '\n' <<<"$flat" | wc -l) -eq 5 ]] || { log "Phone login request ignored: unexpected fields."; return 0; }
  for k in id action user topic pubkey; do
    [[ $(grep -oE "\"$k\":" <<<"${flat//,/$'\n'}" | wc -l) -eq 1 ]] || { log "Phone login request ignored: unexpected fields."; return 0; }
  done
  id="$(jfield id <<<"$flat")" action="$(jfield action <<<"$flat")" user="$(jfield user <<<"$flat")"
  topic="$(jfield topic <<<"$flat")" pubkey="$(jfield pubkey <<<"$flat")"
  [[ $id =~ ^[0-9a-fA-F-]{36}$ ]] || { log "Phone login request ignored: bad id."; return 0; }
  if grep -qs " $id " "$STATE/phone-login.log"; then log "Phone login request $id ignored: already handled."; return 0; fi
  PL_USER=$user
  [[ $action =~ ^(create|reset|setup)$ ]] || { PL_USER=-; phone_result "$id" rejected "Rejected: the action must be create, reset or setup."; return 0; }
  if [[ $action == setup ]]; then
    if [[ $user != "$PUBLISH_USER" ]]; then PL_USER=-; phone_result "$id" rejected "Rejected: the ntfy setup can only be made for the user $PUBLISH_USER."; return 0; fi
  elif [[ $user != "$PHONE_USER" ]]; then PL_USER=-; phone_result "$id" rejected "Rejected: a phone login can only be made for the user $PHONE_USER."; return 0; fi
  [[ $topic =~ ^[A-Za-z0-9_-]{1,64}$ ]] || { phone_result "$id" rejected "Rejected: the topic may only have letters, digits, - and _ (1 to 64)."; return 0; }
  [[ $pubkey =~ ^[A-Za-z0-9+/]{100,900}={0,2}$ ]] || { phone_result "$id" rejected "Rejected: the sealing key is not valid."; return 0; }
  now_s="$(date +%s)"; last="$(cat "$STATE/last-phone-login" 2>/dev/null || echo 0)"
  [[ $last =~ ^[0-9]+$ ]] || last=0
  if ((last + 30 > now_s)); then phone_result "$id" rejected "Rejected: one phone login every 30 seconds. Try again in a moment."; return 0; fi
  printf '%s\n' "$now_s" >"$STATE/last-phone-login"
  command -v openssl >/dev/null 2>&1 || { phone_result "$id" failed "Failed: openssl is not installed on the host, which is needed to seal the password."; return 0; }
  have_docker || { phone_result "$id" unavailable "The ntfy add-on is not installed here (this host has no Docker)."; return 0; }
  local td; td="$(umask 077; mktemp -d "$STATE/pl.XXXXXX")" || { phone_result "$id" failed "Failed: could not make a private work folder."; return 0; }
  # The public key must parse as a 2048-bit or larger RSA key before anything in ntfy is touched.
  local keytext bits
  printf '%s' "$pubkey" | base64 -d >"$td/pub.der" 2>/dev/null || true
  keytext="$(openssl pkey -pubin -inform DER -in "$td/pub.der" -noout -text 2>/dev/null)" || keytext=""
  bits="$(sed -n 's/^.*Public-Key: (\([0-9]*\) bit).*$/\1/p' <<<"$keytext" | head -n 1)"
  if ! grep -q '^Modulus' <<<"$keytext" || [[ ! $bits =~ ^[0-9]+$ ]] || ((bits < 2048)); then
    rm -rf "$td"; phone_result "$id" rejected "Rejected: the sealing key is not an RSA key of 2048 bits or more."; return 0
  fi
  local cids ncids cid
  cids="$(timeout 10 docker ps --filter "label=com.docker.compose.service=ntfy" --format '{{.ID}}' 2>/dev/null)" || cids=""
  ncids="$(grep -c . <<<"$cids" || true)"
  if [[ $ncids != 1 ]]; then
    rm -rf "$td"
    if [[ $ncids == 0 ]]; then phone_result "$id" unavailable "The ntfy add-on is not set up or not running on this host."
    else phone_result "$id" failed "Failed: more than one running container is labelled as ntfy, so it is not clear which to change."; fi
    return 0
  fi
  cid="$cids"
  [[ $cid =~ ^[0-9a-f]{12,64}$ ]] || { rm -rf "$td"; phone_result "$id" failed "Failed: docker named the ntfy container in a form that was not expected."; return 0; }
  if [[ $action == setup ]]; then phone_setup_run "$id" "$user" "$topic" "$td" "$cid"; rm -rf "$td"; return 0; fi
  # The password is made and sealed before anything changes, so a failure here leaves ntfy as it was.
  local pw sealed out exists=0
  pw="$(LC_ALL=C tr -dc 'A-Za-z0-9' </dev/urandom 2>/dev/null | head -c 24)" || true
  if [[ ${#pw} -ne 24 ]]; then rm -rf "$td"; phone_result "$id" failed "Failed: could not make a password."; return 0; fi
  sealed="$(printf '%s' "$pw" | openssl pkeyutl -encrypt -pubin -keyform DER -inkey "$td/pub.der" "${PHONE_SEAL_OPTS[@]}" 2>/dev/null | base64 -w0)" || sealed=""
  rm -rf "$td"
  [[ $sealed =~ ^[A-Za-z0-9+/]{100,}={0,2}$ ]] || { phone_result "$id" failed "Failed: could not seal the password."; return 0; }
  if ! out="$(ntfy_exec "$cid" user list)"; then phone_result "$id" failed "Failed: ntfy could not list its users: $(head -n 1 <<<"${out//$pw/***}" | cut -c1-160)"; return 0; fi
  grep -qE "^user $user( |$)" <<<"$out" && exists=1
  if [[ $action == create && $exists == 1 ]]; then phone_result "$id" exists "The user $user already exists. Reset its password to get a new one."; return 0; fi
  if [[ $action == reset && $exists == 0 ]]; then phone_result "$id" missing "The user $user does not exist yet. Create it first."; return 0; fi
  if [[ $action == create ]]; then
    out="$(NTFY_PASSWORD="$pw" ntfy_exec "$cid" user add --role=user "$user")" || { phone_result "$id" failed "Failed: ntfy could not add the user: $(head -n 1 <<<"${out//$pw/***}" | cut -c1-160)"; return 0; }
  else
    out="$(NTFY_PASSWORD="$pw" ntfy_exec "$cid" user change-pass "$user")" || { phone_result "$id" failed "Failed: ntfy could not change the password: $(head -n 1 <<<"${out//$pw/***}" | cut -c1-160)"; return 0; }
  fi
  # Always (re)applied: a repeat fixes drift. Read-only on this one topic, never more.
  out="$(ntfy_exec "$cid" access "$user" "$topic" read-only)" || { phone_result "$id" failed "Failed: the user $user was set up but ntfy refused its read-only access: $(head -n 1 <<<"$out" | cut -c1-160). Use Reset password to try again."; return 0; }
  if [[ $action == create ]]; then phone_result "$id" created "Created the read-only user $user for topic $topic." "$sealed"
  else phone_result "$id" reset "Changed the password of $user and re-applied read-only access to topic $topic." "$sealed"; fi
}
handle_phone_login() {
  local req="$INBOX/phone-login.json"
  [[ -e $req || -L $req ]] || return 0
  if ((DRY)); then log "[dry-run] a phone-login request is waiting; a real tick would handle it"; return 0; fi
  local mine="$STATE/phone-login.$$.json"
  mv -T "$req" "$mine" 2>/dev/null || return 0
  phone_login_run "$mine" || true
  rm -f "$mine"
}

main() {
  local req="$INBOX/request.json"
  # What this host says about itself (BOS-427), refreshed every tick, so an owner card's steps can be
  # checked against the real folders before they reach the owner.
  write_host_facts || true  # never let a stat failure stop a deploy
  # Free memory against what an update needs (BOS-420), and whether a waiting request is held for it. A failure
  # here never stops a deploy: with no numbers, nothing is held.
  if ((!ROLLBACK)); then
    { read_memory && need_memory; } || true
    if [[ -e $req || -L $req ]] && held_for_memory "$req"; then HOLDING="low memory"; else ((DRY)) || rm -f "$STATE/holding"; fi
    write_headroom || true
  fi
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
    local head sf="$OUTBOX/status.json" st=""
    head="$(g rev-parse HEAD)"
    if stack_check "$head" "$SOAK_CHECK_SECONDS" ack "$ap"; then
      # The ack must clear what it was asked to clear (BOS-794): the "partial" page health_degraded left in the status
      # file keeps the server saying "degraded" until another result replaces it. Only that page is replaced, and with
      # nothing_new, not deployed: deployed would start a new standby window and runner hold on the server for a swap that never ran.
      [[ -f $sf && ! -L $sf ]] && st="$(cat "$sf")"
      if [[ $(jfield result <<<"$st") == partial && $(jfield target <<<"$st") == server ]]; then
        REQ_ID="ack-$(date +%s)" TARGET=server STARTED="$(now)" FROM="$head" COMMIT="$head"
        finish nothing_new "Health accepted on the host: the whole-stack check passes at ${head:0:8}, so the earlier warning is cleared. Nothing was deployed or changed."
      fi
      log "Health accepted: baseline renewed; the checklist passes."; exit 0
    fi
    log "Baseline renewed, but the checklist still fails: $VERIFY_WHY"; exit 1
  fi
  handle_phone_login
  recover_interrupted
  recover_staging_interrupted
  if bluegreen_enabled; then soak_tick; fi
  if [[ ! -e $req && ! -L $req ]]; then staging_tick || log "The staging lane stopped with an error; production is unaffected."; refresh_available; exit 0; fi
  # The floor: left in the inbox, so the next minute looks again.
  [[ -z $HOLDING ]] || exit 0

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
  [[ $id =~ ^[0-9a-fA-F-]{36}$ && $target =~ ^(server|runner|restart)$ && $commit =~ ^[0-9a-f]{40}$ && $by =~ ^[A-Za-z0-9_.-]{1,64}$ && $at =~ ^[0-9T:.+Z-]{10,40}$ ]] ||
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
    # BOS-753: main moved on after the offer was written (a merge between the card and the press, or before this
    # tick). The approval still stands: it deploys the newest checked commit on main, never one off main.
    if [[ $COMMIT != "$tip" ]]; then
      local approved=$COMMIT
      g fetch --quiet origin main || finish rejected "Rejected: git fetch from GitHub failed."
      if ! g cat-file -e "$COMMIT^{commit}" 2>/dev/null || ! g merge-base --is-ancestor "$COMMIT" "$tip"; then
        # Main was rewritten under the offer: drop it, so the next minute writes one for the real tip.
        rm -f "$OUTBOX/available.json"
        finish rejected "Rejected: ${COMMIT:0:8} is not on main any more (main is at ${tip:0:8}), so it can't be deployed. A new update question for main follows within a few minutes."
      fi
      pick_newest_checked "$head" "$COMMIT" "$tip"
      REQ_KV=(requested_commit="$approved")
      # The offer no longer says what goes out: the next minute writes a fresh one.
      rm -f "$OUTBOX/available.json"
    fi
  elif [[ $TARGET == restart ]]; then
    # A restart only ever runs what is checked out: never a fetch, a merge or a move of the checkout (BOS-647).
    [[ $COMMIT == "$head" ]] || finish rejected "Rejected: nothing was restarted. The version running changed since you asked (it is ${head:0:8} now, the request named ${COMMIT:0:8}), so an update probably ran in between. If the server still needs it, press Restart the server again."
    # The old colour soaking as a standby is the automatic switch-back for the last update; a restart would rebuild it.
    if bluegreen_enabled && [[ -e $STATE/soak || -L $STATE/soak ]]; then
      finish rejected "Rejected: nothing was restarted. The last update is still in its $((SOAK_SECONDS / 60))-minute trial, and a restart now would replace the copy it switches back to. Try again when the trial is over."
    fi
  else
    # Runners are built from what is checked out, which is what the server deploy put there.
    # BOS-947: the server may have moved past the card's commit (a newer checked commit was deployed). When the card's
    # commit is part of what the server runs now, build from the running version: it has everything the card asked for.
    if [[ $COMMIT != "$head" ]]; then
      if g cat-file -e "$COMMIT^{commit}" 2>/dev/null && g merge-base --is-ancestor "$COMMIT" "$head"; then
        REQ_KV=(requested_commit="$COMMIT")
        ASKED_SHORT=${COMMIT:0:8}
        COMMIT=$head
      else
        finish rejected "The runners were not updated. They can only be rebuilt from the version the server runs, which is ${head:0:8}, and the card named ${COMMIT:0:8}, which is not part of it (the server was probably switched back, or its update is still running). Nothing is broken. Open Settings → Server and runner → Updates and press Build and update runners there: it builds from the version the server runs now."
      fi
    fi
  fi

  # A restart shares the server's limit, so it can't come right on top of an update (or another restart).
  local slot=$TARGET
  [[ $TARGET != restart ]] || slot=server
  last="$(cat "$STATE/last-$slot" 2>/dev/null || echo 0)"
  wait=$((last + RATE_LIMIT_SECONDS - $(date +%s)))
  if ((wait > 0)); then
    REFUSAL=1
    [[ $TARGET != restart ]] || finish rejected "Rejected: nothing was restarted. The server was updated or restarted less than $((RATE_LIMIT_SECONDS / 60)) minutes ago. Try again in $(((wait + 59) / 60)) minute(s)."
    finish rejected "Rejected: only one $TARGET deploy every $((RATE_LIMIT_SECONDS / 60)) minutes. Try again in $(((wait + 59) / 60)) minute(s)."
  fi

  if [[ $TARGET == server ]]; then
    [[ $head != "$COMMIT" ]] || finish nothing_new "Nothing new: ${head:0:8} is already deployed."
    g fetch --quiet origin main || finish rejected "Rejected: git fetch from GitHub failed."
    g cat-file -e "$COMMIT^{commit}" 2>/dev/null || finish rejected "Rejected: commit ${COMMIT:0:8} is not in the repository after fetching."
    g merge-base --is-ancestor "$head" "$COMMIT" || finish rejected "Rejected: ${COMMIT:0:8} is not a fast-forward of the deployed ${head:0:8}."
    local infra
    infra="$(g diff --name-only "$head" "$COMMIT" | grep -E "$INFRA" | { grep -Ev "$NOT_INFRA" || true; } | head -5 | paste -sd, - || true)"
    [[ -z $infra ]] || finish rejected "Rejected: this change touches deployment files ($infra). Deploy it by hand on the host: scripts/deploy.sh"
    # Whether the runners need rebuilding for what really goes out (BOS-753): the card only knew its own range.
    if ((${#REQ_KV[@]})); then
      local rp
      rp="$(g diff --name-only "$head" "$COMMIT" | grep -E "$RUNNER_PATHS" || true)"
      if [[ -n $rp ]]; then REQ_KV+=(runner_changed=true); else REQ_KV+=(runner_changed=false); fi
    fi
  fi

  if ((DRY)); then
    if [[ $TARGET != runner ]]; then problem="$(readable_problem "$REPO")"; [[ -z $problem ]] || log "[dry-run] the real run would stop: $problem"; fi
    log "[dry-run] checks passed: would run: $(if [[ $TARGET == runner ]]; then echo "scripts/update-runner.sh"; elif [[ $TARGET == restart ]] && bluegreen_enabled; then echo "a blue/green restart (fresh copy) at ${COMMIT:0:8}"; elif [[ $TARGET == restart ]]; then echo "scripts/deploy.sh --yes --no-runner --force --commit ${COMMIT:0:8}"; elif bluegreen_enabled; then echo "a blue/green swap to ${COMMIT:0:8}"; else echo "scripts/deploy.sh --yes --no-runner --commit ${COMMIT:0:8}"; fi)"
    exit 0
  fi

  printf '%s\n' "$(date +%s)" >"$STATE/last-$slot"
  if [[ -f $LOG && $(stat -c %s "$LOG") -gt 1000000 ]]; then tail -n 2000 "$LOG" >"$LOG.tmp" && mv "$LOG.tmp" "$LOG"; fi
  write_status running "Running: $TARGET ${COMMIT:0:8}"
  log "Running the $TARGET action for ${COMMIT:0:8} (request $REQ_ID)."
  local rc=0 result msg
  [[ $TARGET != restart ]] || RESTART=1
  if [[ $TARGET != runner ]] && bluegreen_enabled; then
    do_deploy_bluegreen >>"$LOG" 2>&1 || rc=$?
    # A good swap keeps measuring through the standby window (soak_tick); anything else ends here.
    # BOS-1588: a good swap also refreshes this deployer's own copy (it takes effect on the next run); a failure only warns.
    if [[ $BG_RESULT == deployed && -x $REPO/scripts/install-deployer.sh ]]; then BOSSMAN_DEPLOYER="$D" "$REPO/scripts/install-deployer.sh" >>"$LOG" 2>&1 || log "Warning: the deployer copy was not refreshed."; fi
    [[ $BG_RESULT == deployed ]] || { mem_report; BG_MSG="${BG_MSG:-The blue/green ${TARGET/server/swap} stopped with an error (exit $rc).} See $LOG on the host."; }
    finish "${BG_RESULT:-failed}" "$BG_MSG" "$BG_BACKUP"
  fi
  case $TARGET in
    server) mem_start before-build; do_deploy_server >>"$LOG" 2>&1 || rc=$?; mem_sample after-deploy; mem_report ;;
    restart) mem_start before-build; do_restart_server >>"$LOG" 2>&1 || rc=$?; mem_sample after-deploy; mem_report ;;
    *) do_update_runner >>"$LOG" 2>&1 || rc=$? ;;
  esac
  if [[ $TARGET != runner ]]; then
    result="$(deploy_status_field result)"; msg="$(deploy_status_field message)"
    [[ $(deploy_status_field to_commit) == "$COMMIT" ]] || { result=""; msg=""; }
  else
    result=""; msg=""
  fi
  if ((rc == 0)); then
    [[ $result == nothing_new ]] || result=deployed
    if [[ $TARGET == restart ]]; then msg="Restarted at ${COMMIT:0:8}: the server was rebuilt from what is checked out and is healthy again."
    elif [[ $TARGET == server ]]; then msg="Deployed ${head:0:8} to ${COMMIT:0:8}."; else msg="New runner image ready (commit ${COMMIT:0:8}${REQ_KV[0]:+, built from the version the server runs now; the card named ${ASKED_SHORT}, which that includes}); Boss Man is waiting for runs to finish, then swaps the runners and reports the result."; fi
  else
    case $result in partial | rolled_back) ;; *) result=failed ;; esac
    msg="${msg:-The $TARGET action stopped with an error (exit $rc).} See $LOG on the host."
  fi
  finish "$result" "$msg" "$(deploy_status_field backup)"
}

# BOS-986: a by-hand look at what this host says about itself, on the same terms as a tick, but with no request read,
# no deploy run and no lock held. It writes outbox/host.json exactly as a tick would, so a fix's effect can be checked
# straight away without waiting a minute for the next cron run.
if [[ ${FACTS:-0} == 1 ]]; then
  write_host_facts || { echo "ERROR: could not write $OUTBOX/host.json." >&2; exit 1; }
  echo "Wrote $OUTBOX/host.json"
  exit 0
fi

main
