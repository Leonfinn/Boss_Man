#!/usr/bin/env bash
# update-runner.sh against a fake docker: the default asks Boss Man to drain and recreates nothing;
# --now recreates every runner at once; a failed canary changes nothing. Run: scripts/update-runner.test.sh
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
fail() { echo "FAIL: $*"; exit 1; }
mkdir "$T/bin" "$T/repo" "$T/deployer" "$T/deployer/inbox"
cat >"$T/bin/docker" <<'FAKE'
#!/usr/bin/env bash
echo "docker $*" >>"$FAKE_LOG"
case "$*" in
  "run --rm"*) exit "${CANARY_RC:-0}" ;;
  "image inspect --format"*) echo sha256:oldguard ;;
  "ps -q"*) [[ ${HAVE_LAUNCHER:-1} == 1 ]] && echo launcher-1 || true ;;
esac
FAKE
chmod +x "$T/bin/docker"
cp "$here/update-runner.sh" "$T/repo/"
export PATH="$T/bin:$PATH" FAKE_LOG="$T/docker.log" BOSSMAN_DEPLOYER="$T/deployer" COMPOSE_PROFILES=launcher
cd "$T/repo"
run() { : >"$FAKE_LOG"; rm -f "$T/deployer/inbox/drain.json"; ./update-runner.sh "$@" >"$T/out" 2>&1; }
logged() { grep -qF -- "$1" "$FAKE_LOG"; }

# Default: image promoted, drain requested, no runner touched, and the launcher rebuilt (BOS-335).
run
logged "docker tag boss-man-runner:candidate boss-man-runner:current" || fail "image not promoted"
logged "docker tag sha256:oldguard boss-man-netguard:pending-previous" || fail "the old network guard was not held before the build (BOS-1417)"
logged "docker tag boss-man-netguard:pending-previous boss-man-netguard:previous" || fail "the previous network guard image was not kept"
logged "recreate-all" && fail "default recreated the runners"
logged "compose up -d --no-build" && fail "default restarted compose runners"
logged "docker compose build launcher" || fail "default did not rebuild the launcher"
logged "compose up -d --no-deps launcher" || fail "default did not recreate the launcher"
[[ -s $T/deployer/inbox/drain.json ]] || fail "no drain request written"
node -e 'JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"))' "$T/deployer/inbox/drain.json" || fail "drain.json is not JSON"
[[ $(find "$T/deployer/inbox" -type f | wc -l) == 1 ]] || fail "temp file left in the inbox"

# A symlink planted at the request's name (the server can write to inbox) is replaced, never followed.
# Also at the temp names a PID-based writer would use, since the next process IDs are guessable.
echo "precious" >"$T/victim"
rm -f "$T/deployer/inbox/drain.json"; ln -s "$T/victim" "$T/deployer/inbox/drain.json"
# shellcheck disable=SC2016 # the node script's ${dir} is JavaScript, not shell
node -e 'const fs=require("fs");const [tgt,dir]=process.argv.slice(1);for(let p=process.pid;p<process.pid+400;p++){try{fs.symlinkSync(tgt,`${dir}/.drain.${p}.tmp`)}catch(e){}}' "$T/victim" "$T/deployer/inbox"
: >"$FAKE_LOG"; ./update-runner.sh >"$T/out" 2>&1
[[ $(cat "$T/victim") == precious ]] || fail "the drain request followed a planted symlink"
[[ -f $T/deployer/inbox/drain.json && ! -L $T/deployer/inbox/drain.json ]] || fail "the planted symlink was not replaced"
find "$T/deployer/inbox" -name '.drain.*' -delete

# --now: the old behaviour, immediately, and no drain request.
run --now
logged "exec launcher-1 node dist/main.js recreate-all" || fail "--now did not recreate the runners"
[[ ! -e $T/deployer/inbox/drain.json ]] || fail "--now asked for a drain"

# No deployer folder (manual run): tells the owner where to start the drain, recreates nothing.
saved="$BOSSMAN_DEPLOYER"; unset BOSSMAN_DEPLOYER
run
grep -qF "Settings > Server and runner > Updates > Update runners (finish runs first)" "$T/out" || fail "no manual instructions"
logged "recreate-all" && fail "manual run recreated the runners"
# ...unless .env names the deployer folder, which is how a hand run finds it.
echo "BOSSMAN_DEPLOYER=$saved" >.env
run
[[ -s $T/deployer/inbox/drain.json ]] || fail "a hand run did not find the deployer folder in .env"
rm .env
export BOSSMAN_DEPLOYER="$saved"

# No launcher: nothing to drain onto, so it restarts at once and says so.
HAVE_LAUNCHER=0 run
grep -q "no launcher" "$T/out" || fail "no warning without a launcher"
logged "compose up -d --no-build" || fail "no restart without a launcher"
[[ ! -e $T/deployer/inbox/drain.json ]] || fail "drain asked for without a launcher"

# Rollback drains too; --now makes it immediate.
run --rollback
logged "docker tag boss-man-runner:previous boss-man-runner:current" || fail "rollback did not retag"
logged "docker tag boss-man-netguard:previous boss-man-netguard:current" || fail "rollback did not restore the network guard"
[[ -s $T/deployer/inbox/drain.json ]] || fail "rollback did not ask for a drain"
logged "recreate-all" && fail "rollback recreated at once"
run --rollback --now
logged "recreate-all" || fail "rollback --now did not recreate"

# --settings (BOS-594): no build, the launcher re-reads .env, and a drain marked "setting change"; no runner touched.
run --settings
logged "docker build" && fail "--settings built an image"
logged "compose up -d --no-deps launcher" || fail "--settings did not recreate the launcher"
logged "recreate-all" && fail "--settings recreated the runners at once"
node -e 'const j=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); if (j.reason !== "setting change") process.exit(1)' "$T/deployer/inbox/drain.json" || fail "--settings drain request does not say setting change"
# ...the image drain's request carries no reason, so the server treats it as an update as before.
run
node -e 'const j=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); if ("reason" in j) process.exit(1)' "$T/deployer/inbox/drain.json" || fail "an image update's drain request carries a reason"
# ...without a deployer folder it refuses and changes nothing (the Settings button would only drain onto a new image).
saved="$BOSSMAN_DEPLOYER"; unset BOSSMAN_DEPLOYER
if run --settings; then fail "--settings without a deployer folder succeeded"; fi
logged "compose up" && fail "--settings without a deployer folder touched the launcher"
export BOSSMAN_DEPLOYER="$saved"
# ...without a launcher there is nothing to drain onto: refuse unless --now.
if HAVE_LAUNCHER=0 run --settings; then fail "--settings without a launcher succeeded"; fi
logged "compose up" && fail "--settings without a launcher restarted something"
run --settings --now
logged "compose up -d --no-deps launcher" || fail "--settings --now did not recreate the launcher first"
logged "recreate-all" || fail "--settings --now did not recreate the runners"
[[ ! -e $T/deployer/inbox/drain.json ]] || fail "--settings --now asked for a drain"

# BOS-764 (QA, BOS-826): the image is stamped with the commit it is built from, so Boss Man can close a "Build and update runners"
# ask the image already satisfies. Outside a git checkout the stamp is empty (the runner then reports none) and the build still runs.
run
logged "--build-arg BOSSMAN_IMAGE_COMMIT= " || fail "a build outside a checkout did not pass an empty image commit: $(grep 'docker build --pull' "$FAKE_LOG")"
logged "docker tag boss-man-runner:candidate boss-man-runner:current" || fail "a build outside a checkout was not promoted"
git init -q . && git -c user.name=t -c user.email=t@t commit -q --allow-empty -m init
head="$(git rev-parse HEAD)"
run
logged "--build-arg BOSSMAN_IMAGE_COMMIT=$head " || fail "the build did not stamp the checkout's commit: $(grep 'docker build --pull' "$FAKE_LOG")"
# ...and the stamp is the 40-character sha the runner and the server both require.
[[ $head =~ ^[0-9a-f]{40}$ ]] || fail "the checkout commit is not a full sha: $head"

# BOS-1583: runner add-ons. Hand-set RUNNER_ADDONS in .env keeps working until the owner saves the tick boxes; the saved
# file (inbox/runner-addons, written by the server) then wins; what was built is recorded in outbox/runner-addons.built.
mkdir -p "$T/deployer/outbox"
echo "RUNNER_ADDONS=agent-browser" >>.env
run
logged "--build-arg RUNNER_ADDONS=agent-browser " || fail "RUNNER_ADDONS from .env was not built: $(grep 'docker build --pull' "$FAKE_LOG")"
[[ $(cat "$T/deployer/outbox/runner-addons.built") == agent-browser ]] || fail "the built add-ons were not recorded"
echo "webkit,agent-browser" >"$T/deployer/inbox/runner-addons"
run
logged "--build-arg RUNNER_ADDONS=webkit,agent-browser " || fail "the saved tick boxes did not win over .env"
[[ $(cat "$T/deployer/outbox/runner-addons.built") == webkit,agent-browser ]] || fail "the built record does not follow the saved choice"
# Everything unticked is a plain image, even with .env naming an add-on.
echo "" >"$T/deployer/inbox/runner-addons"
run
logged "--build-arg RUNNER_ADDONS= " || fail "an empty saved choice did not build the plain image"
# Anything that is not a plain id list (the server can write inbox) is ignored with a warning, never built or shell-expanded.
echo 'webkit;touch /tmp/x' >"$T/deployer/inbox/runner-addons"
run
logged "--build-arg RUNNER_ADDONS=agent-browser " || fail "a bad saved file was not ignored"
grep -q "not a plain list of add-on ids" "$T/out" || fail "no warning for a bad saved file"
# A symlink at the saved name is never followed.
rm -f "$T/deployer/inbox/runner-addons"; echo "webkit" >"$T/victim2"; ln -s "$T/victim2" "$T/deployer/inbox/runner-addons"
run
logged "--build-arg RUNNER_ADDONS=agent-browser " || fail "a symlinked saved file was followed"
rm -f "$T/deployer/inbox/runner-addons" "$T/deployer/outbox/runner-addons.built" .env

# A failed canary promotes nothing and asks for nothing.
if CANARY_RC=1 run; then fail "a failed canary succeeded"; fi
logged "docker tag boss-man-runner:candidate" && fail "a failed canary was promoted"
logged "boss-man-netguard:previous" && fail "a failed canary moved the network guard's :previous tag"
[[ ! -e $T/deployer/inbox/drain.json ]] || fail "a failed canary asked for a drain"
if ./update-runner.sh --bogus >/dev/null 2>&1; then fail "unknown flag accepted"; fi
echo "update-runner.test.sh: ok"
