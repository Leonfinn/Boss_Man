#!/usr/bin/env bash
# rebuild-live.sh against a fake docker: it rebuilds the colour the proxy names, signals it, and waits
# until it leads at the checkout's commit; a failed build stops before anything restarts; a server
# that stays on standby is asked again and the script fails loudly. Run: scripts/rebuild-live.test.sh
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
fail() { echo "FAIL: $*"; cat "$T/out" 2>/dev/null; exit 1; }
mkdir -p "$T/bin" "$T/repo/scripts" "$T/deployer/proxy" "$T/backups"
cat >"$T/bin/docker" <<'FAKE'
#!/usr/bin/env bash
echo "docker $*" >>"$FAKE_LOG"
case "$*" in
  *"pg_dump"*) echo "-- dump" ;;
  *"compose build"*) exit "${BUILD_RC:-0}" ;;
  *"kill -s SIGUSR2"*) echo "$(($(cat "$FAKE_DIR/signals" 2>/dev/null || echo 0) + 1))" >"$FAKE_DIR/signals" ;;
  *"exec -T server-"*"api/ready"*)
    # Prints what the in-container probe prints: "ok role commit", or nothing while the server isn't listening yet.
    n=$(($(cat "$FAKE_DIR/polls" 2>/dev/null || echo 0) + 1)); echo "$n" >"$FAKE_DIR/polls"
    sig=$(cat "$FAKE_DIR/signals" 2>/dev/null || echo 0)
    if ((n <= ${SILENT_POLLS:-0})); then :
    elif ((n >= ${LEADER_AFTER:-1} && sig >= ${SIGNALS_NEEDED:-1})); then echo "true leader $(cat "$FAKE_DIR/commit")"
    else echo "true standby old"; fi ;;
esac
FAKE
chmod +x "$T/bin/docker"
# The host has no node (TrueNAS): a node on the PATH would hide a script that parses on the host.
printf '#!/bin/sh\necho "node: command not found" >&2\nexit 127\n' >"$T/bin/node"; chmod +x "$T/bin/node"
cp "$here/rebuild-live.sh" "$T/repo/scripts/"
(cd "$T/repo" && git init -q && git -c user.email=t@t -c user.name=t commit -q --allow-empty -m x)
git -C "$T/repo" rev-parse HEAD >"$T/commit"
printf '(active) {\n\treverse_proxy server-green:{args[0]} {\n\t}\n}\n' >"$T/deployer/proxy/active.caddy"
export PATH="$T/bin:$PATH" FAKE_LOG="$T/docker.log" FAKE_DIR="$T" BOSSMAN_DEPLOYER="$T/deployer" BOSSMAN_BACKUP_DIR="$T/backups" REBUILD_POLL_SECONDS=0
run() { : >"$FAKE_LOG"; rm -f "$T/polls" "$T/signals"; (cd "$T/repo" && scripts/rebuild-live.sh "$@") >"$T/out" 2>&1; }
logged() { grep -qF -- "$1" "$FAKE_LOG"; }

# The proxy's colour: backed up, built at the commit, migrated, recreated, signalled, and confirmed leading.
run || fail "a good rebuild failed"
logged "compose build server-green" || fail "didn't build the live colour"
logged "compose run --rm migrate" || fail "didn't migrate"
logged "compose up -d --no-deps --force-recreate server-green" || fail "didn't recreate the live colour"
logged "compose kill -s SIGUSR2 server-green" || fail "didn't tell it to take charge"
grep -q "server-green leads at" "$T/out" || fail "didn't confirm the leader"
[[ $(find "$T/backups" -name 'rebuild-*.sql.gz' | wc -l) == 1 ]] || fail "no backup kept"

# A failed build stops before anything restarts.
BUILD_RC=1 run && fail "a failed build reported success"
logged "force-recreate" && fail "restarted after a failed build"
grep -q "the build failed" "$T/out" || fail "didn't say the build failed"

# A server that stays on standby fails loudly instead of leaving Boss Man without a leader unnoticed.
LEADER_AFTER=999 REBUILD_WAIT_SECONDS=1 run && fail "a standby server reported success"
grep -q "didn't become leader" "$T/out" || fail "didn't say it isn't leading"

# A server that isn't listening yet gets no signal (it would be lost); once it answers as a standby it is signalled,
# and asked again after 30 s while it is still a standby (here it needs two signals).
SILENT_POLLS=3 SIGNALS_NEEDED=2 REBUILD_POLL_SECONDS=1 REBUILD_WAIT_SECONDS=90 run || fail "a server needing two signals never led"
grep -q "server-green leads at" "$T/out" || fail "didn't confirm the leader after resending"
[[ $(cat "$T/signals") == 2 ]] || fail "expected exactly two signals, got $(cat "$T/signals")"
first_kill=$(grep -n 'kill -s' "$FAKE_LOG" | head -1 | cut -d: -f1)
fourth_poll=$(grep -n 'api/ready' "$FAKE_LOG" | sed -n 4p | cut -d: -f1)
((first_kill > fourth_poll)) || fail "signalled before the server answered"

# On timeout it says the last role and the command to recover by hand.
LEADER_AFTER=999 REBUILD_WAIT_SECONDS=1 run && fail "a standby server reported success"
grep -q "Last role seen: standby" "$T/out" || fail "didn't print the last role"
grep -q "docker compose kill -s SIGUSR2 server-green" "$T/out" || fail "didn't print the recovery command"

# Naming the colour skips the include; a missing include without a name refuses.
run blue || fail "naming blue failed"
logged "compose build server-blue" || fail "didn't build the named colour"
rm "$T/deployer/proxy/active.caddy"
run && fail "ran without knowing the live colour"
grep -q "can't find which colour is live" "$T/out" || fail "didn't explain the missing include"
echo "rebuild-live.sh: all checks passed"
