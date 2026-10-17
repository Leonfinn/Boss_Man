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
[[ "$settings" == '1000:1000 ["ALL"] false boss-man_default ["no-new-privileges:true"] 1024 1' ]]

# The launcher publishes no ports.
[[ -z "$(docker compose port launcher 3105 2>/dev/null || true)" ]]

curl -fs -b "$jar" -X DELETE "$base/api/companies/$id/runner/launch" >/dev/null
if docker inspect "$runner" >/dev/null 2>&1; then echo "The runner wasn't removed" >&2; exit 1; fi
sudo test -d "$data/companies/ci-co/workspaces"
sudo test ! -e "$data/companies/ci-co/runner.token"
echo "Launcher end to end: OK"
