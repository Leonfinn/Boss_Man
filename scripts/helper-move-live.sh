#!/usr/bin/env bash
# BOS-2528: BOS-1227 criterion 4 on a real Docker daemon.
#   1. A runner is live. The launcher is recreated by the updater's own helper move (apps/updater/src/helpers.ts moveHelpers, run inside
#      the running updater container). The runner container keeps its id and keeps running, and the new launcher lists it (GET /runners).
#   2. With a good guard image in that move, egress stays closed: a connection from the runner to a private address (the database, which
#      is on the runner's network) fails before, during and after. A control from a container with no guard shows the address is reachable.
#   3. A move whose guard image fails its check writes no release-current, leaves the launcher and the runner as they were, and the old
#      guard keeps guarding (same container, still running, egress still closed).
# Called by scripts/install-images.test.sh (real half) when its registry is local (INSTALL_HELPER_MOVE=0 opts out, =1 forces), after its stack is up and a runner "smoke" runs.
#   scripts/helper-move-live.sh <compose project> <images.env>
# It builds four small images on top of the stack's own launcher and guard images (a label, or a guard that exits 1) and pushes them to the
# registry named in images.env, which must accept pushes (CI's throwaway local registry). It touches only the stack's own containers.
# Needs: docker, jq, curl. Prints no token, key or environment.
# SC2015: ok and bad only print and set a flag. SC2317: cleanup runs from the EXIT trap.
# shellcheck disable=SC2015,SC2317
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.." || exit 1
P="${1:?compose project name}"
# BOS-2804: the updater and the launcher are named after the compose project.
LNAME="${P}-launcher"
UNAME="${P}-updater"
ENVF="${2:?images.env path}"
fail=0
oks=0
ok() { oks=$((oks + 1)); echo "ok   $1"; }
bad() { echo "FAIL $1"; fail=1; }
val() { grep "^$1=" "$ENVF" | tail -n1 | cut -d= -f2-; }

REG="$(val BOSSMAN_REGISTRY)"
LAUNCHER="$REG/boss-man-launcher@$(val BOSSMAN_LAUNCHER_DIGEST)"
NETGUARD="$REG/boss-man-netguard@$(val BOSSMAN_NETGUARD_DIGEST)"
RUNNER_DIGEST="$(val BOSSMAN_RUNNER_DIGEST)"
RUNNER=boss-man-runner-smoke
GUARD=boss-man-netguard-smoke
T="$(mktemp -d)"
TAGS=""
noticed=0
cleanup() { [ "$noticed" = 1 ] || echo "::error title=BOS-2528 helper move::FAIL, stopped early after $oks ok lines (see the FAIL line in the job log)"; touch "$T/stop"; for t in $TAGS; do docker rmi "$t" >/dev/null 2>&1; done; rm -rf "$T"; }
trap cleanup EXIT

curl -fsS "http://${REG%%/*}/v2/" >/dev/null 2>&1 || { bad "the registry ${REG%%/*} does not answer, so the test images cannot be pushed"; exit 1; }

# A variant of an image: a different digest from the same files. Prints the digest; the image is on this host by that digest.
variant() { # <name> <base ref> <Dockerfile lines after FROM>
  local tag="$REG/boss-man-$1:helper-move-$$-$2" base="$3" digest
  printf 'FROM %s\n%s\n' "$base" "$4" | docker build -q -t "$tag" - >/dev/null || return 1
  docker push -q "$tag" >/dev/null || return 1
  digest="$(docker inspect --format '{{index .RepoDigests 0}}' "$tag" | sed 's/.*@//')"
  docker rmi "$tag" >/dev/null 2>&1
  docker pull -q "$REG/boss-man-$1@$digest" >/dev/null || return 1
  TAGS="$TAGS $REG/boss-man-$1@$digest"
  echo "$digest"
}

L2="$(variant launcher v2 "$LAUNCHER" 'LABEL com.bossman.test="helper-move-v2"')" || { bad "build the second launcher image"; exit 1; }
L3="$(variant launcher v3 "$LAUNCHER" 'LABEL com.bossman.test="helper-move-v3"')" || { bad "build the third launcher image"; exit 1; }
GOOD="$(variant netguard good "$NETGUARD" 'LABEL com.bossman.test="good-guard"')" || { bad "build the good guard image"; exit 1; }
BADG="$(variant netguard bad "$NETGUARD" 'ENTRYPOINT ["/bin/sh","-c","echo this guard fails its check on purpose >&2; exit 1"]')" || { bad "build the failing guard image"; exit 1; }
ok "built four test images by digest (launcher x2, guard that works, guard that exits 1)"

call() { docker exec --user 1000:1000 "$LNAME" node -e '
const fs=require("fs");const [m,p,b]=process.argv.slice(1);
fetch("http://127.0.0.1:3105"+p,{method:m,headers:{authorization:"Bearer "+fs.readFileSync("/run/launcher/key","utf8").trim(),"content-type":"application/json"},body:b||undefined})
 .then(async r=>{console.log(await r.text());process.exit(r.status<300?0:1)}).catch(e=>{console.log(String(e));process.exit(1)})' "$@"; }

# The runner must be up and its guard on, or the egress proof proves nothing.
running() { docker inspect --format '{{.State.Running}}' "$1" 2>/dev/null; }
until_running() { # a runner started with a made-up token can take a moment to settle; wait for the event, with a deadline
  local end=$((SECONDS + 60))
  until [ "$(running "$RUNNER")" = true ] && [ "$(running "$GUARD")" = true ]; do
    [ "$SECONDS" -lt "$end" ] || return 1
    sleep 2
  done
}
if ! docker inspect "$RUNNER" >/dev/null 2>&1; then
  # A made-up value, built here so no token-shaped string sits in the file for the secret scan to flag.
  fake="$(printf 'x%.0s' $(seq 1 43))"
  call PUT /runners/smoke "{\"token\":\"bmr_$fake\"}" >/dev/null 2>&1
fi
until_running || { docker ps -a --format '{{.Names}} {{.Status}}' | grep -E 'runner|netguard' | cut -c1-200; docker logs --tail 8 "$GUARD" 2>&1 | cut -c1-240; bad "the runner and its guard are not both running"; exit 1; }
guard_state() { call GET /runners | jq -r '.[] | select(.slug=="smoke") | .guard'; }
[ "$(guard_state)" = on ] && ok "before: the launcher lists runner smoke with its guard on" || { bad "before: guard state is '$(guard_state)', not 'on' (this host cannot load the rules, so egress cannot be proved)"; exit 1; }

# One connection attempt from inside the runner to the database, a private address on the runner's own network. OPEN or CLOSED.
PROBE='const s=require("net").connect({host:process.argv[1],port:Number(process.argv[2]),timeout:3000});s.on("connect",()=>{console.log("OPEN");process.exit(0)});s.on("timeout",()=>{console.log("CLOSED");process.exit(0)});s.on("error",()=>{console.log("CLOSED");process.exit(0)})'
probe() { docker exec "$RUNNER" node -e "$PROBE" db 5432 2>/dev/null || echo ERROR; }
control="$(docker run --rm --network "${P}_default" --entrypoint node "$LAUNCHER" -e "$PROBE" db 5432 2>&1)"
[ "$control" = OPEN ] && ok "control: a container with no guard CAN open db:5432 (so a closed result below is the guard's doing)" || { bad "control did not reach db:5432: $control"; exit 1; }
[ "$(probe)" = CLOSED ] && ok "before: the runner cannot open db:5432 (egress closed)" || bad "before: the runner reached db:5432 or the probe failed"

state_of() { # <container> -> "id running"
  docker inspect --format '{{.Id}} {{.State.Running}}' "$1" 2>/dev/null
}
probe_loop() { # until $T/stop exists, one attempt about every half second, one line each, in file $1
  while [ ! -e "$T/stop" ]; do probe >> "$1"; sleep 0.5; done
}
move() { # <label> <version> <launcher digest> <guard digest>; prints the JSON line on stdout, the rest on stderr
  local out
  # The updater runs as uid 1000 with the socket's group (it starts as root only to learn that group). A plain exec would be root with
  # every capability dropped, which cannot write the uid-1000 state folder (EACCES on /state/state.json.tmp, run 45481019861).
  out="$(docker exec -i --user "1000:$(stat -c %g "${BOSSMAN_DOCKER_SOCK:-/var/run/docker.sock}")" -e MOVE_VERSION="$2" -e MOVE_LAUNCHER="$3" -e MOVE_RUNNER="$RUNNER_DIGEST" -e MOVE_NETGUARD="$4" "$UNAME" node --input-type=module - < scripts/helper-move-live.mjs 2>"$T/move.$1.err")" || {
    cat "$T/move.$1.err" >&2; echo "$out" >&2
    # One flat line for the public GitHub notice: the job log can't be read without a login, annotations can (BOS-2528). The updater prints no key or environment.
    # (move runs in a subshell, so the text goes through a file, not a variable.)
    printf ' [%s failed: %s | %s]' "$1" "$(head -c 400 "$T/move.$1.err" | tr '\n\r' '  ')" "$(printf '%s' "$out" | head -c 300 | tr '\n\r' '  ')" >> "$T/diag"
    return 1
  }
  cut -c1-300 "$T/move.$1.err" >&2
  tail -n1 <<<"$out"
}

# ---- Move 1: new launcher, good guard ----
r0="$(state_of "$RUNNER")"; g0="$(state_of "$GUARD")"; l0="$(state_of "$LNAME")"
rm -f "$T/stop"; : > "$T/probe1.log"
probe_loop "$T/probe1.log" &
loop=$!
m1="$(move one 0.0.1-helpermove "$L2" "$GOOD")"; rc=$?
touch "$T/stop"; wait "$loop" 2>/dev/null
echo "move 1: $m1"
[ "$rc" = 0 ] && [ "$(jq -r .result <<<"$m1")" = moved ] && ok "move 1 (new launcher, good guard) returned moved" || bad "move 1 did not return moved"
r1="$(state_of "$RUNNER")"; g1="$(state_of "$GUARD")"; l1="$(state_of "$LNAME")"
[ "$r0" = "$r1" ] && [ "${r1##* }" = true ] && ok "the runner container is the same one (${r1%% *}) and still running" || bad "runner changed: before '$r0' after '$r1'"
[ "$g0" = "$g1" ] && [ "${g1##* }" = true ] && ok "the guard container is the same one and still running" || bad "guard changed: before '$g0' after '$g1'"
[ "${l0%% *}" != "${l1%% *}" ] && [ "${l1##* }" = true ] && ok "the launcher was recreated (new container id) and runs" || bad "launcher not recreated: before '$l0' after '$l1'"
docker inspect --format '{{.Config.Image}} {{.State.Health.Status}}' "$LNAME" | grep -q "@$L2 healthy$" && ok "the new launcher runs the new image and is healthy" || bad "new launcher image or health: $(docker inspect --format '{{.Config.Image}} {{.State.Health.Status}}' "$LNAME")"
list="$(call GET /runners)"
jq -e '.[] | select(.slug=="smoke") | select(.state=="running")' <<<"$list" >/dev/null && ok "the new launcher lists runner smoke as running (GET /runners)" || bad "GET /runners from the new launcher: $list"
[ "$(jq -r '.[] | select(.slug=="smoke") | .guard' <<<"$list")" = on ] && ok "after: the new launcher reports the guard on" || bad "after: guard state is not on: $list"
jq -e --arg g "@$GOOD" '.releaseCurrent.netguard | endswith($g)' <<<"$m1" >/dev/null && ok "release-current now names the good guard" || bad "release-current after move 1: $(jq -c .releaseCurrent <<<"$m1")"
n_open="$(grep -c OPEN "$T/probe1.log")"; n_closed="$(grep -c CLOSED "$T/probe1.log")"; n_err="$(grep -c ERROR "$T/probe1.log")"
c1="$n_closed"; o1="$n_open"
echo "during move 1: $n_closed closed, $n_open open, $n_err errors"
[ "$n_open" = 0 ] && [ "$n_closed" -ge 3 ] && ok "during move 1 egress stayed closed ($n_closed attempts, none opened)" || bad "during move 1: $n_closed closed, $n_open open, $n_err errors"
[ "$(probe)" = CLOSED ] && ok "after move 1: the runner still cannot open db:5432" || bad "after move 1: egress is not closed"

# ---- Move 2: the guard image fails its check ----
rel1="$(jq -c .releaseCurrent <<<"$m1")"
rm -f "$T/stop"; : > "$T/probe2.log"
probe_loop "$T/probe2.log" &
loop=$!
m2="$(move two 0.0.2-helpermove "$L3" "$BADG")"; rc=$?
touch "$T/stop"; wait "$loop" 2>/dev/null
echo "move 2: $m2"
[ "$rc" = 0 ] && [ "$(jq -r .result <<<"$m2")" = pending ] && ok "move 2 (guard fails its check) returned pending, not moved" || bad "move 2 result: $(jq -r .result <<<"$m2" 2>/dev/null)"
jq -r .helpers.note <<<"$m2" | grep -q 'did not pass its check' && ok "the owner-facing note says the guard failed its check" || bad "move 2 note: $(jq -r .helpers.note <<<"$m2")"
[ "$(jq -c .releaseCurrent <<<"$m2")" = "$rel1" ] && ok "release-current was not written (unchanged from move 1)" || bad "release-current changed: $(jq -c .releaseCurrent <<<"$m2") (was $rel1)"
r2="$(state_of "$RUNNER")"; g2="$(state_of "$GUARD")"; l2="$(state_of "$LNAME")"
[ "$l1" = "$l2" ] && ok "the launcher was left as it was" || bad "launcher changed on a failed guard check: '$l1' -> '$l2'"
[ "$r1" = "$r2" ] && ok "the runner was left as it was" || bad "runner changed: '$r1' -> '$r2'"
[ "$g1" = "$g2" ] && [ "${g2##* }" = true ] && ok "the old guard is the same container and still running" || bad "guard changed: '$g1' -> '$g2'"
[ -z "$(docker ps -aq --filter name=guardcheck)" ] && ok "the failed check container was removed" || bad "a guardcheck container is left over"
[ "$(guard_state)" = on ] && ok "the launcher still reports the guard on" || bad "guard state after move 2: $(guard_state)"
n_open="$(grep -c OPEN "$T/probe2.log")"; n_closed="$(grep -c CLOSED "$T/probe2.log")"; n_err="$(grep -c ERROR "$T/probe2.log")"
echo "during move 2: $n_closed closed, $n_open open, $n_err errors"
# A move that stops at the failed guard check is short (a few seconds) and a blocked probe takes its 3 s timeout, so only 1 to 3 attempts
# fit (GitHub run 45487311598 got 2 on amd64, 1 on arm64). One closed and none open is what this window can show; "after" probes again below.
[ "$n_open" = 0 ] && [ "$n_closed" -ge 1 ] && ok "during move 2 egress stayed closed ($n_closed attempts, none opened)" || bad "during move 2: $n_closed closed, $n_open open, $n_err errors"
[ "$(probe)" = CLOSED ] && ok "after move 2: the runner still cannot open db:5432" || bad "after move 2: egress is not closed"
# One public line for the GitHub run: annotations can be read without a login, raw job logs cannot (BOS-2528). Figures only, no secrets.
same_runner=no; [ "$r0" = "$r1" ] && [ "$r1" = "$r2" ] && same_runner=yes
summary="runner id unchanged across both moves: $same_runner; move 1 (good guard) result $(jq -r .result <<<"$m1" 2>/dev/null): $c1 closed, $o1 open probes; move 2 (failing guard) result $(jq -r .result <<<"$m2" 2>/dev/null): $n_closed closed, $n_open open probes; release-current unchanged by move 2: $([ "$(jq -c .releaseCurrent <<<"$m2" 2>/dev/null)" = "$rel1" ] && echo yes || echo no)$(cat "$T/diag" 2>/dev/null)"
noticed=1
if [ "$fail" = 0 ]; then
  echo "::notice title=BOS-2528 helper move::PASS, $oks ok lines, none failed: $summary"
else
  echo "::error title=BOS-2528 helper move::FAIL after $oks ok lines (see the FAIL lines in the job log): $summary"
fi
exit "$fail"
