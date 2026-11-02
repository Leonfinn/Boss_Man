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
export BOSSMAN_DOCKER_GID="$(stat -c %g /var/run/docker.sock)" BOSSMAN_HOST_PORT="${BOSSMAN_HOST_PORT:-3100}"
runner=boss-man-runner-ci-co
cleanup() {
  docker rm -f "$runner" >/dev/null 2>&1 || true
  docker compose down -v >/dev/null 2>&1 || true
  sudo rm -rf "$data"
}
trap cleanup EXIT

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

settings="$(docker inspect "$runner" --format '{{.Config.User}} {{json .HostConfig.CapDrop}} {{.HostConfig.Privileged}} {{.HostConfig.NetworkMode}} {{json .HostConfig.SecurityOpt}} {{.HostConfig.PidsLimit}} {{index .Config.Labels "boss-man.launcher"}}')"
echo "Runner settings: $settings"
[[ "$settings" == '1000:1000 ["ALL"] false boss-man_default ["no-new-privileges:true"] 4096 1' ]]

# Network guard (BOS-324): the runner reaches the server, but not the database or the network gateway (IPv4 or IPv6).
# curl exits 7 when it can't connect: that is the guard's answer; a reachable port gives another code.
guard="boss-man-netguard-ci-co"
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
# cut off when the guard arrives, not kept alive. The client opens db:5432, then writes a byte every half second;
# the database closing it (end or reset) would mean the connection survived; the guard's reject is another error.
docker compose stop launcher >/dev/null
docker restart "$runner" >/dev/null
for _ in $(seq 30); do docker exec "$runner" true 2>/dev/null && break; sleep 1; done
docker exec "$runner" rm -f /tmp/guard-conn
docker exec -d "$runner" node -e '
const fs = require("node:fs");
const s = require("node:net").connect(5432, "db");
const done = (what) => { fs.writeFileSync("/tmp/guard-conn", what); process.exit(0); };
s.on("connect", () => { fs.writeFileSync("/tmp/guard-conn-open", "1"); });
s.on("error", (e) => done("error " + e.code));
s.on("end", () => done("end"));
setInterval(() => { try { s.write("x"); } catch (e) { done("error " + e.code); } }, 500);
'
for _ in $(seq 20); do docker exec "$runner" test -e /tmp/guard-conn-open 2>/dev/null && break; sleep 1; done
docker exec "$runner" test -e /tmp/guard-conn-open || { echo "Couldn't open a connection to the database before the guard was up" >&2; exit 1; }
docker exec "$runner" rm -f /tmp/guard-conn
docker compose start launcher >/dev/null
for _ in $(seq 40); do docker exec "$runner" test -s /tmp/guard-conn 2>/dev/null && break; sleep 2; done
ended="$(docker exec "$runner" cat /tmp/guard-conn 2>/dev/null || true)"
echo "Connection opened before the guard: $ended"
[[ -n "$ended" && "$ended" != "end" && "$ended" != "error ECONNRESET" && "$ended" != "error EPIPE" ]] || { echo "A connection opened before the guard survived it: '$ended'" >&2; exit 1; }
for _ in $(seq 30); do check_guard 2>/dev/null && ok=1 && break; sleep 3; done
[[ "${ok:-0}" == 1 ]]
echo "Network guard: a connection opened before it was up is cut off."

# The launcher publishes no ports.
[[ -z "$(docker compose port launcher 3105 2>/dev/null || true)" ]]

curl -fs -b "$jar" -X DELETE "$base/api/companies/$id/runner/launch" >/dev/null
if docker inspect "$runner" >/dev/null 2>&1; then echo "The runner wasn't removed" >&2; exit 1; fi
sudo test -d "$data/companies/ci-co/workspaces"
sudo test ! -e "$data/companies/ci-co/runner.token"
echo "Launcher end to end: OK"
