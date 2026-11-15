#!/usr/bin/env bash
# The launcher against real Docker (R55): a new company's runner starts and connects by itself,
# with the locked-down settings, and stopping it keeps its data. CI runs this after building
# boss-man-server, boss-man-launcher:current and boss-man-runner:current. Run it from the
# repository root on a machine where you can use Docker and sudo; it cleans up after itself.
set -euo pipefail

data="$(mktemp -d)"
mkdir -p "$data/companies" secrets
sudo chown 1000:1000 "$data/companies"
[[ -s secrets/master.key ]] || openssl rand -base64 32 > secrets/master.key
chmod 644 secrets/master.key
touch secrets/runner-app-co.token

export POSTGRES_PASSWORD=ci BOSSMAN_DATA="$data" BOSSMAN_LAUNCHER=1 COMPOSE_PROFILES=launcher BOSSMAN_INSECURE_COOKIES=1
BOSSMAN_DOCKER_GID="$(stat -c %g /var/run/docker.sock)"
export BOSSMAN_DOCKER_GID BOSSMAN_HOST_PORT="${BOSSMAN_HOST_PORT:-3100}"
runner=boss-man-runner-ci-co
guard="boss-man-netguard-ci-co"
network=boss-man_default
cleanup() {
  [[ -z "${watcher:-}" ]] || kill "$watcher" 2>/dev/null || true
  docker rm -f "$runner" "$guard" >/dev/null 2>&1 || true
  docker compose down -v >/dev/null 2>&1 || true
  sudo rm -rf "$data"
}
trap cleanup EXIT

# BOS-576: a runner is never on its network while its guard isn't loaded. Samples Docker every 0.2 s and writes a
# line for each sample where the runner runs on the network but no healthy guard newer than it is in its namespace.
nanos() { date -d "$1" +%s%N; }
watch_hold() {
  local out="$1" r g run started nets grun ghealth gstarted
  : >"$out"
  while :; do
    r="$(docker inspect "$runner" --format '{{.State.Running}} {{.State.StartedAt}} {{range $k, $v := .NetworkSettings.Networks}}{{$k}},{{end}}' 2>/dev/null)" || { sleep 0.2; continue; }
    read -r run started nets <<<"$r"
    if [[ "$run" == true && ",${nets:-}" == *",$network,"* ]]; then
      g="$(docker inspect "$guard" --format '{{.State.Running}} {{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}} {{.State.StartedAt}}' 2>/dev/null || echo "false none 0001-01-01T00:00:00Z")"
      read -r grun ghealth gstarted <<<"$g"
      if [[ "$grun" != true || "$ghealth" != healthy ]] || (($(nanos "$gstarted") < $(nanos "$started"))); then
        echo "$(date -u +%T.%N) runner on $network, guard: $g" >>"$out"
      fi
    fi
    sleep 0.2
  done
}
hold_log="$(mktemp)"
watch_hold "$hold_log" &
watcher=$!
stop_watch() {
  kill "$watcher" 2>/dev/null || true
  wait "$watcher" 2>/dev/null || true
  watcher=""
  if [[ -s "$hold_log" ]]; then
    echo "$1: the runner was on its network without a loaded guard:" >&2
    head -20 "$hold_log" >&2
    exit 1
  fi
}

docker compose up -d --no-build db server launcher
base="http://127.0.0.1:$BOSSMAN_HOST_PORT"
for _ in $(seq 60); do curl -fs "$base/api/health" >/dev/null && break; sleep 2; done
jar="$(mktemp)"
curl -fs -c "$jar" -H 'content-type: application/json' -d '{"username":"ci","password":"correct horse battery"}' "$base/api/setup" >/dev/null
id="$(curl -fs -b "$jar" -H 'content-type: application/json' -d '{"name":"CI Co"}' "$base/api/companies" | node -e 'let s="";process.stdin.on("data",(d)=>(s+=d)).on("end",()=>console.log(JSON.parse(s).company.id))')"

status=""
for _ in $(seq 90); do
  status="$(curl -fs -b "$jar" "$base/api/companies/$id/runner")"
  grep -q '"connected":true' <<<"$status" && break
  sleep 2
done
if ! grep -q '"connected":true' <<<"$status"; then
  echo "The runner never connected: $status" >&2
  docker logs "$runner" 2>&1 | tail -30 || true
  docker compose logs launcher server 2>&1 | tail -60
  exit 1
fi
echo "Connected: $status"
stop_watch "First start"
echo "Network hold: the new runner joined its network only once its guard was loaded."

settings="$(docker inspect "$runner" --format '{{.Config.User}} {{json .HostConfig.CapDrop}} {{.HostConfig.Privileged}} {{.HostConfig.NetworkMode}} {{json .HostConfig.SecurityOpt}} {{.HostConfig.PidsLimit}} {{index .Config.Labels "boss-man.launcher"}}')"
echo "Runner settings: $settings"
[[ "$settings" == '1000:1000 ["ALL"] false boss-man_default ["no-new-privileges:true"] 4096 1' ]]

# Network guard (BOS-324): the runner reaches the server, but not the database or the network gateway (IPv4 or IPv6).
# curl exits 7 when it can't connect: that is the guard's answer; a reachable port gives another code.
guard_settings="$(docker inspect "$guard" --format '{{json .HostConfig.CapAdd}} {{json .HostConfig.CapDrop}} {{.HostConfig.Privileged}} {{.HostConfig.ReadonlyRootfs}}')"
[[ "$guard_settings" == '["NET_ADMIN"] ["ALL"] false true' ]]
[[ "$(docker inspect "$runner" --format '{{json .HostConfig.CapAdd}}')" == '[]' ]]
gateway="$(docker network inspect boss-man_default --format '{{range .IPAM.Config}}{{.Gateway}} {{end}}')"
# curl -g keeps the brackets of an IPv6 address; the runner image has getent from libc.
db_addrs="$(docker exec "$runner" getent ahosts db | awk '{print $1}' | sort -u)"
echo "Gateways: $gateway; db addresses: $db_addrs"
[[ -n "$db_addrs" ]]
blocked() { local code=0; docker exec "$runner" curl -g -s -m 8 -o /dev/null "$1" || code=$?; [[ "$code" == 7 ]]; }
reached() { local code=0; docker exec "$runner" curl -g -s -m 8 -o /dev/null "$1" || code=$?; [[ "$code" != 7 && "$code" != 28 ]]; }
# Each line ends in "|| return 1": the loop below calls this inside an &&, where set -e is off.
check_guard() {
  local a g
  reached "http://server:3100/api/health" || return 1
  for a in $db_addrs; do
    if [[ "$a" == *:* ]]; then blocked "http://[$a]:5432/" || return 1; else blocked "http://$a:5432/" || return 1; fi
  done
  for g in $gateway; do
    if [[ "$g" == *:* ]]; then blocked "http://[$g]:3100/" || return 1; else blocked "http://$g:3100/" || return 1; fi
  done
  blocked "http://192.168.1.1/" || return 1
  blocked "http://169.254.169.254/" || return 1
  blocked "http://[fd00::1]/" || return 1
  # DNS still works through the resolvers the host uses (a private one too): a public name resolves and answers.
  docker exec "$runner" curl -s -m 20 -o /dev/null https://api.github.com/ || return 1
}
check_guard
echo "Network guard: server reachable; database, gateway and private ranges blocked."

# A runner that restarts by itself gets a new network namespace; the launcher puts the guard back within seconds.
docker restart "$runner" >/dev/null
for _ in $(seq 30); do
  if docker exec "$runner" true 2>/dev/null && check_guard 2>/dev/null; then restored=1; break; fi
  sleep 3
done
[[ "${restored:-0}" == 1 ]] || { echo "The guard didn't come back after the runner restarted" >&2; docker compose logs launcher 2>&1 | tail -30; exit 1; }
echo "Network guard: back in place after a restart."

# A connection opened while no guard is up (the launcher is stopped and the runner has a new namespace) must be
# cut off when the guard arrives, not kept alive. How the socket closes proves nothing (Postgres hangs up on an idle
# or malformed connection by itself, and the guard's ICMP reject is only a soft error on an open TCP socket), so we
# ask the database a question over the connection after the guard is up: Postgres answers an SSLRequest at once
# with one byte. First, with no guard, the same question on a fresh connection must get its answer, so a silence
# later means the guard stopped it, not that the probe is broken.
docker compose stop launcher >/dev/null
docker restart "$runner" >/dev/null
for _ in $(seq 30); do docker exec "$runner" true 2>/dev/null && break; sleep 1; done
# The SSLRequest: length 8, then the code 80877103.
ssl_request='const b = Buffer.alloc(8); b.writeInt32BE(8, 0); b.writeInt32BE(80877103, 4);'
unguarded="$(docker exec "$runner" node -e "$ssl_request"'
const s = require("node:net").connect(5432, "db");
const done = (what) => { console.log(what); process.exit(0); };
setTimeout(() => done("silent"), 10000);
s.on("connect", () => s.write(b));
s.on("data", () => done("reply"));
s.on("error", (e) => done("error " + e.code));
s.on("end", () => done("end"));
')"
[[ "$unguarded" == reply ]] || { echo "With no guard up the database didn't answer the probe ($unguarded), so the guard can't be tested" >&2; exit 1; }
docker exec "$runner" rm -f /tmp/guard-conn /tmp/guard-conn-open /tmp/guard-probe
docker exec -d "$runner" node -e "$ssl_request"'
const fs = require("node:fs");
const s = require("node:net").connect(5432, "db");
let probed = false;
const done = (what) => { fs.writeFileSync("/tmp/guard-conn", probed ? what : what + " before the probe"); process.exit(0); };
s.on("connect", () => fs.writeFileSync("/tmp/guard-conn-open", "1"));
s.on("data", () => done("reply"));
s.on("error", (e) => done("error " + e.code));
s.on("end", () => done("end"));
setInterval(() => {
  if (probed || !fs.existsSync("/tmp/guard-probe")) return;
  probed = true;
  s.write(b);
  setTimeout(() => done("silent"), 10000);
}, 200);
'
for _ in $(seq 20); do docker exec "$runner" test -e /tmp/guard-conn-open 2>/dev/null && break; sleep 1; done
docker exec "$runner" test -e /tmp/guard-conn-open || { echo "Couldn't open a connection to the database before the guard was up" >&2; exit 1; }
docker compose start launcher >/dev/null
for _ in $(seq 30); do check_guard 2>/dev/null && ok=1 && break; sleep 3; done
[[ "${ok:-0}" == 1 ]] || { echo "The guard didn't come up after the launcher started" >&2; exit 1; }
docker exec "$runner" touch /tmp/guard-probe
for _ in $(seq 15); do docker exec "$runner" test -s /tmp/guard-conn 2>/dev/null && break; sleep 1; done
probe="$(docker exec "$runner" cat /tmp/guard-conn 2>/dev/null || true)"
echo "Connection opened before the guard, asked after it: ${probe:-no result}"
case "$probe" in
  reply) echo "A connection opened before the guard still reaches the database" >&2; exit 1 ;;
  silent | end | "error "*) ;;
  *) echo "Couldn't tell whether the guard cut the connection off ('${probe:-no result}')" >&2; exit 1 ;;
esac
echo "Network guard: a connection opened before it was up is cut off."

# Self-heal (BOS-467): a runner that disappears while its token file is still there (what a guard failure leaves
# behind) is made again by the launcher, with the guard, without anyone pressing a button.
watch_hold "$hold_log" &
watcher=$!
docker rm -f "$runner" >/dev/null
# BOS-576: as soon as the new runner runs, it tries the database. Whether it is still held off its network or already
# guarded, the attempt must be refused (curl 7), never reach Postgres.
db_first="$(head -1 <<<"$db_addrs")"
if [[ "$db_first" == *:* ]]; then db_url="http://[$db_first]:5432/"; else db_url="http://$db_first:5432/"; fi
early=""
for _ in $(seq 600); do
  if [[ "$(docker inspect "$runner" --format '{{.State.Running}}' 2>/dev/null)" == true ]]; then
    nets="$(docker inspect "$runner" --format '{{range $k, $v := .NetworkSettings.Networks}}{{$k}} {{end}}' 2>/dev/null || true)"
    code=0
    docker exec "$runner" curl -g -s -m 8 -o /dev/null "$db_url" 2>/dev/null || code=$?
    if [[ "$code" == 7 ]]; then early="refused"; else early="not refused (curl exit $code)"; fi
    early="$early; runner networks at the try: ${nets:-none}"
    break
  fi
  sleep 0.1
done
echo "A database connection tried as soon as the recreated runner ran: ${early:-the runner never ran}"
[[ "$early" == refused* ]] || { echo "A connection during the runner's startup wasn't refused" >&2; exit 1; }
for _ in $(seq 80); do
  if docker exec "$runner" true 2>/dev/null && check_guard 2>/dev/null; then healed=1; break; fi
  sleep 3
done
[[ "${healed:-0}" == 1 ]] || { echo "The launcher didn't bring the removed runner back" >&2; docker compose logs launcher 2>&1 | tail -30; exit 1; }
for _ in $(seq 30); do
  status="$(curl -fs -b "$jar" "$base/api/companies/$id/runner")"
  grep -q '"connected":true' <<<"$status" && break
  sleep 2
done
grep -q '"connected":true' <<<"$status" || { echo "The recreated runner never connected: $status" >&2; exit 1; }
echo "Self-heal: removed runner recreated, guarded and connected."
stop_watch "Self-heal"
echo "Network hold: the self-healed runner joined its network only once its guard was loaded."

# The launcher publishes no ports.
[[ -z "$(docker compose port launcher 3105 2>/dev/null || true)" ]]

curl -fs -b "$jar" -X DELETE "$base/api/companies/$id/runner/launch" >/dev/null
if docker inspect "$runner" >/dev/null 2>&1; then echo "The runner wasn't removed" >&2; exit 1; fi
sudo test -d "$data/companies/ci-co/workspaces"
sudo test ! -e "$data/companies/ci-co/runner.token"
echo "Launcher end to end: OK"
