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
  "ps -q"*) [[ ${HAVE_LAUNCHER:-1} == 1 ]] && echo launcher-1 || true ;;
esac
FAKE
chmod +x "$T/bin/docker"
cp "$here/update-runner.sh" "$T/repo/"
export PATH="$T/bin:$PATH" FAKE_LOG="$T/docker.log" BOSSMAN_DEPLOYER="$T/deployer" COMPOSE_PROFILES=launcher
cd "$T/repo"
run() { : >"$FAKE_LOG"; rm -f "$T/deployer/inbox/drain.json"; ./update-runner.sh "$@" >"$T/out" 2>&1; }
logged() { grep -qF -- "$1" "$FAKE_LOG"; }

# Default: image promoted, drain requested, no runner touched.
run
logged "docker tag boss-man-runner:candidate boss-man-runner:current" || fail "image not promoted"
logged "recreate-all" && fail "default recreated the runners"
logged "compose up" && fail "default restarted compose runners"
[[ -s $T/deployer/inbox/drain.json ]] || fail "no drain request written"
python3 -I -c 'import json,sys; json.load(open(sys.argv[1]))' "$T/deployer/inbox/drain.json" || fail "drain.json is not JSON"
[[ $(find "$T/deployer/inbox" -type f | wc -l) == 1 ]] || fail "temp file left in the inbox"

# --now: the old behaviour, immediately, and no drain request.
run --now
logged "exec launcher-1 node dist/main.js recreate-all" || fail "--now did not recreate the runners"
[[ ! -e $T/deployer/inbox/drain.json ]] || fail "--now asked for a drain"

# No deployer folder (manual run): tells the owner where to start the drain, recreates nothing.
saved="$BOSSMAN_DEPLOYER"; unset BOSSMAN_DEPLOYER
run
grep -q "Settings > Runner update" "$T/out" || fail "no manual instructions"
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
[[ -s $T/deployer/inbox/drain.json ]] || fail "rollback did not ask for a drain"
logged "recreate-all" && fail "rollback recreated at once"
run --rollback --now
logged "recreate-all" || fail "rollback --now did not recreate"

# A failed canary promotes nothing and asks for nothing.
if CANARY_RC=1 run; then fail "a failed canary succeeded"; fi
logged "docker tag boss-man-runner:candidate" && fail "a failed canary was promoted"
[[ ! -e $T/deployer/inbox/drain.json ]] || fail "a failed canary asked for a drain"
if ./update-runner.sh --bogus >/dev/null 2>&1; then fail "unknown flag accepted"; fi
echo "update-runner.test.sh: ok"
