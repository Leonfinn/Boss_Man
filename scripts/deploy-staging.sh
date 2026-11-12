#!/usr/bin/env bash
# One-step deploy of a chosen commit to the staging stack, and its rollback (BOS-69, docs/22-staging.md).
# Run it from the staging install folder (its own checkout of this repository, with its own .env and secrets/):
#
#   scripts/deploy-staging.sh <commit|branch|tag>   build and start exactly that commit
#   scripts/deploy-staging.sh --rollback            put the previous commit back (code only, never the database)
#   scripts/deploy-staging.sh --dry-run <ref>       show the steps without changing anything
#   scripts/deploy-staging.sh --check               only run the safety checks on .env and secrets
#
# Settings are read from the staging folder's .env:
#   COMPOSE_PROJECT_NAME   the stack's name (default boss-man-staging); must not be boss-man
#   BOSSMAN_HOST_PORT, BOSSMAN_PORTAL_HOST_PORT   host ports; must be set and not 3100/3101 (production's)
#   BOSSMAN_DATA           the staging data folder; must be set and not shared with another install
# Other environment: BOSSMAN_HEALTH_TIMEOUT (seconds, default 180), BOSSMAN_PRODUCTION_DIRS (extra install
# folders to compare against; by default every sibling folder of this one that has a docker-compose.yml and .env).
#
# It never touches production: it refuses to run if this folder shares the project name, a port, the database
# password, the data folder or the master key with another install it can see.
set -euo pipefail

HEALTH_TIMEOUT="${BOSSMAN_HEALTH_TIMEOUT:-180}"
say() { printf '%s\n' "$*"; }
die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
step() { say ""; say "== $* =="; }
DRY=0
run() { if ((DRY)); then say "[dry-run] $*"; else "$@"; fi; }

env_get() { # file key: the last KEY=value in a .env-style file; accepts "export KEY=v", quotes and a trailing " # comment"
  [[ -f $1 ]] || return 0
  local line v
  line="$({ grep -E "^[[:space:]]*(export[[:space:]]+)?$2[[:space:]]*=" "$1" || true; } | tail -n 1)"
  [[ -n $line ]] || return 0
  v="${line#*=}"; v="${v#"${v%%[![:space:]]*}"}"
  if [[ $v == \"* ]]; then v="${v#\"}"; v="${v%%\"*}"
  elif [[ $v == \'* ]]; then v="${v#\'}"; v="${v%%\'*}"
  else v="${v%%[[:space:]]#*}"; v="${v%"${v##*[![:space:]]}"}"; fi
  printf '%s\n' "$v"
}

# Refuses (nothing changed) when this folder could touch another install's data, secrets or ports.
guard_isolated() { # this folder
  local here="$1" proj port pport data pw o
  proj="$(env_get "$here/.env" COMPOSE_PROJECT_NAME)"; proj="${proj:-boss-man-staging}"
  [[ $proj != boss-man ]] || die "COMPOSE_PROJECT_NAME is boss-man, the production project. Use boss-man-staging (or another name) in $here/.env."
  [[ $proj =~ ^[a-z0-9][a-z0-9_-]*$ ]] || die "COMPOSE_PROJECT_NAME '$proj' is not a valid compose project name."
  [[ -f $here/.env ]] || die "No $here/.env. Follow the first-time setup in docs/22-staging.md."
  [[ -s $here/secrets/master.key ]] || die "No $here/secrets/master.key. Make a new one for staging (docs/22-staging.md); never copy production's."
  [[ -n $(env_get "$here/.env" POSTGRES_PASSWORD) ]] || die "POSTGRES_PASSWORD is not set in $here/.env."
  port="$(env_get "$here/.env" BOSSMAN_HOST_PORT)"; pport="$(env_get "$here/.env" BOSSMAN_PORTAL_HOST_PORT)"
  [[ -n $port && $port != 3100 ]] || die "Set BOSSMAN_HOST_PORT in $here/.env to a port production doesn't use (3200 is the usual one)."
  [[ -n $pport && $pport != 3101 ]] || die "Set BOSSMAN_PORTAL_HOST_PORT in $here/.env to a port production doesn't use (3201 is the usual one)."
  data="$(env_get "$here/.env" BOSSMAN_DATA)"
  [[ -n $data && $data == /* ]] || die "Set BOSSMAN_DATA in $here/.env to an absolute staging-only folder."
  [[ $data != /srv/boss-man/data ]] || die "BOSSMAN_DATA is the default (production) folder. Use a staging-only folder."
  # Every docker compose call in this folder (deploy.sh and update-runner.sh refuse here, but a hand-typed one would
  # not) must get the staging overlay, or it builds production's image tags and starts a launcher with no stack.
  [[ $(env_get "$here/.env" COMPOSE_FILE) == *deploy/staging.yml* ]] || die "Set COMPOSE_FILE=docker-compose.yml:deploy/staging.yml in $here/.env so every docker compose command here uses the staging overlay."
  pw="$(env_get "$here/.env" POSTGRES_PASSWORD)"
  local others=() d
  for d in "$here"/../*/ ${BOSSMAN_PRODUCTION_DIRS:-}; do
    o="$(cd "$d" 2>/dev/null && pwd)" || continue
    [[ $o != "$(cd "$here" && pwd)" && -f $o/docker-compose.yml && -f $o/.env ]] && others+=("$o")
  done
  for o in "${others[@]}"; do
    [[ -z $(env_get "$o/.env" POSTGRES_PASSWORD) || $(env_get "$o/.env" POSTGRES_PASSWORD) != "$pw" ]] || die "POSTGRES_PASSWORD is the same as in $o/.env. Staging needs its own."
    [[ $(env_get "$o/.env" BOSSMAN_DATA) != "$data" ]] || die "BOSSMAN_DATA is the same as in $o/.env. Staging needs its own folder."
    [[ $(env_get "$o/.env" COMPOSE_PROJECT_NAME || true) != "$proj" ]] || die "COMPOSE_PROJECT_NAME is the same as in $o/.env."
    [[ $(env_get "$o/.env" BOSSMAN_HOST_PORT) != "$port" ]] || die "BOSSMAN_HOST_PORT is the same as in $o/.env."
    if [[ -f $o/secrets/master.key ]] && cmp -s "$o/secrets/master.key" "$here/secrets/master.key"; then die "secrets/master.key is identical to the one in $o. Staging needs its own key."; fi
  done
  PROJECT="$proj"
  say "Isolation checks passed: project $PROJECT, ports $port/$pport, data $data, ${#others[@]} other install(s) compared."
  if ((${#others[@]} == 0)); then
    # Without a peer to compare against, a shared database password or copied master.key would go unnoticed.
    [[ ${BOSSMAN_ISOLATION_NO_PEERS:-} == 1 ]] || die "No other install was found to compare against, so a shared password, port, data folder or master.key can't be ruled out. Set BOSSMAN_PRODUCTION_DIRS=/path/to/production (space-separated for several), or BOSSMAN_ISOLATION_NO_PEERS=1 if this host really has no other Boss Man install."
    say "WARNING: BOSSMAN_ISOLATION_NO_PEERS=1: no other install compared."
  fi
}

PROJECT=boss-man-staging
dc() { COMPOSE_PROJECT_NAME="$PROJECT" docker compose -p "$PROJECT" -f docker-compose.yml -f deploy/staging.yml "$@"; }

wait_healthy() {
  if ((DRY)); then say "[dry-run] wait up to ${HEALTH_TIMEOUT}s for the staging server to report healthy"; return 0; fi
  local id st end=$((SECONDS + HEALTH_TIMEOUT))
  while ((SECONDS < end)); do
    id="$(dc ps -q server)"
    st="$([[ -n $id ]] && docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}nohealth{{end}}' "$id" || echo missing)"
    [[ $st == healthy ]] && return 0
    [[ $st == nohealth ]] && die "The server container has no healthcheck; cannot tell if it is up."
    sleep 3
  done
  return 1
}

# Builds and starts the stack at the checked-out commit.
rebuild_and_start() { # old-commit new-commit
  local svcs=(server) built=(server) profiles
  profiles="${COMPOSE_PROFILES:-$(env_get .env COMPOSE_PROFILES)}" # the same precedence docker compose uses
  if [[ ,$profiles, == *,launcher,* ]]; then svcs+=(launcher); built+=(launcher netguard); fi
  # A failed build must die, not fall through: callers run this inside "if !", where bash switches set -e off for
  # the whole function, so without the "|| die" a failed build went on to start a partial stack (BOS-1169).
  local built_fail="An image build failed (see above), so nothing was started; the running staging, if any, is unchanged. Fix the cause and run this again."
  step "Building (${built[*]})"
  run dc build "${built[@]}" || die "$built_fail"
  # The runner image the launcher starts: built when it is missing or the runner's code changed.
  if [[ ,$profiles, == *,launcher,* ]]; then
    if ((DRY)) || ! docker image inspect boss-man-staging-runner:current >/dev/null 2>&1 || { [[ -n ${1:-} ]] && git diff --name-only "$1" "$2" | grep -Eq '^(apps/runner/|apps/launcher/|apps/netguard/|packages/shared/|pnpm-lock\.yaml$)'; }; then
      step "Building the staging runner image"
      run dc --profile runners build runner-app-co || die "$built_fail"
      RUNNER_NEW=1
    fi
  fi
  step "Starting"
  run dc up -d "${svcs[@]}"
  step "Waiting for the server to be healthy (up to ${HEALTH_TIMEOUT}s)"
  wait_healthy || return 1
  # New runner image: have staging's own launcher (never production's) recreate the staging runners onto it.
  if ((${RUNNER_NEW:-0})) && [[ ,$profiles, == *,launcher,* ]]; then
    step "Moving the staging runners onto the new image"
    run dc exec -T launcher node dist/main.js recreate-all || say "Warning: could not recreate the staging runners; run: docker compose exec launcher node dist/main.js recreate-all"
  fi
}

finish_note() {
  local port bind
  port="$(env_get .env BOSSMAN_HOST_PORT)"; bind="$(env_get .env BOSSMAN_BIND)"
  say ""
  say "Staging is up at http://${bind:-127.0.0.1}:$port (bind address ${bind:-127.0.0.1}; BOSSMAN_BIND in .env controls who can reach it)."
  say "Now run the smoke checklist: docs/22-staging.md, 'Smoke checklist'."
}

main() {
  local ref="" rollback=0 check=0
  while (($#)); do case $1 in
    --dry-run) DRY=1 ;; --rollback) rollback=1 ;; --check) check=1 ;;
    -h|--help) sed -n '2,19p' "${BASH_SOURCE[0]}"; exit 0 ;;
    -*) die "Unknown option: $1" ;;
    *) [[ -z $ref ]] || die "Give one commit, branch or tag."; ref="$1" ;; esac; shift; done
  cd "$(dirname "${BASH_SOURCE[0]}")/.."
  guard_isolated "$PWD"
  ((check)) && exit 0
  command -v docker >/dev/null || die "docker is not installed or not on PATH."
  ((DRY)) && say "DRY RUN: nothing below is actually changed."
  local gitdir prev_file good_file cur
  gitdir="$(git rev-parse --git-dir)"
  # One deploy at a time: two runs would check out different commits under each other. The lock is released when
  # this process exits (even if it is killed), so it never goes stale.
  command -v flock >/dev/null || die "flock is not installed (util-linux); it is needed so two deploys can't run at once."
  exec 8>"$gitdir/staging-deploy.lock"
  flock -n 8 || die "Another deploy-staging.sh is already running in this folder. Wait for it to finish, then run this again."
  prev_file="$gitdir/staging-previous-commit"; good_file="$gitdir/staging-healthy-commit"
  [[ -z $(git status --porcelain --untracked-files=no) ]] || die "Uncommitted changes in the staging checkout; look at them first."
  cur="$(git rev-parse HEAD)"

  if ((rollback)); then
    # Back to the last commit that came up healthy; if that is what runs now, to the one before it.
    local to=""
    [[ -s $good_file ]] && to="$(cat "$good_file")"
    if [[ -z $to || $to == "$cur" ]]; then [[ -s $prev_file ]] && to="$(cat "$prev_file")"; fi
    [[ -n $to ]] || die "No earlier commit is recorded ($prev_file)."
    say "Rolling staging back from ${cur:0:8} to ${to:0:8}. The staging database is not touched."
    say "If the newer code changed the database schema, the older code may not start on it; then reset the staging data (docs/22-staging.md, Rollback)."
    run git checkout --quiet "$to"
    rebuild_and_start "$cur" "$to" || die "Still unhealthy after the rollback. Check: docker compose -p $PROJECT logs --tail 100 server"
    ((DRY)) || { printf '%s\n' "$cur" >"$prev_file"; printf '%s\n' "$to" >"$good_file"; }
    say "Rolled back. To go forward again: scripts/deploy-staging.sh ${cur:0:8}"
    finish_note; exit 0
  fi

  [[ -n $ref ]] || die "Say which commit, branch or tag to deploy: scripts/deploy-staging.sh <ref>   (or --rollback)"
  step "Fetching and resolving $ref"
  git fetch --quiet --tags origin || say "Warning: git fetch failed; using what this folder already has."
  local new
  # A branch name means the remote's branch: this checkout's own local branches are never advanced, so try origin/ first.
  new="$(git rev-parse --verify --quiet "origin/$ref^{commit}" || git rev-parse --verify --quiet "$ref^{commit}")" || die "Can't find '$ref' in this repository."
  say "Deploying $ref = ${new:0:8} (was ${cur:0:8})"
  if [[ $new != "$cur" ]]; then
    run git checkout --quiet "$new"
  else
    say "Already at that commit; rebuilding and starting it again (safe to repeat)."
  fi
  if ! rebuild_and_start "$cur" "$new"; then
    say ""; say "The staging server did not become healthy. Nothing was undone automatically."
    dc logs --no-color --tail 20 server 2>&1 | cut -c1-300 || true
    say "To go back to the last good code:   scripts/deploy-staging.sh --rollback"
    exit 1
  fi
  # Recorded only now that the new commit is healthy, so --rollback never lands on a commit that failed.
  if ((! DRY)); then
    if [[ $new != "$cur" ]]; then
      if [[ -s $good_file ]]; then cp "$good_file" "$prev_file"; else printf '%s\n' "$cur" >"$prev_file"; fi
    fi
    printf '%s\n' "$new" >"$good_file"
  fi
  finish_note
}

# Sourced by the tests: only run when executed.
if [[ ${BASH_SOURCE[0]} == "$0" ]]; then main "$@"; fi
