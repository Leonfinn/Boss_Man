#!/usr/bin/env bash
# rebuild-live.sh against a fake docker: it rebuilds the colour the proxy names, signals it, and waits
# until it leads at the checkout's commit; a failed build stops before anything restarts; a server
# that stays on standby is asked again and the script fails loudly. Run: scripts/rebuild-live.test.sh
umask 022 # a default host umask: the script must tighten backups itself
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
  *"compose logs"*"server-"*) echo "Error: EACCES: permission denied, open /app/host-facts.ts" ;;
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
logged "compose run --rm --no-deps migrate" || fail "didn't migrate without --no-deps"
logged "compose up -d --no-deps --force-recreate server-green" || fail "didn't recreate the live colour"
# Every logged compose up/run must carry --no-deps, so a rebuild can never recreate the database.
! grep -E "compose (up|run) " "$FAKE_LOG" | grep -v -- "--no-deps" | grep -q . || fail "a compose up/run without --no-deps"
logged "compose kill -s SIGUSR2 server-green" || fail "didn't tell it to take charge"
grep -q "server-green leads at" "$T/out" || fail "didn't confirm the leader"
[[ $(find "$T/backups" -name 'rebuild-*.sql.gz' | wc -l) == 1 ]] || fail "no backup kept"
[[ $(stat -c %a "$(find "$T/backups" -name 'rebuild-*.sql.gz')") == 600 ]] || fail "the backup is not owner-only"
# Retention: only rebuild-* backups are pruned, newest 14 kept.
for i in $(seq 1 20); do touch -d "2020-01-$(printf %02d "$i")" "$T/backups/rebuild-old-$i.sql.gz"; done
touch "$T/backups/bossman-keep.sql.gz"
run || fail "a rebuild with old backups failed"
[[ $(find "$T/backups" -name 'rebuild-*.sql.gz' | wc -l) == 14 ]] || fail "backups were not pruned to 14"
[[ -e $T/backups/bossman-keep.sql.gz ]] || fail "pruned a backup that is not a rebuild one"

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

# The front-network form of the include names the same colour.
printf '(active) {\n\treverse_proxy server-blue-front:{args[0]} {\n\t\theader_up X-Forwarded-For {client_ip}\n\t}\n}\n' >"$T/deployer/proxy/active.caddy"
run || fail "front-form include failed"
logged "compose build server-blue" || fail "front-form include: didn't build blue"

# Naming the colour skips the include; a missing include without a name refuses.
run blue || fail "naming blue failed"
logged "compose build server-blue" || fail "didn't build the named colour"
rm "$T/deployer/proxy/active.caddy"
run && fail "ran without knowing the live colour"
grep -q "can't find which colour is live" "$T/out" || fail "didn't explain the missing include"
# The failure message ends with the last lines of that colour's log, so the cause is not hidden.
LEADER_AFTER=999 REBUILD_WAIT_SECONDS=1 run green && fail "a standby server reported success"
grep -q "Last 20 lines of the server-green log" "$T/out" || fail "no log header"
grep -q "EACCES: permission denied" "$T/out" || fail "didn't show the container log"
logged "compose logs --no-color --tail 20 server-green" || fail "didn't ask for 20 log lines"

# BOS-562: tracked files or folders the server (user node) can't read stop the rebuild before the backup, changing nothing.
(cd "$T/repo" && echo a >tracked.txt && mkdir -p dir && echo b >dir/x && git add tracked.txt dir && git -c user.email=t@t -c user.name=t commit -q -m files && chmod 600 tracked.txt && chmod 700 dir)
ls "$T/backups" >"$T/before"
run green && fail "rebuilt with unreadable files"
grep -q "^  tracked.txt$" "$T/out" || fail "tracked.txt not listed"
grep -q "^  dir$" "$T/out" || fail "didn't list the unreadable paths"
grep -q "chmod go+r" "$T/out" || fail "didn't print the fix"
[[ ! -s $FAKE_LOG ]] || fail "touched docker despite unreadable files"
[[ "$(ls "$T/backups")" == "$(cat "$T/before")" ]] || fail "made a backup despite unreadable files"
# More than 10 are cut to 10 paths.
(cd "$T/repo" && mkdir many && for i in $(seq 1 15); do echo "$i" >"many/f$i"; done && git add many && git -c user.email=t@t -c user.name=t commit -q -m many && chmod 600 many/*)
run green && fail "rebuilt with many unreadable files"
[[ $(grep -c "^  many/f" "$T/out") == 10 ]] || fail "expected 10 listed paths, got $(grep -c "^  many/f" "$T/out")"
grep -q "STOPPED: 17 file(s)" "$T/out" || fail "didn't count all of them"
# Untracked private files: .env at 600 and secrets/ at 700 are not counted, and the printed fix leaves them private.
(cd "$T/repo" && echo SECRET=x >.env && chmod 600 .env && mkdir -p secrets && echo k >secrets/key && chmod 600 secrets/key && chmod 700 secrets)
run green && fail "rebuilt with many unreadable files"
grep -q "STOPPED: 17 file(s)" "$T/out" || fail "counted untracked private files"
grep -Eq "^  (\.env|secrets)" "$T/out" && fail "listed an untracked private file"
# The printed fix works.
eval "$(sed -n 's/^  cd /cd /p' "$T/out")"
[[ $(stat -c %a "$T/repo/.env") == 600 && $(stat -c %a "$T/repo/secrets") == 700 && $(stat -c %a "$T/repo/secrets/key") == 600 ]] || fail "the printed fix opened up .env or secrets/"
git -C "$T/repo" rev-parse HEAD >"$T/commit" # the repo has new commits now
run green || fail "the printed fix did not make the rebuild go through with a private .env and secrets/"
logged "compose build server-green" || fail "didn't build with a private .env and secrets/"
# DR-020 G: the deployer's lock. A held lock makes the rebuild wait, then refuse before touching anything;
# one freed while it waits lets it go on; and while it runs, the deployer's own non-blocking take fails.
command -v flock >/dev/null || fail "flock is needed for the lock test"
holder() { # seconds: hold $T/deployer/lock for that long, in the background
  (exec 8>"$T/deployer/lock"; flock 8; sleep "$1") &
  hold_pid=$!; sleep 0.5
}
holder 30
before="$(ls "$T/backups")"
REBUILD_LOCK_WAIT_SECONDS=1 run green && fail "rebuilt while the deployer held its lock"
grep -q "STOPPED: the host deployer still holds $T/deployer/lock after 1s" "$T/out" || fail "didn't say what holds the lock"
grep -q "run this again" "$T/out" || fail "didn't say what to do"
[[ ! -s $FAKE_LOG ]] || fail "touched docker while the lock was held"
[[ "$(ls "$T/backups")" == "$before" ]] || fail "made a backup while the lock was held"
kill "$hold_pid" 2>/dev/null || true; wait "$hold_pid" 2>/dev/null || true
holder 2
REBUILD_LOCK_WAIT_SECONDS=20 run green || fail "didn't go on once the lock was freed"
grep -q "Waiting up to 20s" "$T/out" || fail "didn't say it was waiting"
logged "compose build server-green" || fail "didn't build after the lock was freed"
wait "$hold_pid" 2>/dev/null || true
# A running trial window (state/soak) is refused with the lock held: nothing is touched; once the file is gone it goes ahead.
mkdir -p "$T/deployer/state"
h40="$(printf 'a%.0s' $(seq 1 40))"
printf 'old=blue new=green deadline=%s commit=%s prev=%s\n' "$(($(date +%s) + 900))" "$h40" "$h40" >"$T/deployer/state/soak"
before="$(ls "$T/backups")"
run green && fail "rebuilt during a trial window"
grep -q "STOPPED: an update's trial window is running until" "$T/out" || fail "didn't say a trial window is running"
grep -q "Nothing was changed" "$T/out" || fail "didn't say nothing was changed"
grep -Eq "about 1[45] min" "$T/out" || fail "didn't say how long to wait"
[[ ! -s $FAKE_LOG ]] || fail "touched docker during a trial window"
[[ "$(ls "$T/backups")" == "$before" ]] || fail "made a backup during a trial window"
rm -f "$T/deployer/state/soak"
run green || fail "didn't go ahead once the trial window was gone"
logged "compose build server-green" || fail "didn't build after the trial window ended"
# While the script runs it holds the lock: a build that blocks lets us try the deployer's own flock -n.
cat >"$T/bin/docker" <<'FAKE'
#!/usr/bin/env bash
case "$*" in
  *"pg_dump"*) echo "-- dump" ;;
  *"compose build"*) if (exec 8>"$BOSSMAN_DEPLOYER/lock"; flock -n 8); then echo free >"$FAKE_DIR/lockstate"; else echo held >"$FAKE_DIR/lockstate"; fi; exit 1 ;;
esac
FAKE
run green && fail "the lock probe build should have failed"
[[ "$(cat "$T/lockstate")" == held ]] || fail "the lock was not held while the rebuild ran"
# And it is released when the script exits.
(exec 8>"$T/deployer/lock"; flock -n 8) || fail "the lock was still held after the script exited"
# A missing deployer folder is refused with its name.
BOSSMAN_DEPLOYER="$T/nowhere" run green && fail "ran without a deployer folder"
grep -q "STOPPED: the deployer folder $T/nowhere doesn't exist" "$T/out" || fail "didn't name the missing deployer folder"
echo "rebuild-live.sh: all checks passed"
