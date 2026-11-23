#!/usr/bin/env bash
# Container tests for the built images, run natively on each CPU architecture by CI's `images` job (BOS-971).
# Needs Docker and the images boss-man-runner:ci and boss-man-netguard:current (build them first).
#   scripts/image-tests.sh                 all tests
#   scripts/image-tests.sh canary fence    only the named ones: canary, fence, netguard, no-anthropic, updater (needs boss-man-updater:ci)
# The no-Anthropic check is a normal one now that the Claude pack has landed (BOS-972). XFAIL_NO_ANTHROPIC=1
# still marks it as expected to fail, for trying an old image.
# Safe to run twice: it removes the containers and the network it makes, even when a test fails.
set -euo pipefail

RUNNER_IMAGE="${RUNNER_IMAGE:-boss-man-runner:ci}"
GUARD_IMAGE="${GUARD_IMAGE:-boss-man-netguard:current}"
XFAIL_NO_ANTHROPIC="${XFAIL_NO_ANTHROPIC:-0}"
ARCH="$(docker version --format '{{.Server.Arch}}' 2>/dev/null || uname -m)"
tag="bm-imgtest-$$"
net="$tag-net"
made=()

say() { echo "image-tests[$ARCH]: $*"; }
fail() { echo "image-tests[$ARCH]: FAIL: $*" >&2; exit 1; }
cleanup() {
  local c
  for c in "${made[@]}"; do docker rm -f "$c" >/dev/null 2>&1 || true; done
  docker network rm "$net" >/dev/null 2>&1 || true
}
trap cleanup EXIT

# The same canary update-runner.sh gates a rebuild on: a session of each agent kind works with no network.
test_canary() {
  docker run --rm --network none --cap-drop ALL --security-opt no-new-privileges:true "$RUNNER_IMAGE" node_modules/.bin/tsx src/canary-main.ts
  say "canary ok"
}

# The Landlock fence, for real: the helper must confine a write to its folder on this architecture's kernel and
# syscall numbers. Uses the default Docker seccomp profile and no added privileges, as the live runner does.
test_fence() {
  local out
  out="$(docker run --rm --cap-drop ALL --security-opt no-new-privileges:true "$RUNNER_IMAGE" node_modules/.bin/tsx src/fence-probe-main.ts)" \
    || fail "the Landlock fence doesn't work in the runner image: $out"
  say "fence ok: $out"
}

ip_of() { docker inspect --format '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' "$1"; }
# Opens a TCP connection from inside the container $1 to $2:8080; prints "open" or "closed <code>".
dial() {
  docker exec "$1" node -e '
    const s = require("net").connect({ host: process.argv[1], port: 8080, timeout: 3000 });
    s.on("connect", () => { console.log("open"); process.exit(0); });
    s.on("error", (e) => { console.log("closed " + e.code); process.exit(1); });
    s.on("timeout", () => { console.log("closed timeout"); process.exit(1); });
  ' "$2" 2>&1 || true
}

# The network guard, for real: it shares a container's network namespace, opens one allowed address (private,
# like the server on the stack network) and must refuse another private address that was not allowed.
test_netguard() {
  docker network create "$net" >/dev/null
  local serve='require("http").createServer((q, r) => r.end("ok")).listen(8080)'
  local name
  for name in victim allowed denied; do
    made+=("$tag-$name")
  done
  docker run -d --name "$tag-victim" --network "$net" --entrypoint sleep "$RUNNER_IMAGE" 600 >/dev/null
  docker run -d --name "$tag-allowed" --network "$net" --entrypoint node "$RUNNER_IMAGE" -e "$serve" >/dev/null
  docker run -d --name "$tag-denied" --network "$net" --entrypoint node "$RUNNER_IMAGE" -e "$serve" >/dev/null
  local allowed denied
  allowed="$(ip_of "$tag-allowed")"
  denied="$(ip_of "$tag-denied")"
  [[ -n "$allowed" && -n "$denied" ]] || fail "test containers have no address on $net"
  sleep 2 # let both servers start listening

  # Before the guard: both are reachable, so a later refusal is the guard's doing.
  [[ "$(dial "$tag-victim" "$allowed")" == open ]] || fail "before the guard, the allowed address should be reachable"
  [[ "$(dial "$tag-victim" "$denied")" == open ]] || fail "before the guard, the other address should be reachable"

  made+=("$tag-guard")
  docker run -d --name "$tag-guard" --network "container:$tag-victim" --cap-drop ALL --cap-add NET_ADMIN \
    --security-opt no-new-privileges:true --read-only -e "NETGUARD_ALLOW=$allowed:8080" "$GUARD_IMAGE" >/dev/null
  local loaded="" tries=0
  while ((tries++ < 30)); do
    if docker exec "$tag-guard" nft list table inet bossman_netguard 2>/dev/null | grep -q "ip daddr $allowed tcp dport 8080 accept"; then loaded=1; break; fi
    [[ "$(docker inspect --format '{{.State.Running}}' "$tag-guard")" == true ]] || fail "the guard stopped: $(docker logs "$tag-guard" 2>&1 | tail -5)"
    sleep 1
  done
  [[ -n "$loaded" ]] || fail "the guard never loaded its full rules: $(docker logs "$tag-guard" 2>&1 | tail -5)"

  [[ "$(dial "$tag-victim" "$allowed")" == open ]] || fail "the allowed address must stay reachable behind the guard"
  local got
  got="$(dial "$tag-victim" "$denied")"
  [[ "$got" == closed* ]] || fail "a private address that was not allowed must be refused behind the guard, got: $got"
  say "netguard ok (allowed $allowed open; $denied: $got)"
}

# The published runner image must hold no Anthropic code (DR-050). Looks for the npm scope and Claude Code's
# files and command; any hit is listed. Expected to fail until the Claude pack ticket lands.
test_no_anthropic() {
  local hits
  hits="$(docker run --rm --entrypoint sh "$RUNNER_IMAGE" -c '
    find / -xdev \( -path /proc -o -path /sys \) -prune -o \
      \( -type d -path "*/node_modules/@anthropic-ai" -o -name claude -o -name "claude-code*" -o -name "claude-agent-sdk*" \) -print 2>/dev/null | head -20
    test -z "${CLAUDE_CODE_EXECUTABLE:-}" || echo "env CLAUDE_CODE_EXECUTABLE=$CLAUDE_CODE_EXECUTABLE"
  ')"
  if [[ -n "$hits" ]]; then
    if [[ "$XFAIL_NO_ANTHROPIC" == 1 ]]; then
      say "no-anthropic: EXPECTED FAIL (Claude pack not landed yet); found:"
      printf '    %s\n' "${hits//$'\n'/$'\n'    }"
      return 0
    fi
    fail "the runner image holds Anthropic code:"$'\n'"$hits"
  fi
  if [[ "$XFAIL_NO_ANTHROPIC" == 1 ]]; then
    fail "no-anthropic passes now: the Claude pack has landed, so remove XFAIL_NO_ANTHROPIC from CI"
  fi
  say "no-anthropic ok"
}

# The updater image (BOS-1225, design section 10), for real on this architecture:
#  1. group 0 (a Docker Desktop socket gives it) can write nothing the image ships;
#  2. without its settings it refuses to start and names the first missing one;
#  3. with them, as uid 1000 with every capability dropped and a read-only root, it answers GET /status with the right key,
#     refuses a wrong key and a missing key (so the sigstore package and the compiled code are all in the image).
# Needs the image UPDATER_IMAGE (default boss-man-updater:ci). Not part of the default set: CI names it.
test_updater() {
  local img="${UPDATER_IMAGE:-boss-man-updater:ci}" bad out c keyfile
  bad="$(docker run --rm --entrypoint sh "$img" -c 'find /app /NOTICE /run/updater /state /usr/local/bin /usr/local/lib/node_modules ! -type l -group 0 -perm /g+w | head -10')"
  [[ -z "$bad" ]] || fail "group 0 could write files the updater image ships:"$'\n'"$bad"
  out="$(docker run --rm --user 1000:1000 --cap-drop ALL --read-only "$img" 2>&1)" && fail "the updater started with no settings"
  [[ "$out" == *UPDATER_REPO* ]] || fail "the updater's start-up message should name the first missing setting, got: $out"
  keyfile="$(mktemp)"
  local testkey
  testkey="$(head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n')" # a fresh throwaway value each run, 48 characters
  printf '%s\n' "$testkey" >"$keyfile"
  chmod 0644 "$keyfile"
  c="$tag-updater"
  made+=("$c")
  docker run -d --name "$c" --user 1000:1000 --cap-drop ALL --security-opt no-new-privileges:true --read-only \
    --tmpfs /state:uid=1000,gid=1000 -v "$keyfile:/run/updater/key:ro" \
    -e UPDATER_REPO=acme/boss-man -e UPDATER_REGISTRY=ghcr.io/acme -e UPDATER_INSTALL_LABEL=boss-man.install=imgtest \
    -e UPDATER_CURRENT_VERSION=0.1.0 -e UPDATER_PACK_VOLUME=imgtest-pack -e UPDATER_NETWORK=imgtest_default -e UPDATER_NAME_PREFIX=imgtest-updater "$img" >/dev/null
  local tries=0 code=""
  while ((tries++ < 30)); do
    code="$(docker exec -e "TESTKEY=$testkey" "$c" node -e 'fetch("http://127.0.0.1:3106/status",{headers:{authorization:"Bearer "+process.env.TESTKEY}}).then(async r=>{console.log(r.status+" "+(await r.json()).stage)},()=>{console.log("down")})' 2>/dev/null || true)"
    [[ "$code" == "200 idle" ]] && break
    [[ "$(docker inspect --format '{{.State.Running}}' "$c")" == true ]] || fail "the updater stopped: $(docker logs "$c" 2>&1 | tail -5)"
    sleep 1
  done
  [[ "$code" == "200 idle" ]] || fail "GET /status with the right key should give 200 idle, got: $code. $(docker logs "$c" 2>&1 | tail -5)"
  code="$(docker exec "$c" node -e 'fetch("http://127.0.0.1:3106/status",{headers:{authorization:"Bearer wrong"}}).then(r=>console.log(r.status))')"
  [[ "$code" == 401 ]] || fail "a wrong key should be refused with 401, got: $code"
  code="$(docker exec "$c" node -e 'fetch("http://127.0.0.1:3106/status").then(r=>console.log(r.status))')"
  [[ "$code" == 401 ]] || fail "no key should be refused with 401, got: $code"
  rm -f "$keyfile"
  say "updater ok (group 0 writes nothing; settings are required; /status needs the key)"
}

tests=("$@")
((${#tests[@]})) || tests=(canary fence netguard no-anthropic)
for t in "${tests[@]}"; do
  case "$t" in
    canary) test_canary ;;
    fence) test_fence ;;
    netguard) test_netguard ;;
    no-anthropic) test_no_anthropic ;;
    updater) test_updater ;;
    *) fail "unknown test $t (canary, fence, netguard, no-anthropic, updater)" ;;
  esac
done
say "all requested tests passed"
