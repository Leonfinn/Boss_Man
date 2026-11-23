#!/usr/bin/env bash
# One-command first install from the source (BOS-1579): docs/00-first-time-install.md steps 1, 3, 4 and 5 in one script.
#
#   git clone <repo-url> /opt/boss-man/src && cd /opt/boss-man/src && sudo scripts/install.sh
#
# It asks for the address the web page should listen on (or take --host), then: makes the data and secrets folders owned by
# the server's user, makes the master key and the empty runner token file, writes .env (launcher on), builds the server and
# launcher, runs scripts/update-runner.sh (runner image, canary, start) and waits until the server answers.
#
# Safe to run again (after an update, or a week on): it never replaces master.key or an existing .env (a new database
# password would lock the database out), never touches data, and only rebuilds and restarts. To change a setting later, edit .env.
#
#   scripts/install.sh [--host <address>] [--port <port>] [--install-dir <dir>] [--truenas] [--yes]
#     --host         address the web page listens on: your host's LAN address, or 0.0.0.0 for every address, or 127.0.0.1
#                    for this machine only (default when not asked). Only used when .env is first written.
#     --port         the port in the browser (default 3100). Only used when .env is first written.
#     --install-dir  where data/ and deployer/ live (default: the folder above this checkout when it is named "src", else the checkout)
#     --truenas      also use deploy/truenas.yml so the database lives in <install-dir>/data/postgres
#     --yes          never ask a question (without --host, listen on 127.0.0.1)
# Test hooks: BOSSMAN_INSTALL_UID / BOSSMAN_INSTALL_GID (the server's user, default 1000), BOSSMAN_DOCKER_SOCK.
set -euo pipefail

repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
uid="${BOSSMAN_INSTALL_UID:-1000}"
gid="${BOSSMAN_INSTALL_GID:-1000}"
sock="${BOSSMAN_DOCKER_SOCK:-/var/run/docker.sock}"
host="" port="" idir="" truenas=0 yes=0

die() { echo "install: $*" >&2; exit 1; }
say() { echo "install: $*"; }

while [ "$#" -gt 0 ]; do
  case "$1" in
    --host) [ "$#" -ge 2 ] || die "--host needs an address"; host="$2"; shift 2 ;;
    --port) [ "$#" -ge 2 ] || die "--port needs a number"; port="$2"; shift 2 ;;
    --install-dir) [ "$#" -ge 2 ] || die "--install-dir needs a folder"; idir="$2"; shift 2 ;;
    --truenas) truenas=1; shift ;;
    --yes|-y) yes=1; shift ;;
    -h|--help) sed -n '2,20p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) die "unknown option '$1' (see --help)" ;;
  esac
done

if [ -z "$idir" ]; then
  if [ "$(basename "$repo")" = src ]; then idir="$(dirname "$repo")"; else idir="$repo"; fi
fi
# The folder is created here, so an absolute path is needed before the script moves around.
mkdir -p "$idir"; idir="$(cd "$idir" && pwd)"

# Preflight: say everything that is missing at once, with what to do.
missing=()
for t in docker openssl curl stat; do command -v "$t" >/dev/null 2>&1 || missing+=("$t"); done
[ "${#missing[@]}" -eq 0 ] || die "missing on this host: ${missing[*]}. Install them and run this again."
docker compose version >/dev/null 2>&1 || die "'docker compose' (Compose v2) does not work. Install the Docker Compose plugin and run this again."
[ -e "$sock" ] || die "no Docker socket at $sock. Is Docker running? If it lives elsewhere, run with BOSSMAN_DOCKER_SOCK=<path>."
if [ "$(id -u)" != 0 ] && [ "$(id -u)" != "$uid" ]; then
  die "run this as root (sudo scripts/install.sh): the folders must belong to user $uid, which the server runs as."
fi
[ -f "$repo/docker-compose.yml" ] || die "no docker-compose.yml in $repo: run this from a Boss Man checkout."

valid_host() { [[ $1 =~ ^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$ ]]; }

env_file="$repo/.env"
fresh_env=1; [ ! -s "$env_file" ] || fresh_env=0

if [ "$fresh_env" = 1 ]; then
  if [ -z "$host" ]; then
    if [ "$yes" = 0 ] && [ -t 0 ]; then
      echo "Which address should the Boss Man web page listen on?"
      echo "  Your host's address on your home network (for example 192.168.1.50) lets other computers open it."
      echo "  Press Enter for 127.0.0.1: only this machine can open it."
      read -r -p "Address [127.0.0.1]: " host || true
    fi
    host="${host:-127.0.0.1}"
  fi
  valid_host "$host" || die "'$host' is not an address or host name."
  port="${port:-3100}"
  if ! [[ $port =~ ^[0-9]+$ ]] || [ "$port" -lt 1 ] || [ "$port" -gt 65535 ]; then die "'$port' is not a port number (1 to 65535)."; fi
fi

say "install folder: $idir"
say "code folder:    $repo"

# 1. Folders, owned by the server's user.
mkdir -p "$idir/data/companies" "$repo/secrets"
[ "$truenas" = 0 ] || mkdir -p "$idir/data/postgres"
chown "$uid:$gid" "$idir/data/companies" "$repo/secrets"
chmod 700 "$repo/secrets"

# 2. Master key and the empty runner token file. Never replaced: a new master key could not read the old secrets.
key="$repo/secrets/master.key"
if [ -s "$key" ]; then
  say "kept the existing master key"
else
  umask 077
  openssl rand -base64 32 >"$key"
  say "made the master key"
fi
chown "$uid:$gid" "$key"; chmod 600 "$key"
tok="$repo/secrets/runner-app-co.token"
[ -e "$tok" ] || : >"$tok"
chown "$uid:$gid" "$tok"; chmod 600 "$tok"

# 3. .env: written once. An existing one (it holds the database password) is kept as it is.
if [ "$fresh_env" = 1 ]; then
  umask 077
  {
    echo "COMPOSE_PROFILES=launcher"
    echo "BOSSMAN_LAUNCHER=1"
    echo "BOSSMAN_DOCKER_GID=$(stat -c %g "$sock")"
    echo "BOSSMAN_DATA=$idir/data"
    echo "POSTGRES_PASSWORD=$(openssl rand -hex 24)"
    echo "BOSSMAN_BIND=$host"
    echo "BOSSMAN_HOST_PORT=$port"
    echo "BOSSMAN_INSECURE_COOKIES=1"
    echo "BOSSMAN_DEPLOYER=$idir/deployer"
    [ "$truenas" = 0 ] || echo "COMPOSE_FILE=docker-compose.yml:deploy/truenas.yml"
  } >"$env_file"
  chmod 600 "$env_file"
  say "wrote .env"
else
  say "kept your existing .env (change settings there, then run scripts/update-runner.sh --settings)"
  host="$(grep -s '^BOSSMAN_BIND=' "$env_file" | tail -1 | cut -d= -f2- || true)"; host="${host:-127.0.0.1}"
  port="$(grep -s '^BOSSMAN_HOST_PORT=' "$env_file" | tail -1 | cut -d= -f2- || true)"; port="${port:-3100}"
fi

# 4. Build and start. update-runner.sh builds the runner image and guard, runs the canary, then starts everything.
cd "$repo"
say "building the server and launcher (a few minutes the first time)"
docker compose build server launcher
say "building the runner image, running the safety check and starting everything"
scripts/update-runner.sh

# 5. Wait for the server (a deadline, not a fixed sleep).
probe="$host"; case "$host" in 0.0.0.0|::) probe=127.0.0.1 ;; esac
url="http://$probe:$port/api/health"
deadline=$((SECONDS + ${BOSSMAN_INSTALL_WAIT:-300}))
until curl -fsS "$url" >/dev/null 2>&1; do
  if [ "$SECONDS" -ge "$deadline" ]; then
    die "the server did not answer at $url in time. Run 'docker compose ps' and 'docker compose logs server' in $repo, and see docs/29-tune-and-troubleshoot.md. Running this script again is safe."
  fi
  sleep 3
done

shown="$host"; [ "$host" != 0.0.0.0 ] || shown="<this machine's address>"
echo
say "Boss Man is running. Open http://$shown:$port and make the owner account."
say "Now copy $key somewhere safe outside this machine. Without it, stored secrets cannot be read again."
