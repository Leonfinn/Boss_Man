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
#   BOSSMAN_DEPLOYER   the deployer folder       (/mnt/NVME_Apps/Container_files/boss-man/deployer)
#   REPO               the git checkout          ($BOSSMAN_DEPLOYER/../src)
#   WEBHOOK_URL        POSTed on failure; empty = off
#   WEBHOOK_ON_SUCCESS 1 = also POST on success  (0)
#   RATE_LIMIT_SECONDS min gap between two runs of the same target (600)
#   AVAILABLE_REFRESH_SECONDS  how often to look for a new commit on main (300)
set -euo pipefail

DRY=0
case "${1:-}" in --dry-run) DRY=1 ;; "") ;; *) echo "Usage: $0 [--dry-run]" >&2; exit 2 ;; esac

export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin # cron's PATH is minimal
D="${BOSSMAN_DEPLOYER:-/mnt/NVME_Apps/Container_files/boss-man/deployer}"
REPO="$D/../src"
WEBHOOK_URL="" WEBHOOK_ON_SUCCESS=0 RATE_LIMIT_SECONDS=600 AVAILABLE_REFRESH_SECONDS=300
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
  local f="$OUTBOX/available.json"
  if [[ -e $f && -z $(find "$f" -mmin +$((AVAILABLE_REFRESH_SECONDS / 60)) 2>/dev/null) ]]; then return 0; fi
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

# Reads a field of scripts/deploy.sh's own status file.
deploy_status_field() { python3 -I -c 'import json,sys; print(json.load(open(sys.argv[1])).get(sys.argv[2], ""))' "${BOSSMAN_DEPLOY_STATUS:-${BOSSMAN_BACKUP_DIR:-/mnt/NVME_Apps/Container_files/boss-man}/deploy-status.json}" "$1" 2>/dev/null || true; }

main() {
  local req="$INBOX/request.json"
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
    [[ $COMMIT == "$tip" ]] || finish rejected "Rejected: ${COMMIT:0:8} is not the tip of main (${tip:0:8}). Approve the latest deploy instead."
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
    log "[dry-run] checks passed: would run: $([[ $TARGET == server ]] && echo "scripts/deploy.sh --yes --no-runner --commit ${COMMIT:0:8}" || echo "scripts/update-runner.sh")"
    exit 0
  fi

  printf '%s\n' "$(date +%s)" >"$STATE/last-$TARGET"
  if [[ -f $LOG && $(stat -c %s "$LOG") -gt 1000000 ]]; then tail -n 2000 "$LOG" >"$LOG.tmp" && mv "$LOG.tmp" "$LOG"; fi
  write_status running "Running: $TARGET ${COMMIT:0:8}"
  log "Running the $TARGET action for ${COMMIT:0:8} (request $REQ_ID)."
  local rc=0 result msg
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
