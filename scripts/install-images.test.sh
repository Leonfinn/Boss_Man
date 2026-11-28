#!/usr/bin/env bash
# Install test for docker-compose.images.yml (BOS-974).
#
# Without INSTALL_RELEASE_JSON (the merge check, scripts/test-shell.sh): the compose file is read, never started. It checks what makes
# the install "pull only": every image named by digest, nothing built, no host folder bound but the Docker socket, nothing
# on the host (openssl, chown, sudo) mentioned in the steps. Needs the docker CLI and compose plugin; skips with a message without them.
# The UPDATER_SPEC_ENV check (BOS-2921) runs before that skip: it reads the compose file and the updater's settings parser alone.
#
# With INSTALL_RELEASE_JSON=<release.json> (CI, on x86 and arm64 runners, and by hand on a host with Docker): the real install.
# It pulls the published images by digest, runs setup twice (the second run must change nothing), starts the stack under its own
# project name, waits for the server to answer, then asks the launcher to start a runner from the published runner image.
#   INSTALL_RELEASE_JSON=release.json INSTALL_REGISTRY=ghcr.io/<owner> scripts/install-images.test.sh
# At the end it removes the install the way docs/35-install-from-images.md "Start again from nothing" says (BOS-2803) and fails if any
# container labelled for its project, any runner or guard, or any <project>_ or pack volume remains. The runners and guards are found
# by the install label (BOS-2851), so the removal leaves another install's runners and guards alone.
# SC2015: ok and bad only print and set a flag, so "test && ok || bad" cannot run both. SC2317: cleanup runs from the EXIT trap.
# shellcheck disable=SC2015,SC2317
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.." || exit 1
fail=0
ok() { echo "ok   $1"; }
bad() { echo "FAIL $1"; fail=1; }

command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1 || { echo "skip: no docker CLI with the compose plugin"; exit 0; }
command -v jq >/dev/null 2>&1 || { echo "skip: no jq"; exit 0; }
T="$(mktemp -d)"
trap 'rm -rf "$T"' EXIT
unset COMPOSE_FILE COMPOSE_PROFILES COMPOSE_PROJECT_NAME

D="sha256:$(printf 'a%.0s' {1..64})"
cat > "$T/images.env" <<EOF
BOSSMAN_REGISTRY=registry.invalid/me
BOSSMAN_SERVER_DIGEST=$D
BOSSMAN_LAUNCHER_DIGEST=$D
BOSSMAN_NETGUARD_DIGEST=$D
BOSSMAN_RUNNER_DIGEST=$D
BOSSMAN_UPDATER_DIGEST=$D
BOSSMAN_UPDATER_REPO=example/boss-man
EOF

# ---- Static checks: always run ----
cfg="$(docker compose --env-file "$T/images.env" --profile '*' -f docker-compose.images.yml config --format json 2>&1)" || { echo "$cfg"; bad "compose file is valid"; exit 1; }
# Every service made by Boss Man is a digest; the one outside image (the database) is a pinned tag.
unpinned="$(echo "$cfg" | jq -r '.services | to_entries[] | select(.key != "db") | select(.value.image | test("@sha256:[0-9a-f]{64}$") | not) | .key')"
[ -z "$unpinned" ] && ok "every Boss Man image is pulled by digest" || bad "not pinned by digest: $unpinned"
echo "$cfg" | jq -e '.services.db.image | test(":[0-9]")' >/dev/null && ok "the database image is pinned to a version" || bad "database image not pinned"
echo "$cfg" | jq -e '[.services[] | has("build")] | any | not' >/dev/null && ok "nothing is built" || bad "a service has a build section"
# The only folder from the host is the Docker socket; everything else is a named volume.
hostbinds="$(echo "$cfg" | jq -r '.services[].volumes[]? | select(.type == "bind") | .source' | sort -u)"
[ "$hostbinds" = "/var/run/docker.sock" ] && ok "the only host path is the Docker socket" || bad "host paths bound: $hostbinds"
sock="$(BOSSMAN_DOCKER_SOCK=/run/user/1000/docker.sock docker compose --env-file "$T/images.env" -f docker-compose.images.yml config --format json | jq -r '.services.updater.volumes[] | select(.target == "/var/run/docker.sock") | .source')"
[ "$sock" = "/run/user/1000/docker.sock" ] && ok "BOSSMAN_DOCKER_SOCK picks the socket" || bad "socket setting: $sock"
echo "$cfg" | jq -e '.services.setup.network_mode == "none" and (.services.setup.cap_add == ["CHOWN"])' >/dev/null && ok "setup has no network and one capability" || bad "setup is not locked down"
echo "$cfg" | jq -e '[.services.setup.volumes[] | select(.target == "/updater-key")] | length == 1' >/dev/null && ok "setup makes the updater's key" || bad "setup does not mount the updater key volume"
echo "$cfg" | jq -e '.services.updater.cap_add == ["SETGID","SETUID"] or .services.updater.cap_add == ["SETUID","SETGID"]' >/dev/null && ok "the updater keeps only SETUID and SETGID" || bad "updater capabilities"
# BOS-1227 (941c): compose owns the database, the proxy, the updater and setup, and nothing else. A server or launcher service here
# would let `docker compose up` bring an old one back beside the updater's, which is the fight the design rules out.
svcs="$(echo "$cfg" | jq -r '.services | keys | join(" ")')"
[ "$svcs" = "db proxy setup updater" ] && ok "compose runs only the database, the proxy, the updater and setup" || bad "services in compose: $svcs"
echo "$cfg" | jq -e '(.services.proxy.ports | length) == 2 and (.services.proxy.networks.front.ipv4_address != null)' >/dev/null && ok "the proxy owns the ports" || bad "proxy ports"
# The updater builds the first server colour and the launcher from its own settings: they must name the release's digests, and the
# runner and guard images must not be in the launcher's environment list (the updater sets them from the release).
fd="$(echo "$cfg" | jq -r '.services.updater.environment | [.UPDATER_FIRST_SERVER_DIGEST, .UPDATER_FIRST_LAUNCHER_DIGEST, .UPDATER_FIRST_RUNNER_DIGEST, .UPDATER_FIRST_NETGUARD_DIGEST] | unique | join(" ")')"
[ "$fd" = "$D" ] && ok "the updater's first-start digests are the images.env digests" || bad "first-start digests: $fd"
echo "$cfg" | jq -r '.services.updater.environment.UPDATER_LAUNCHER_ENV' | grep -Eq '^BOSSMAN_(RUNNER|NETGUARD)_IMAGE=' && bad "UPDATER_LAUNCHER_ENV sets a runner or guard image" || ok "the launcher's runner and guard images come from the release, not the environment list"
echo "$cfg" | jq -r '.services.updater.environment.UPDATER_LAUNCHER_MOUNTS' | grep -q ':/run/release:ro$' && ok "the launcher sees release-current read-only" || bad "launcher release mount"
echo "$cfg" | jq -r '.services.updater.environment.UPDATER_SELF_MOUNTS' | grep -q 'launcher-key:/run/launcher:ro$' && ok "the next updater keeps the launcher key (read-only)" || bad "self mounts miss the launcher key"
# No host tools in the compose file's own steps (comments excluded).
if grep -v '^[[:space:]]*#' docker-compose.images.yml | grep -Eq '\b(openssl|sudo|chown|stat -c)\b'; then bad "compose file uses host tools"; else ok "no host openssl, chown, stat or sudo"; fi
[ -f docs/35-install-from-images.md ] && ok "the install guide exists" || bad "docs/35-install-from-images.md is missing"
# BOS-2803: the guide's removal steps, in order (the real half's cleanup runs the same commands for its own project).
# BOS-2851: the runners and guards are found by the install label; for older unlabelled ones (made before BOS-2803) the guide lists
# them by inspecting each container's install label, because Docker has no "no label" filter — `--filter label=com.bossman.install`
# (with no value) would match every labelled container, including a second install's. Checked in both guides: the docs and the website's.
guide_cmds=('--filter label=com.bossman.install=boss-man | xargs -r docker rm -f' '--filter label=com.bossman.install=boss-man --filter label=boss-man.launcher=1 | xargs' '--filter label=com.bossman.install=boss-man --filter label=boss-man.netguard=1 | xargs' 'docker ps -aq --filter label=boss-man.launcher=1 | xargs -r docker inspect -f' 'docker ps -aq --filter label=boss-man.netguard=1 | xargs -r docker inspect -f' 'down -v --remove-orphans' 'docker volume ls -q --filter label=com.bossman.install=boss-man' 'docker volume ls -q --filter name=boss-man-claude-pack' 'docker volume ls -q --filter name=^boss-man_ | xargs')
for guide in docs/35-install-from-images.md apps/site/src/guides/install-boss-man.md; do
  [ -f "$guide" ] || { bad "$guide is missing"; continue; }
  prev=0; order_ok=1
  for c in "${guide_cmds[@]}"; do
    n="$(grep -nF -- "$c" "$guide" | head -1 | cut -d: -f1)"
    { [ -n "$n" ] && [ "$n" -gt "$prev" ]; } && prev="$n" || { order_ok=0; echo "$guide: step missing or out of order: $c"; }
  done
  [ "$order_ok" = 1 ] && ok "$guide removes this install's containers, runners and guards by the install label, then lists unlabelled ones, then down -v, then the pack volume" || bad "$guide: the removal steps are missing or out of order"
  # BOS-2851: no label-without-value filter. `--filter label=com.bossman.install` matches every labelled container (any value), so it
  # cannot single out unlabelled ones; it would remove a second install's runners and guards. The guide must label-inspect instead.
  if grep -qF -- '--filter label=com.bossman.install ' "$guide" || grep -qE -- '--filter label=com\.bossman\.install([^=]|$)' "$guide"; then bad "$guide uses a label-exists filter (label=com.bossman.install with no value), which matches every labelled container"; else ok "$guide never uses a label-without-value install filter"; fi
  # BOS-2851: the "remove from a host that runs only this install" caveat is gone; another install on the host is untouched.
  if grep -qF 'runs only this install' "$guide" || grep -qF 'runs just this install' "$guide"; then bad "$guide still says to remove only from a host that runs only this install"; else ok "$guide drops the 'runs only this install' caveat"; fi
done
echo "$cfg" | jq -r '.services.updater.environment.UPDATER_LAUNCHER_ENV' | grep -q '^BOSSMAN_INSTALL_LABEL=com.bossman.install=' && ok "the launcher gets the install label to stamp on runners, guards and the pack volume" || bad "UPDATER_LAUNCHER_ENV lacks BOSSMAN_INSTALL_LABEL"
# BOS-2788: docker-compose.images.yml is not a default Compose file name, so every guide step that runs compose with images.env must
# pass -f docker-compose.images.yml, as this test does. Both guides are read; a step with --env-file images.env and no -f fails.
for guide in docs/35-install-from-images.md apps/site/src/guides/install-boss-man.md; do
  [ -f "$guide" ] || { bad "$guide is missing"; continue; }
  nof="$(grep -n 'docker compose .*--env-file images\.env' "$guide" | grep -v -- '-f docker-compose\.images\.yml' || true)"
  [ -z "$nof" ] && ok "$guide: every image-install compose command names -f docker-compose.images.yml" || bad "$guide: compose command without -f docker-compose.images.yml: $nof"
done

# BOS-2796: the compose file's own usage comment and the launcher's guard-missing message show the same command.
for f in docker-compose.images.yml apps/launcher/src/launcher.ts; do
  nof="$(grep -n 'docker compose .*--env-file images\.env' "$f" | grep -v -- '-f docker-compose\.images\.yml' || true)"
  [ -z "$nof" ] && ok "$f: every image-install compose command names -f docker-compose.images.yml" || bad "$f: compose command without -f docker-compose.images.yml: $nof"
done

# BOS-2388: the real install half below only runs with a Docker daemon and INSTALL_RELEASE_JSON, so a workflow that builds its
# test release.json by hand can drift from what the install needs and only GitHub notices. Check the contract here, with no daemon:
#  1. every image scripts/render-image-env.sh requires is in the list the .github/workflows/ci.yml install step puts in release.json;
#  2. a release.json built from that list renders through scripts/render-image-env.sh, in the environment test-shell.sh gives the
#     real half (no GITHUB_REPOSITORY), and docker-compose.images.yml accepts the result (a required variable left unset fails here).
# The images the workflow lists are read from its "for pair in name:boss-man-name:tag ..." loop; the ones the script requires from
# its "for image in ...; do" loop. Decision (BOS-2388): publish.yml and release.yml are not checked this way. Their image list is
# the owner's PUBLISH_IMAGES variable (default in scripts/publish-images.sh is smaller than the install needs, on purpose), which a
# static check cannot read; render-image-env.sh already refuses such a release by name and says to add the image to PUBLISH_IMAGES.
# Either one not found is a failure, not a pass: the check must not go quiet when a file is reshaped.
need="$(sed -n 's/^for image in \(.*\); do$/\1/p' scripts/render-image-env.sh | tr ' ' '\n' | grep -E '^[a-z]+$' | sort -u)"
have="$(grep -E 'for pair in .*boss-man-' .github/workflows/ci.yml | tr ' ' '\n' | grep -oE '^[a-z]+:boss-man-[a-z]+:' | cut -d: -f1 | sort -u)"
if [ -z "$need" ] || [ -z "$have" ]; then
  bad "could not read the image lists (scripts/render-image-env.sh 'for image in ...; do' gave '${need//$'\n'/ }', .github/workflows/ci.yml 'for pair in ...' gave '${have//$'\n'/ }')"
else
  missing="$(comm -23 <(echo "$need") <(echo "$have") | sed 's/^/boss-man-/' | tr '\n' ' ')"
  [ -z "$missing" ] && ok "the CI install step's release.json lists every image render-image-env.sh requires" \
    || bad "the CI install step (.github/workflows/ci.yml) builds release.json without: ${missing% } (scripts/render-image-env.sh requires them)"
  imgs=""
  for n in $have; do imgs="$imgs${imgs:+,}{\"name\":\"boss-man-$n\",\"digest\":\"$D\"}"; done
  echo "{\"schema\":1,\"version\":\"ci\",\"registries\":[\"registry.invalid/ci\"],\"images\":[$imgs]}" > "$T/ci-release.json"
  # BOS-1227: the updater's compose needs BOSSMAN_UPDATER_REPO, which render-image-env.sh writes only from GITHUB_REPOSITORY (set on
  # GitHub's runners and by the real half below, which defaults it the same way), so the render gets a made-up one here.
  if env -u GITHUB_REPOSITORY_OWNER GITHUB_REPOSITORY=example/boss-man scripts/render-image-env.sh "$T/ci-release.json" > "$T/ci-images.env" 2> "$T/ci-render.err"; then
    if env -u GITHUB_REPOSITORY -u GITHUB_REPOSITORY_OWNER docker compose --env-file "$T/ci-images.env" --profile '*' -f docker-compose.images.yml config -q 2> "$T/ci-compose.err"; then
      ok "a release.json built like the CI install step renders and docker-compose.images.yml accepts it"
    else
      bad "docker-compose.images.yml refuses the images.env rendered from the CI install step's release.json: $(tr '\n' ' ' < "$T/ci-compose.err")"
    fi
  else
    bad "scripts/render-image-env.sh refuses a release.json built like the CI install step: $(tr '\n' ' ' < "$T/ci-render.err")"
  fi
fi

# BOS-2921: the compose file's UPDATER_SPEC_ENV block is a contract with the updater, which refuses some keys there because it sets
# them for each colour from the release. BOS-2817 added BOSSMAN_IMAGE_INSTALL to the block; the updater then refused to start, and
# only the real-install half (a Docker daemon) noticed, so GitHub run 46003749123 was the first to see it. Checked here, with no
# daemon or Docker CLI, by running the updater's real config parser (apps/updater/src/config.ts) on the block: no second copy of the
# refused keys can drift. apps/updater/scripts/spec-env-refused.mjs does that; this only runs it on the compose file and a broken copy.
# GitHub CI runs this test's no-daemon half on every branch; that is what the fix asks for, and the full check runs the tip's copy.
if [ -x "$(command -v node)" ]; then
  rrc=0; rout="$(node apps/updater/scripts/spec-env-refused.mjs docker-compose.images.yml 2>&1)" || rrc=$?
  if [ "$rrc" -eq 0 ]; then ok "the updater accepts docker-compose.images.yml's UPDATER_SPEC_ENV block"
  elif [ "$rrc" -eq 1 ]; then bad "the updater refuses docker-compose.images.yml's UPDATER_SPEC_ENV block: ${rout#REFUSED }"
  else bad "could not check docker-compose.images.yml's UPDATER_SPEC_ENV block against the updater: $rout"; fi
  # The check must catch a refused key; a copy that has one more line it must refuse proves it does, not just says ok.
  awk '/^[[:space:]]*UPDATER_SPEC_ENV: *\|/ { print; print "        BOSSMAN_IMAGE_INSTALL=1"; next } { print }' \
    docker-compose.images.yml > "$T/spec-env-bad.yml"
  rrc=0; rout="$(node apps/updater/scripts/spec-env-refused.mjs "$T/spec-env-bad.yml" 2>&1)" || rrc=$?
  if [ "$rrc" -eq 1 ] && [[ "$rout" == *BOSSMAN_IMAGE_INSTALL* ]]; then ok "the UPDATER_SPEC_ENV check names BOSSMAN_IMAGE_INSTALL on a copy with it set"
  else bad "the UPDATER_SPEC_ENV check missed BOSSMAN_IMAGE_INSTALL on a copy with it set (exit $rrc): $rout"; fi
else bad "no node to check docker-compose.images.yml's UPDATER_SPEC_ENV block against the updater"; fi

# ---- The real install ----
if [ -z "${INSTALL_RELEASE_JSON:-}" ]; then
  echo "skip: real install (set INSTALL_RELEASE_JSON to run it)"
  exit "$fail"
fi
docker info >/dev/null 2>&1 || { bad "INSTALL_RELEASE_JSON is set but there is no Docker daemon"; exit 1; }
# test-shell.sh scrubs the environment, so GITHUB_REPOSITORY is not set here; the updater's compose needs BOSSMAN_UPDATER_REPO.
GITHUB_REPOSITORY="${GITHUB_REPOSITORY:-example/boss-man}" scripts/render-image-env.sh "$INSTALL_RELEASE_JSON" ${INSTALL_REGISTRY:+"$INSTALL_REGISTRY"} > "$T/real.env" || { bad "images.env from release.json"; exit 1; }
P="bminstall$$"
{
  cat "$T/real.env"
  # The updater only starts on a release number like 0.1.0 or 0.1.0-beta.1; the CI release.json says "ci". Later lines win.
  echo "BOSSMAN_VERSION=0.0.0-install"
  echo "BOSSMAN_HOST_PORT=${INSTALL_HOST_PORT:-31100}"
  echo "BOSSMAN_PORTAL_HOST_PORT=${INSTALL_PORTAL_PORT:-31101}"
  echo "BOSSMAN_RUNNER_NETWORK=${P}_default"
} > "$T/run.env"
dc() { docker compose -p "$P" --env-file "$T/run.env" -f docker-compose.images.yml --profile images "$@"; }
# BOS-2803: removal follows the guide's "Start again from nothing" (docs/35-install-from-images.md) step for step, then checks nothing is
# left. The updater and the launcher made containers compose does not know; they hold the volumes, so they go before `down -v`.
# BOS-2851: runners and guards are found by this project's install label, so another install on the host is left alone. For older
# unlabelled ones (made before BOS-2803), Docker has no "no label" filter — `--filter label=com.bossman.install` matches every labelled
# container, a second install's too — so the guide lists them by inspecting each one's install label and the test helps only with the
# id listing below. The test still refuses to start where unlabelled runners or guards exist (INSTALL_ALLOW_SHARED_HOST=1 overrides,
# and then it accepts that a shared host's unlabelled ones may be removed, since nothing labels them to tell them apart).
# unlabelled_ids <launcher|netguard label>: ids of containers with that label whose install label is empty, as the guide's inspect shows.
unlabelled_ids() { docker ps -aq --filter "label=$1" | xargs -r docker inspect -f '{{if not (index .Config.Labels "com.bossman.install")}}{{.Id}}{{end}}'; }
if [ -z "${INSTALL_ALLOW_SHARED_HOST:-}" ] && [ -n "$(unlabelled_ids boss-man.launcher=1; unlabelled_ids boss-man.netguard=1)" ]; then
  bad "this host already has unlabelled Boss Man runners or guards (made before the install label), and the guide's removal lists them as this install's (set INSTALL_ALLOW_SHARED_HOST=1 to allow)"; exit 1
fi
# A second install's runner survives this install's removal: make two fake labelled containers, remove only this project's, and check
# the other is still there. Uses the guide's own label filter, so it fails if the filter ever widens to every labelled container.
# Output is logged, not hidden, so a failure here says what docker said.
if docker image inspect busybox >"$T/second.log" 2>&1 || docker pull -q busybox >>"$T/second.log" 2>&1; then
  other="${P}_other"
  if docker run -d --name "${P}_keep" --label com.bossman.install="$other" --label boss-man.launcher=1 busybox sleep 60 >>"$T/second.log" 2>&1 \
    && docker run -d --name "${P}_mine" --label com.bossman.install="$P" --label boss-man.launcher=1 busybox sleep 60 >>"$T/second.log" 2>&1; then
    docker ps -aq --filter "label=com.bossman.install=$P" --filter label=boss-man.launcher=1 | xargs -r docker rm -f >>"$T/second.log" 2>&1
  fi
  keep="$(docker ps -aq --filter name="${P}_keep")"
  mine="$(docker ps -aq --filter name="${P}_mine")"
  if [ -n "$keep" ] && [ -z "$mine" ]; then
    ok "removal by the install label leaves a second install's runner and removes only this install's"
  else bad "removal by the install label did not leave a second install's runner alone"; fi
  docker rm -f "${P}_keep" "${P}_mine" >>"$T/second.log" 2>&1 || true
else ok "second-install survival test skipped (no busybox image and could not pull one)"; fi
guide_removal() {
  # Output goes to a log file, not away: the listings after this step are what fail the test, and the log says why.
  {
    docker ps -aq --filter "label=com.bossman.install=$P" | xargs -r docker rm -f
    docker ps -aq --filter "label=com.bossman.install=$P" --filter label=boss-man.launcher=1 | xargs -r docker rm -f
    docker ps -aq --filter "label=com.bossman.install=$P" --filter label=boss-man.netguard=1 | xargs -r docker rm -f
    # The guide's handling of older unlabelled runners and guards: list them by inspecting each one's install label, then the operator
    # removes the ones that are this install's. Here every unlabelled one on the host is this install's (the guard above refused to start
    # otherwise, unless INSTALL_ALLOW_SHARED_HOST was set), so the test removes the unlabelled ones it listed.
    unlabelled_ids boss-man.launcher=1 | xargs -r docker rm -f
    unlabelled_ids boss-man.netguard=1 | xargs -r docker rm -f
  } >> "$T/removal.log" 2>&1
  dc down -v --remove-orphans > "$T/down.log" 2>&1
  {
    docker volume ls -q --filter "label=com.bossman.install=$P" | xargs -r docker volume rm
    docker volume ls -q --filter name=boss-man-claude-pack | xargs -r docker volume rm
    # Compose left config and data behind in CI (nothing mounted them); the guide's last removal takes what is named for the project.
    docker volume ls -q --filter "name=^${P}_" | xargs -r docker volume rm
  } >> "$T/removal.log" 2>&1
}
cleanup() {
  rc=$?
  guide_removal
  # The guide's two look-only listings, plus this install's runners and guards (by its label), plus any unlabelled one: all must be empty.
  left_c="$(docker ps -a --format '{{.Names}}' --filter "label=com.bossman.install=$P"; docker ps -a --format '{{.Names}}' --filter label=boss-man.launcher=1 --filter "label=com.bossman.install=$P"; unlabelled_ids boss-man.launcher=1; docker ps -a --format '{{.Names}}' --filter label=boss-man.netguard=1 --filter "label=com.bossman.install=$P"; unlabelled_ids boss-man.netguard=1)"
  left_v="$(docker volume ls -q --filter "name=${P}_"; docker volume ls -q --filter "label=com.bossman.install=$P"; docker volume ls -q --filter name=boss-man-claude-pack)"
  if [ -n "$left_c$left_v" ]; then
    bad "removal left behind (containers: ${left_c//$'\n'/ }; volumes: ${left_v//$'\n'/ })"
    # Say why: the output of down, every container left on the host with its labels, and who still mounts each leftover volume.
    echo "--- down -v said: $(tail -n 12 "$T/down.log" 2>&1 | tr '\n' ';' | cut -c1-600)"
    echo "--- containers left: $(docker ps -a --format '{{.Names}} {{.Status}} {{.Label "com.bossman.install"}}' | tr '\n' ';' | cut -c1-600)"
    for v in $left_v; do echo "--- volume $v used by: $(docker ps -a --filter "volume=$v" --format '{{.Names}}' | tr '\n' ' ')"; done
  else ok "the guide's removal left no container and no volume behind"; fi
  rm -rf "$T"
  [ "$rc" -eq 0 ] || exit "$rc"
  exit "$fail"
}
trap cleanup EXIT

dc pull -q || { bad "pull by digest"; exit 1; }
ok "images pulled by digest ($(uname -m))"
dc run --rm setup > "$T/setup1.log" 2>&1 || { cat "$T/setup1.log"; bad "setup, first run"; exit 1; }
grep -q 'Created master.key' "$T/setup1.log" && ok "setup created the keys" || bad "setup output: $(cat "$T/setup1.log")"
# Read the files as uid 1000, the server's user (root without capabilities cannot read them), and compare only a hash.
limg="$(grep '^BOSSMAN_REGISTRY=' "$T/run.env" | cut -d= -f2)/boss-man-launcher@$(grep '^BOSSMAN_LAUNCHER_DIGEST=' "$T/run.env" | cut -d= -f2)"
sums() { docker run --rm --network none --user 1000:1000 -v "${P}_config:/c:ro" -v "${P}_db-secret:/d:ro" --entrypoint sh "$limg" -c 'cat /c/master.key /d/db_password' | sha256sum; }
sum1="$(sums)"
[ "$sum1" != "$(printf '' | sha256sum)" ] && ok "uid 1000 can read both key files" || bad "uid 1000 cannot read the key files"
dc run --rm setup > "$T/setup2.log" 2>&1 || { cat "$T/setup2.log"; bad "setup, second run"; exit 1; }
sum2="$(sums)"
grep -q 'Created' "$T/setup2.log" && bad "the second setup created something" || ok "the second setup run changed nothing"
[ "$sum1" = "$sum2" ] && ok "key files are identical after the second run" || bad "key files changed"

dc up -d || { dc logs --tail 40; bad "up"; exit 1; }
# Wait for the event (the server answering), with a deadline: a cold pull-and-migrate can take minutes on a slow runner.
deadline=$((SECONDS + ${INSTALL_WAIT_SECONDS:-300}))
until curl -fsS "http://127.0.0.1:${INSTALL_HOST_PORT:-31100}/api/health" >/dev/null 2>&1; do
  [ "$SECONDS" -lt "$deadline" ] || { docker ps -a --format '{{.Names}} {{.Status}}' | tr '\n' ';'; echo; for c in updater launcher server-blue; do echo "--- $c"; docker logs --tail 12 "$c" 2>&1 | cut -c1-260; done; bad "the server did not answer /api/health in time"; exit 1; }
  sleep 3
done
ok "the server answers /api/health"
# BOS-1488: the time from this script's first command (SECONDS counts from its start) to /api/health answering. The Install
# test workflow reads it for the release's result; nothing else needs it.
[ -z "${INSTALL_SECONDS_FILE:-}" ] || echo "$SECONDS" > "$INSTALL_SECONDS_FILE"

launcher_log="$(docker logs launcher 2>&1)"
# The first server can answer while the launcher is missing (the updater makes the launcher first, and logs why it could not): show that.
docker inspect launcher >/dev/null 2>&1 || { echo "--- the launcher does not exist; updater log:"; docker logs --tail 15 updater 2>&1 | cut -c1-400; }
echo "$launcher_log" | grep -q 'dropped to uid 1000' && ok "the launcher dropped to uid 1000 with the socket's group" || bad "launcher privileges: $launcher_log"
echo "$launcher_log" | grep -q '"msg":"data folder"' && ok "the launcher found its data volume on the host" || bad "launcher data folder"
echo "$launcher_log" | grep -q 'launcher listening' && ok "the launcher is up and can reach Docker" || bad "launcher not listening"

# Ask the launcher, from inside its container, to start a runner from the published runner image (it will not get a real token, so it cannot connect; starting is the point).
tok="bmr_$(printf 'x%.0s' {1..43})"
call() { docker exec --user 1000:1000 launcher node -e '
const fs=require("fs");const [m,p,b]=process.argv.slice(1);
fetch("http://127.0.0.1:3105"+p,{method:m,headers:{authorization:"Bearer "+fs.readFileSync("/run/launcher/key","utf8").trim(),"content-type":"application/json"},body:b||undefined})
 .then(async r=>{console.log(r.status+" "+await r.text());process.exit(r.status<300?0:1)}).catch(e=>{console.log(String(e));process.exit(1)})' "$@"; }
out="$(call PUT /runners/smoke "{\"token\":\"$tok\"}" 2>&1)" && ok "the launcher started a runner from the published image" || bad "runner start: $out"
img="$(docker inspect --format '{{.Config.Image}}' boss-man-runner-smoke 2>/dev/null)"
want="$(grep '^BOSSMAN_REGISTRY=' "$T/run.env" | cut -d= -f2)/boss-man-runner@$(grep '^BOSSMAN_RUNNER_DIGEST=' "$T/run.env" | cut -d= -f2)"
[ "$img" = "$want" ] && ok "the runner runs the digest from release.json" || bad "runner image is '$img', wanted '$want'"
# BOS-2528 (BOS-1227 criterion 4): with INSTALL_HELPER_MOVE=1 the live stack is used once more, before the runner is removed: the updater's
# helper move recreates the launcher while this runner lives, then a move whose guard fails its check changes nothing. Needs a registry
# that takes pushes (CI's local one); see scripts/helper-move-live.sh.
#   Default: on when the registry is a local one (localhost or 127.0.0.1, which CI's is, and which takes pushes). It is on by default so the
#   proof also runs on GitHub's pre-review run, which uses main's workflow file with this branch's scripts. INSTALL_HELPER_MOVE=0 turns it
#   off; INSTALL_HELPER_MOVE=1 forces it for another registry that takes pushes.
reg_host="$(grep '^BOSSMAN_REGISTRY=' "$T/run.env" | cut -d= -f2)"
case "${INSTALL_HELPER_MOVE:-auto}:$reg_host" in
  0:*) run_move=0 ;;
  auto:localhost:*|auto:127.0.0.1:*|auto:localhost/*|auto:127.0.0.1/*) run_move=1 ;;
  auto:*) run_move=0 ;;
  *) run_move=1 ;;
esac
if [ "$run_move" = 1 ]; then
  echo "--- helper move on the live stack (BOS-1227 criterion 4)"
  scripts/helper-move-live.sh "$P" "$T/run.env" || bad "helper move on the live stack"
fi
call DELETE /runners/smoke >/dev/null 2>&1 || true
exit "$fail"
