#!/usr/bin/env bash
# One-command deploy for the TrueNAS install: backup, pull, build, restart, health check.
# Run it as root from the repository, e.g.  scripts/deploy.sh   (see docs/06-install-truenas.md)
#
#   scripts/deploy.sh               deploy what is new on the default branch
#   scripts/deploy.sh --force       rebuild and restart even if nothing is new
#   scripts/deploy.sh --runner      also update the runners (default: only if their code changed)
#   scripts/deploy.sh --no-runner   never update the runners
#   scripts/deploy.sh --yes         do not ask before restarting the runners
#   scripts/deploy.sh --commit SHA  deploy exactly this commit (a fast-forward of what runs); used by host-deployer.sh
#   scripts/deploy.sh --dry-run     show the steps without changing anything
#   scripts/deploy.sh --rollback    put the previous commit back (code only, never the database)
#
# Settings (environment variables):
#   BOSSMAN_BACKUP_DIR      where backups go            (the install folder: the one holding this checkout)
#   BOSSMAN_BACKUP_KEEP     how many backups to keep    (14)
#   BOSSMAN_DEPLOY_STATUS   status file                 ($BOSSMAN_BACKUP_DIR/deploy-status.json)
#   BOSSMAN_HEALTH_TIMEOUT  seconds to wait for health  (120)
#
# Images: only the runner and launcher have fixed image names in docker-compose.yml; the server
# image has none, so rollback uses the recorded commit (and a rebuild), not an image tag.
set -euo pipefail

BACKUP_DIR="${BOSSMAN_BACKUP_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
KEEP="${BOSSMAN_BACKUP_KEEP:-14}"
STATUS_FILE="${BOSSMAN_DEPLOY_STATUS:-$BACKUP_DIR/deploy-status.json}"
PREV_FILE="${STATUS_FILE%.json}.previous-commit"
HEALTH_TIMEOUT="${BOSSMAN_HEALTH_TIMEOUT:-120}"

say() { printf '%s\n' "$*"; }
die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
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

# Every git command here runs under umask 022: run from a root shell with umask 077 it would write files the server (user node) can't read (BOS-562).
git() { (umask 022; command git "$@"); }
# Stops (nothing changed) when the checkout has files the server could not read; the message says the fix.
require_readable() {
  local problem
  problem="$(readable_problem .)"
  [[ -z $problem ]] || { MESSAGE="the checkout has files the server cannot read; see the output for the fix"; die "$problem"; }
}

# True when the files changed between two commits mean the runners need a new image.
needs_runner() { # old new
  git diff --name-only "$1" "$2" | grep -Eq '^(apps/runner/|apps/launcher/|apps/netguard/|packages/shared/|pnpm-lock\.yaml$)'
}

DRY=0 FORCE=0 RUNNER=auto YES=0 ROLLBACK=0 RECREATE=0 COMMIT=
RESULT=running FROM="" TO="" BACKUP="" STARTED="" MESSAGE=""

now() { date -u +%Y-%m-%dT%H:%M:%SZ; }
write_status() { # tmp + mv so a reader never sees half a file
  ((DRY)) && return 0
  local tmp="$STATUS_FILE.tmp" ended=""
  [[ $RESULT == running ]] || ended="$(now)"
  printf '{"started":"%s","ended":"%s","from_commit":"%s","to_commit":"%s","result":"%s","backup":"%s","message":"%s"}\n' \
    "$STARTED" "$ended" "$FROM" "$TO" "$RESULT" "$BACKUP" "${MESSAGE//\"/\'}" >"$tmp"
  mv "$tmp" "$STATUS_FILE"
}
on_exit() {
  if [[ $RESULT == running ]]; then RESULT=failed; MESSAGE="${MESSAGE:-stopped by an error, see the output above}"; write_status || true; fi
}

run() { if ((DRY)); then say "[dry-run] $*"; else "$@"; fi; }

step() { say ""; say "== $* =="; }

backup_db() {
  mkdir -p "$BACKUP_DIR"
  BACKUP="$BACKUP_DIR/bossman-$(date +%F-%H%M).sql.gz"
  if ((DRY)); then say "[dry-run] pg_dump | gzip > $BACKUP (then check it is not empty and gzip -t passes)"; return; fi
  (set -o pipefail; umask 077; docker compose exec -T db pg_dump -U bossman bossman | gzip >"$BACKUP.partial") || { rm -f "$BACKUP.partial"; die "The backup failed. Nothing was changed."; }
  if ! { [[ -s $BACKUP.partial ]] && gzip -t "$BACKUP.partial"; }; then rm -f "$BACKUP.partial"; die "The backup is empty or damaged. Nothing was changed."; fi
  mv "$BACKUP.partial" "$BACKUP"
  say "Backup saved: $BACKUP ($(du -h "$BACKUP" | cut -f1))"
  # Only files named bossman-*.sql.gz in the backup folder are ever deleted.
  local old
  old="$(find "$BACKUP_DIR" -maxdepth 1 -type f -name 'bossman-*.sql.gz' -printf '%T@ %p\n' | sort -rn | tail -n +$((KEEP + 1)) | cut -d' ' -f2-)"
  [[ -z $old ]] || { say "Removing backups older than the newest $KEEP:"; while IFS= read -r f; do say "  $f"; rm -f -- "$f"; done <<<"$old"; }
}

# The server image carries the container healthcheck from apps/server/Dockerfile (GET /api/health).
wait_healthy() {
  if ((DRY)); then say "[dry-run] wait up to ${HEALTH_TIMEOUT}s for the server container to report healthy"; return 0; fi
  local id st end=$((SECONDS + HEALTH_TIMEOUT))
  while ((SECONDS < end)); do
    id="$(docker compose ps -q server)"
    st="$([[ -n $id ]] && docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}nohealth{{end}}' "$id" || echo missing)"
    [[ $st == healthy ]] && return 0
    [[ $st == nohealth ]] && die "The server container has no healthcheck; cannot tell if it is up."
    sleep 3
  done
  return 1
}

rebuild_and_start() {
  local svcs=(server)
  # The launcher is only part of the stack when its profile is on.
  if ((DRY)) || docker compose config --services | grep -qx launcher; then svcs+=(launcher); fi
  require_readable
  step "Building (${svcs[*]})"
  run docker compose build "${svcs[@]}"
  step "Restarting"
  run docker compose up -d --no-deps "${svcs[@]}"
  # With --force and nothing new the image is unchanged, so `up -d` leaves the running server alone: recreate it, or
  # "restart" would do nothing (BOS-647). Only the server: the launcher is left as it is.
  if ((RECREATE)); then run docker compose up -d --no-deps --force-recreate server; fi
  step "Waiting for the server to be healthy (up to ${HEALTH_TIMEOUT}s)"
  wait_healthy
}

print_rollback_help() {
  say ""
  say "The server did not become healthy. Nothing was undone automatically."
  say "Last 20 lines of the server log:"; docker compose logs --no-color --tail 20 server 2>&1 | cut -c1-300 || true
  say "Look at the logs first:   docker compose logs --tail 100 server"
  say "To go back to the old code (does not touch the database):   scripts/deploy.sh --rollback"
  say "  or by hand:   git checkout $FROM && docker compose build && docker compose up -d"
  say "Only if the data itself is damaged, restore the backup (this loses everything written since):"
  say "  docker compose stop server"
  say "  docker compose exec -T db psql -U bossman -d postgres -c 'DROP DATABASE bossman' -c 'CREATE DATABASE bossman OWNER bossman'"
  say "  gunzip -c $BACKUP | docker compose exec -T db psql -U bossman bossman"
  say "  docker compose up -d"
}

do_rollback() {
  [[ -s $PREV_FILE ]] || die "No previous commit is recorded ($PREV_FILE)."
  TO="$(cat "$PREV_FILE")"; FROM="$(git rev-parse HEAD)"
  [[ -z $(git status --porcelain --untracked-files=no) ]] || die "Uncommitted changes in the working tree; stop and look at them first."
  say "Rolling back the code from ${FROM:0:8} to ${TO:0:8}. The database is not touched."
  run git checkout --quiet "$TO"
  rebuild_and_start || { RESULT=failed; MESSAGE="rollback built but server not healthy"; write_status; die "Still unhealthy after the rollback. Check: docker compose logs --tail 100 server"; }
  RESULT=rolled_back; write_status
  say "Rolled back. You are now on a detached commit; run 'git checkout <branch> && scripts/deploy.sh' to deploy again."
  say "If the runners were updated too, undo that with: scripts/update-runner.sh --rollback"
}

main() {
  while (($#)); do case $1 in
    --force) FORCE=1 ;; --runner) RUNNER=yes ;; --no-runner) RUNNER=no ;; --yes) YES=1 ;;
    --dry-run) DRY=1 ;; --rollback) ROLLBACK=1 ;; -h|--help) sed -n '2,14p' "${BASH_SOURCE[0]}"; exit 0 ;;
    --commit) shift; COMMIT="${1:-}"; [[ $COMMIT =~ ^[0-9a-f]{40}$ ]] || die "--commit needs a full 40-character commit hash." ;;
    *) die "Unknown option: $1" ;; esac; shift; done

  cd "$(dirname "${BASH_SOURCE[0]}")/.."
  # With blue/green the server is two colours behind a proxy; this script knows only the single server. Swaps are the host deployer's job.
  local cf="${COMPOSE_FILE:-$(grep -s '^COMPOSE_FILE=' .env | tail -1 | cut -d= -f2- || true)}"
  if [[ $cf == *truenas-bluegreen.yml* ]] && ((! DRY)); then
    die "This install uses blue/green (truenas-bluegreen.yml in COMPOSE_FILE): server swaps are done by the host deployer. For a change to deploy/ or docker-compose.yml, see docs/06-install-truenas.md, 9d. To go back to a single server, see the same section."
  fi
  STARTED="$(now)"; trap on_exit EXIT
  ((DRY)) && say "DRY RUN: nothing below is actually changed."
  ((ROLLBACK)) && { do_rollback; exit 0; }

  local branch default old new
  default="$(git symbolic-ref --short refs/remotes/origin/HEAD 2>/dev/null | sed 's#^origin/##' || true)"; default="${default:-main}"
  branch="$(git rev-parse --abbrev-ref HEAD)"
  [[ $branch == "$default" ]] || die "You are on '$branch', not '$default'. Run: git checkout $default"
  [[ -z $(git status --porcelain --untracked-files=no) ]] || die "There are uncommitted changes in the working tree; commit or discard them first."

  step "Checking for new commits"
  git fetch --quiet
  old="$(git rev-parse HEAD)"; new="${COMMIT:-$(git rev-parse '@{u}')}"; FROM="$old"; TO="$new"
  if [[ -n $COMMIT ]]; then
    git cat-file -e "$new^{commit}" 2>/dev/null || die "Commit ${new:0:8} is not in the repository after fetching."
    git merge-base --is-ancestor "$old" "$new" || die "Commit ${new:0:8} is not a fast-forward of ${old:0:8}."
  fi
  if [[ $old == "$new" ]]; then
    ((FORCE)) || { say "Nothing new to deploy (at ${old:0:8})."; RESULT=nothing_new; MESSAGE="nothing new"; write_status; exit 0; }
    say "Nothing new, but --force was given: rebuilding what is checked out (${old:0:8})."
    RECREATE=1
  else
    say "About to deploy these commits:"; git log --oneline "HEAD..$new"
  fi

  require_readable
  step "Backing up the database"
  backup_db
  write_status
  # A --force at the same commit (a restart, BOS-647) keeps the record: overwriting it with the commit that runs would
  # leave --rollback with nothing to go back to.
  if [[ $old != "$new" ]]; then
    ((DRY)) || printf '%s\n' "$old" >"$PREV_FILE"
    say "Current commit recorded for rollback: ${old:0:8}"
  fi

  step "Pulling the code"
  run git merge --ff-only --quiet "$new"
  rebuild_and_start || { RESULT=failed; MESSAGE="server not healthy after ${HEALTH_TIMEOUT}s"; write_status; print_rollback_help; exit 1; }
  say "The server is healthy."

  local do_runner=0
  case $RUNNER in
    yes) do_runner=1 ;;
    auto) if [[ $old != "$new" ]] && needs_runner "$old" "$new"; then do_runner=1; say "Runner code changed in this update."; fi ;;
  esac
  if ((do_runner)); then
    step "Updating the runners"
    say "This builds the new runner image, then asks Boss Man to drain: nothing new starts, runs in progress finish,"
    say "and each company's runner is swapped when it is idle. WITHOUT the launcher the runners restart at once and"
    say "agent runs in progress are cut off and restarted by crash recovery (repeated work, extra tokens)."
    if ((YES || DRY)); then :; else
      [[ -t 0 ]] || { RESULT=deployed; MESSAGE="runners not updated: no terminal to ask on; rerun with --runner --yes"; write_status; die "No terminal to ask on, so the runners were NOT updated (the server is deployed). Run: scripts/deploy.sh --runner --yes"; }
      read -r -p "Update the runners now? [y/N] " ans
      [[ $ans == [yY]* ]] || { say "Skipped. Update them later with: scripts/update-runner.sh"; do_runner=0; }
    fi
    if ((do_runner)); then
      run scripts/update-runner.sh || { RESULT=partial; MESSAGE="server deployed; runner update failed"; write_status; die "The server is deployed, but the runner update failed (the old runner image is still in use). See the output above."; }
    fi
  fi

  RESULT=deployed; write_status
  say ""; say "Done. Deployed ${old:0:8} -> ${new:0:8}. Backup: ${BACKUP:-none}"
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then main "$@"; fi
