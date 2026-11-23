#!/usr/bin/env bash
# scripts/install.sh against a fake docker and curl (no daemon): a first run makes the folders, master key, token file and
# .env and builds then starts; a second run keeps the key and .env and still starts; bad input stops early with a plain message.
# Run: scripts/install.test.sh
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
fail() { echo "FAIL: $*"; cat "$T/out" 2>/dev/null || true; exit 1; }
mkdir -p "$T/bin" "$T/inst/src/scripts"
cat >"$T/bin/docker" <<'FAKE'
#!/usr/bin/env bash
echo "docker $*" >>"$FAKE_LOG"
exit 0
FAKE
cat >"$T/bin/curl" <<'FAKE'
#!/usr/bin/env bash
echo "curl $*" >>"$FAKE_LOG"
# Not answering for the first CURL_FAILS calls: the wait loop must retry, not fail at once.
n=$(($(cat "$FAKE_DIR/curls" 2>/dev/null || echo 0) + 1)); echo "$n" >"$FAKE_DIR/curls"
[ "$n" -gt "${CURL_FAILS:-0}" ]
FAKE
chmod +x "$T/bin/docker" "$T/bin/curl"
cp "$here/install.sh" "$T/inst/src/scripts/"
cat >"$T/inst/src/scripts/update-runner.sh" <<'FAKE'
#!/usr/bin/env bash
echo "update-runner" >>"$FAKE_LOG"
FAKE
chmod +x "$T/inst/src/scripts/update-runner.sh"
: >"$T/inst/src/docker-compose.yml"
: >"$T/sock"
export PATH="$T/bin:$PATH" FAKE_LOG="$T/log" FAKE_DIR="$T" BOSSMAN_DOCKER_SOCK="$T/sock"
BOSSMAN_INSTALL_UID="$(id -u)"; BOSSMAN_INSTALL_GID="$(id -g)"
export BOSSMAN_INSTALL_UID BOSSMAN_INSTALL_GID BOSSMAN_INSTALL_WAIT=30
S="$T/inst/src"
run() { : >"$FAKE_LOG"; rm -f "$T/curls"; (cd "$S" && scripts/install.sh "$@") >"$T/out" 2>&1 </dev/null; }
logged() { grep -qF -- "$1" "$FAKE_LOG"; }

# First run: a host given by flag, nothing asked.
CURL_FAILS=1 run --host 192.168.1.50 --port 3200 || fail "a first run failed"
[ -d "$T/inst/data/companies" ] || fail "data/companies not made in the folder above src"
[ -s "$S/secrets/master.key" ] || fail "no master key"
[ -e "$S/secrets/runner-app-co.token" ] || fail "no token file"
[ "$(stat -c %a "$S/secrets")" = 700 ] || fail "secrets folder not 700"
[ "$(stat -c %a "$S/secrets/master.key")" = 600 ] || fail "master key not 600"
[ "$(stat -c %a "$S/.env")" = 600 ] || fail ".env not 600"
for l in COMPOSE_PROFILES=launcher BOSSMAN_LAUNCHER=1 BOSSMAN_BIND=192.168.1.50 BOSSMAN_HOST_PORT=3200 "BOSSMAN_DATA=$T/inst/data" "BOSSMAN_DEPLOYER=$T/inst/deployer"; do
  grep -qxF -- "$l" "$S/.env" || fail ".env lacks $l"
done
grep -qE '^POSTGRES_PASSWORD=[0-9a-f]{48}$' "$S/.env" || fail "no database password"
grep -q '^COMPOSE_FILE=' "$S/.env" && fail "TrueNAS overlay written without --truenas"
logged "docker compose build server launcher" || fail "server and launcher not built"
logged "update-runner" || fail "update-runner.sh not run"
logged "curl -fsS http://192.168.1.50:3200/api/health" || fail "health not probed on the host and port"
[ "$(grep -c '^curl' "$FAKE_LOG")" -ge 2 ] || fail "the wait loop did not retry"
grep -q "http://192.168.1.50:3200" "$T/out" || fail "final message lacks the address"

# Second run: key and .env kept byte for byte, and a different --host does not rewrite them.
cp "$S/secrets/master.key" "$T/key.before"; cp "$S/.env" "$T/env.before"
run --host 10.0.0.9 || fail "a second run failed"
cmp -s "$T/key.before" "$S/secrets/master.key" || fail "master key was replaced"
cmp -s "$T/env.before" "$S/.env" || fail ".env was rewritten"
grep -q "kept your existing .env" "$T/out" || fail "second run did not say it kept .env"
logged "update-runner" || fail "second run did not restart"
logged "curl -fsS http://192.168.1.50:3200/api/health" || fail "second run probed the wrong address"

# --truenas, 0.0.0.0 (probe on loopback), and no question asked with --yes and no --host.
rm -rf "$S/.env" "$T/inst/data"
run --host 0.0.0.0 --truenas || fail "truenas run failed"
grep -qxF "COMPOSE_FILE=docker-compose.yml:deploy/truenas.yml" "$S/.env" || fail "overlay line missing"
[ -d "$T/inst/data/postgres" ] || fail "postgres folder missing"
logged "curl -fsS http://127.0.0.1:3100/api/health" || fail "0.0.0.0 not probed on loopback"
rm -f "$S/.env"
run --yes || fail "--yes run failed"
grep -qxF "BOSSMAN_BIND=127.0.0.1" "$S/.env" || fail "--yes did not default to 127.0.0.1"

# Bad input stops before anything is written or built.
rm -f "$S/.env"
for bad in "--host a;b" "--host x --port 99999" "--port abc" "--bogus"; do
  # shellcheck disable=SC2086
  if run $bad; then fail "accepted: $bad"; fi
  [ ! -e "$S/.env" ] || fail "wrote .env for: $bad"
  logged "docker compose build" && fail "built for: $bad"
done

# The server never answers: it fails with the log commands, not a hang.
rm -f "$S/.env"
if CURL_FAILS=999 BOSSMAN_INSTALL_WAIT=1 run --host 127.0.0.1; then fail "passed with a dead server"; fi
grep -q "docker compose logs server" "$T/out" || fail "no hint for a server that does not answer"

# Compose v2 missing: a plain message.
cat >"$T/bin/docker" <<'FAKE'
#!/usr/bin/env bash
[ "$1 $2" != "compose version" ]
FAKE
rm -f "$S/.env"
if run --host 127.0.0.1; then fail "passed without compose v2"; fi
grep -q "Compose v2" "$T/out" || fail "no compose message"
echo "install.test.sh: ok"
