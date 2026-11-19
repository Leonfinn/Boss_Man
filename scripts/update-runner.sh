#!/usr/bin/env bash
# Rebuilds the runner image and promotes it only if the canary passes (R52), then has the runners
# move onto it WITHOUT cutting off agent runs: Boss Man drains (nothing new starts, runs finish) and
# the launcher swaps each company's runner as soon as that company is idle (docs/09-self-deploy.md).
#
#   scripts/update-runner.sh             build with the latest Claude Code, check, promote, ask for the drain
#   scripts/update-runner.sh 2.1.50      pin a Claude Code version instead of "latest"
#   scripts/update-runner.sh --rollback  tag the image that was running before as current, then drain onto it
#   scripts/update-runner.sh --settings  no new image: apply changed runner settings in .env (BOSSMAN_RUNNER_CPUS...; the check
#                                        slots and runner memory follow Settings, not .env). Recreates the launcher so it reads
#                                        them, then asks Boss Man to drain and recreate every runner as its company
#                                        goes idle, and to wake the agents afterwards (BOS-594). Use this, never a bare
#                                        "recreate-all", for a setting change.
#   scripts/update-runner.sh --now       emergencies: recreate every runner at once (runs in progress are
#                                        cut off, crash recovery restarts them). Works with the others.
#
# The drain is asked for by dropping inbox/drain.json into the deployer folder ($BOSSMAN_DEPLOYER: set by
# the host deployer, or read from .env). The script returns at once, so a host lock is not held while runs finish; Boss Man
# tells the owner when the swap is done. With no deployer folder, start it in Settings > Server and runner > Updates > Update runners (finish runs first).
# Without the launcher there is nothing to drain onto, so the runners are restarted at once, as with --now.
#
# The canary runs a real Claude Code session inside the new image against a stand-in model
# served from the same container, with networking off, so it needs no credentials. The
# image that was running is kept as boss-man-runner:previous until the next update. The network
# guard's image is kept the same way (boss-man-netguard:previous); --rollback restores both, and a drain's
# swap that keeps failing puts that company's runner back on boss-man-runner:previous by itself.
# Run it from the repository root, where docker-compose.yml is.
set -euo pipefail

# BOS-562: not affected by unreadable checkout files: the runner image copies with COPY --chown=node and the netguard image runs as root.
IMAGE=boss-man-runner
# BOS-69: this script tags boss-man-runner/netguard/launcher:current and talks to the project "boss-man", which are
# production's. In a staging folder (another project name or a stack) it would put staging code under production's
# image names, so it refuses; scripts/deploy-staging.sh builds the staging images and starts the staging launcher.
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
# A staging folder is also recognised by its compose overlay (COMPOSE_FILE with deploy/staging.yml), so one with no
# project name or stack in .env still refuses.
proj="${COMPOSE_PROJECT_NAME:-$(env_get .env COMPOSE_PROJECT_NAME)}"
stack="${BOSSMAN_STACK:-$(env_get .env BOSSMAN_STACK)}"
cfs="${COMPOSE_FILE:-$(env_get .env COMPOSE_FILE)}"
if [[ -n $stack || ( -n $proj && $proj != boss-man ) || $cfs == *deploy/staging.yml* ]]; then
  echo "This folder is not the production install (project '${proj:-boss-man}', stack '${stack:-none}'). update-runner.sh only handles production's images, so it refuses here." >&2
  echo "For a staging stack use scripts/deploy-staging.sh, which builds the staging runner image." >&2
  exit 1
fi
# Compose runners follow COMPOSE_PROFILES (from .env); with none set, the "runners" profile as
# before. Runners the launcher made (R55) are recreated by the launcher itself.
profiles="${COMPOSE_PROFILES:-$(grep -s '^COMPOSE_PROFILES=' .env | tail -1 | cut -d= -f2- || true)}"
# The deployer folder (docs/09-self-deploy.md) is where the drain request goes; .env has it once self-deploy is set up.
BOSSMAN_DEPLOYER="${BOSSMAN_DEPLOYER:-$(grep -s '^BOSSMAN_DEPLOYER=' .env | tail -1 | cut -d= -f2- || true)}"
# Optional runner add-ons (docs/12), e.g. RUNNER_ADDONS=agent-browser,webkit in .env; empty builds the plain image.
addons="${RUNNER_ADDONS:-$(grep -s '^RUNNER_ADDONS=' .env | tail -1 | cut -d= -f2- || true)}"
# BOS-1583: the owner's tick boxes (Settings > Runner > Add-ons) are saved by the server as inbox/runner-addons in the deployer
# folder, one line of comma-separated ids. Once saved, it wins over .env (the boxes started ticked from what was built, so
# nothing is lost); until then .env keeps working as before. The server can write inbox, so the file is only trusted when it is
# a plain file (never a symlink) holding nothing but ids, and anything else is ignored with a warning.
addons_file=""
[[ -z $BOSSMAN_DEPLOYER ]] || addons_file="$BOSSMAN_DEPLOYER/inbox/runner-addons"
if [[ -n $addons_file && -f $addons_file && ! -L $addons_file ]]; then
  saved_addons="$(head -c 400 "$addons_file" | tr -d '\r\n ')"
  if [[ $saved_addons =~ ^([a-z0-9-]+(,[a-z0-9-]+)*)?$ ]]; then
    addons="$saved_addons"
  else
    echo "WARNING: $addons_file is not a plain list of add-on ids; ignoring it and using RUNNER_ADDONS from .env." >&2
  fi
fi
if [[ -n $addons && ! $addons =~ ^[a-z0-9-]+(,[a-z0-9-]+)*$ ]]; then echo "RUNNER_ADDONS must be comma-separated add-on ids (letters, digits, dashes), got: $addons" >&2; exit 1; fi
compose() { COMPOSE_PROFILES="${profiles:-runners}" docker compose "$@"; }
launcher_id() { docker ps -q --filter label=com.docker.compose.project=boss-man --filter label=com.docker.compose.service=launcher; }

# Rebuilds and recreates the launcher when it is running, without touching the runners (BOS-335). "Build and update
# runners" is the button the owner uses, and it used to build only the runner and netguard images: a launcher fix,
# like the faster network-guard check, then never went live and nothing showed that. Recreating the launcher restarts
# only it; its runners keep running and a company's runner is not touched.
rebuild_launcher() {
  [[ -n "$(launcher_id)" ]] || return 0
  echo "Rebuilding the launcher, the part that starts the company runners..."
  local lp="${profiles:-runners}"
  case ",$lp," in *,launcher,*) ;; *) lp="$lp,launcher" ;; esac
  COMPOSE_PROFILES="$lp" docker compose build launcher
  COMPOSE_PROFILES="$lp" docker compose up -d --no-deps launcher
}

restart_runners() { # everything at once: the old behaviour
  compose up -d --no-build
  local launcher
  launcher="$(launcher_id)"
  if [[ -n "$launcher" ]]; then docker exec "$launcher" node dist/main.js recreate-all; fi
}

# Asks the server to start the drain. The file's existence is the request (written, then renamed); an optional
# reason "setting change" makes the drain recreate every runner, not only those on an old image.
request_drain() {
  local d="${BOSSMAN_DEPLOYER:-}" reason="${1:-}"
  if [[ -n $d && -d $d/inbox ]]; then
    # Written in the root-only state folder, then renamed in: the server can write to inbox, so writing
    # there directly would follow a symlink it planted. A rename replaces whatever is at the name instead.
    mkdir -p "$d/state" && chmod 700 "$d/state"
    local tmp
    tmp="$(mktemp "$d/state/drain.XXXXXX")"
    printf '{"requestedAt":"%s","by":"update-runner.sh"%s}\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "${reason:+,\"reason\":\"$reason\"}" >"$tmp"
    chmod 644 "$tmp"; chown 1000:1000 "$tmp" 2>/dev/null || true
    mv -fT "$tmp" "$d/inbox/drain.json"
    echo "Asked Boss Man to drain: nothing new starts, runs finish, each runner is swapped when its company is idle."
    echo "Boss Man notifies you when it is done. To stop it: Settings > Server and runner > Updates > Cancel the runner update."
  else
    echo "The new image is tagged, and the runners still run the old one. Start the drain in Boss Man:"
    echo "Settings > Server and runner > Updates > Update runners (finish runs first). With the host deployer set up, the button is under \"For a hand-built runner image\". (Or rerun with --now to cut runs off and restart at once.)"
  fi
}

move_runners() {
  if ((NOW)); then restart_runners; echo "Runners recreated now."; return; fi
  if [[ -z "$(launcher_id)" ]]; then
    echo "WARNING: no launcher is running, so there is nothing to drain onto: restarting the runners at once." >&2
    restart_runners
    return
  fi
  request_drain
}

NOW=0 ROLLBACK=0 SETTINGS=0 version=
for a in "$@"; do
  case $a in
    --now) NOW=1 ;;
    --rollback) ROLLBACK=1 ;;
    --settings) SETTINGS=1 ;;
    -*) echo "Usage: $0 [--now] [--settings | --rollback]" >&2; exit 2 ;;
    *) version="$a" ;;
  esac
done
# Claude Code's version is pinned in apps/runner/claude-pack/package.json now, not a build arg (DR-050, BOS-972).
if [[ -n $version ]]; then echo "The runner image no longer takes a Claude Code version: it is pinned in apps/runner/claude-pack/package.json (DR-050)." >&2; exit 2; fi

if ((SETTINGS)); then
  if ((NOW)); then
    # Emergencies only: the launcher re-reads .env, then every runner is recreated at once (runs are cut off).
    compose up -d --no-deps launcher
    restart_runners
    echo "Runners recreated now with the new settings."
    exit 0
  fi
  if [[ -z "$(launcher_id)" ]]; then
    echo "No launcher is running, so the runners can't be drained: they are compose services. Rerun with --settings --now to recreate them at once (this cuts off runs in progress)." >&2
    exit 1
  fi
  if [[ -z ${BOSSMAN_DEPLOYER:-} || ! -d $BOSSMAN_DEPLOYER/inbox ]]; then
    echo "No deployer folder (BOSSMAN_DEPLOYER in .env), so Boss Man can't be asked to drain. Nothing was changed." >&2
    echo "Set up self-deploy, or rerun with --settings --now to recreate the runners at once (this cuts off runs in progress)." >&2
    exit 1
  fi
  # The launcher reads the runner settings from its environment at start; runners keep running meanwhile.
  compose up -d --no-deps launcher
  request_drain "setting change"
  echo "The runners get the new settings as each company goes idle; agents are woken again afterwards."
  exit 0
fi

if ((ROLLBACK)); then
  docker image inspect "$IMAGE:previous" >/dev/null 2>&1 || { echo "No previous image to roll back to." >&2; exit 1; }
  docker tag "$IMAGE:previous" "$IMAGE:current"
  # The network guard goes back with it, when the last update kept the one before (BOS-382).
  if docker image inspect boss-man-netguard:previous >/dev/null 2>&1; then docker tag boss-man-netguard:previous boss-man-netguard:current; fi
  # A runner is not started without its network guard (BOS-324); build it if this host has lost it.
  docker image inspect boss-man-netguard:current >/dev/null 2>&1 || docker build -f apps/netguard/Dockerfile -t boss-man-netguard:current .
  move_runners
  echo "The previous runner image is now current."
  exit 0
fi

# BOS-1913: how long each step took, one "Timing:" line each, so a slow update shows which step it was (build, canary or
# launcher) in the deployer log instead of one unexplained gap.
LAP_START=$SECONDS
lap() { echo "Timing: $1 took $((SECONDS - LAP_START))s"; LAP_START=$SECONDS; }

stamp="$(date -u +%Y%m%d%H%M)"
# The commit the image is built from (BOS-764): Boss Man skips a "Build and update runners" ask when the image already has the change.
# Empty outside a git checkout, and then the runner reports none and the ask is made as before.
commit="$(git rev-parse HEAD 2>/dev/null || true)"
# The network guard the launcher starts beside every runner (BOS-324); a runner is not started without it.
# The one before is kept as boss-man-netguard:previous, so --rollback undoes the whole update (BOS-382).
# Remember the id now; it is tagged :previous only after the canary passes, together with the runner's own :previous.
NETGUARD_PREV="$(docker image inspect --format '{{.Id}}' boss-man-netguard:current 2>/dev/null || true)"
# Hold the old guard under a name of its own while the new one is built: rebuilding :current untags it, and on a host whose image
# store drops untagged images the bare id is gone by the time the canary has passed (BOS-1417: "No such image", exit 1).
if [[ -n "$NETGUARD_PREV" ]]; then docker tag "$NETGUARD_PREV" boss-man-netguard:pending-previous || NETGUARD_PREV=; fi
docker build -f apps/netguard/Dockerfile -t boss-man-netguard:current .
lap "network guard build"

echo "Building $IMAGE:candidate (no Anthropic code; Claude Code comes from the pack on first start)${addons:+ and add-ons: $addons}..."
docker build --pull -f apps/runner/Dockerfile \
  --build-arg BOSSMAN_IMAGE_VERSION="$stamp" \
  --build-arg BOSSMAN_IMAGE_COMMIT="$commit" \
  --build-arg RUNNER_ADDONS="$addons" \
  -t "$IMAGE:candidate" .
lap "runner image build"

echo "Running the canary (no network): Codex, OpenCode and each add-on. Claude is proven by its pack installer, not here (DR-050)..."
if ! docker run --rm --network none --cap-drop ALL --security-opt no-new-privileges:true \
  "$IMAGE:candidate" node_modules/.bin/tsx src/canary-main.ts; then
  echo "The canary failed: $IMAGE:current is unchanged and the runners keep running it." >&2
  echo "The failed build is still tagged $IMAGE:candidate if you want to look at it." >&2
  exit 1
fi
lap "canary"

if docker image inspect "$IMAGE:current" >/dev/null 2>&1; then docker tag "$IMAGE:current" "$IMAGE:previous"; fi
# The guard's :previous is tagged here too (not before the build), so a failed canary and a re-run can't leave --rollback
# pairing the old runner with the failed guard build. NETGUARD_PREV holds the id of the guard that was current before this update.
if [[ -n "$NETGUARD_PREV" ]]; then
  docker tag boss-man-netguard:pending-previous boss-man-netguard:previous || echo "WARNING: could not keep the old network guard as :previous; --rollback will not restore it." >&2
  docker rmi boss-man-netguard:pending-previous >/dev/null 2>&1 || true
fi
docker tag "$IMAGE:candidate" "$IMAGE:current"
docker rmi "$IMAGE:candidate" >/dev/null
# BOS-1583: tell the server which add-ons this image holds (outbox/runner-addons.built, one line, may be empty), so the tick boxes
# start from what is really built, including add-ons that were only ever set by hand in .env. Written in the root-only state
# folder, then renamed in, like the drain request.
if [[ -n ${BOSSMAN_DEPLOYER:-} && -d $BOSSMAN_DEPLOYER/outbox ]]; then
  mkdir -p "$BOSSMAN_DEPLOYER/state" && chmod 700 "$BOSSMAN_DEPLOYER/state"
  built_tmp="$(mktemp "$BOSSMAN_DEPLOYER/state/addons.XXXXXX")"
  printf '%s\n' "$addons" >"$built_tmp"
  chmod 644 "$built_tmp"; chown 1000:1000 "$built_tmp" 2>/dev/null || true
  mv -fT "$built_tmp" "$BOSSMAN_DEPLOYER/outbox/runner-addons.built" || echo "WARNING: could not record the built add-ons for Settings." >&2
fi
# Put launcher code live with this same button (BOS-335), before the drain so the new launcher runs it.
rebuild_launcher
lap "launcher rebuild"
move_runners
echo "The new runner image ($stamp) is current. To undo: scripts/update-runner.sh --rollback"
