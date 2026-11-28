#!/usr/bin/env bash
# Checks prune-build-cache.sh with a fake docker: the default age, a set age, off, a bad value, a failing docker
# (still exit 0), no docker at all, and that only `builder prune` is ever called.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
t="$(mktemp -d)"; trap 'rm -rf "$t"' EXIT
mkdir "$t/bin" "$t/empty"
cat >"$t/bin/docker" <<'FAKE'
#!/usr/bin/env bash
echo "docker $*" >>"$FAKE_LOG"
[[ ${FAKE_DOCKER:-ok} == ok ]] || { echo "daemon down" >&2; exit 1; }
echo "Total:  1.5GB"
FAKE
chmod +x "$t/bin/docker"
export FAKE_LOG="$t/log"
fail() { echo "FAIL: $*"; exit 1; }
run() { : >"$FAKE_LOG"; env -u BOSSMAN_BUILD_CACHE_KEEP_HOURS PATH="$t/bin:/usr/bin:/bin" "$@" bash "$here/prune-build-cache.sh"; }

out="$(run env)"
grep -qx 'docker builder prune --force --filter until=168h' "$FAKE_LOG" || fail "default is 7 days: $(cat "$FAKE_LOG")"
[[ $out == *"Total:  1.5GB"* ]] || fail "the total is shown: $out"
run env BOSSMAN_BUILD_CACHE_KEEP_HOURS=48 >/dev/null
grep -qx 'docker builder prune --force --filter until=48h' "$FAKE_LOG" || fail "set age used"
for v in 0 off; do
  run env BOSSMAN_BUILD_CACHE_KEEP_HOURS=$v >/dev/null
  [[ ! -s $FAKE_LOG ]] || fail "$v must not call docker"
done
run env BOSSMAN_BUILD_CACHE_KEEP_HOURS='7 days' >/dev/null 2>"$t/err" || fail "a bad value must not fail the caller"
[[ ! -s $FAKE_LOG ]] || fail "a bad value must not call docker"
grep -q 'whole number' "$t/err" || fail "a bad value is explained"
run env FAKE_DOCKER=fail >/dev/null 2>"$t/err" || fail "a docker failure must not fail the caller"
grep -q 'failed (ignored): daemon down' "$t/err" || fail "the failure is reported"
# No docker command at all (a PATH holding only the tools bash needs): skipped, exit 0.
env -u BOSSMAN_BUILD_CACHE_KEEP_HOURS PATH="$t/empty" "$(command -v bash)" "$here/prune-build-cache.sh" | grep -q 'no docker command' || fail "no docker is skipped"
echo "prune-build-cache: all ok"
