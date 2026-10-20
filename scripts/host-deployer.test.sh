#!/usr/bin/env bash
# Tests host-deployer.sh against a local git "origin", stub deploy scripts and a local webhook
# listener. Nothing here touches docker or the network. Run: scripts/host-deployer.test.sh
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
T="$(mktemp -d)"; trap 'kill "${hook_pid:-0}" 2>/dev/null || true; rm -rf "$T"' EXIT
fail() { echo "FAIL: $*"; exit 1; }
has() { grep -qF -- "$2" "$1" || fail "$1 lacks: $2 (has: $(cat "$1" 2>/dev/null))"; }
hasnt() { ! grep -qF -- "$2" "$1" 2>/dev/null || fail "$1 should not have: $2"; }
jget() { python3 -I -c 'import json,sys; print(json.load(open(sys.argv[1]))[sys.argv[2]])' "$1" "$2"; }

# --- fixture: origin, a working clone that moves main, and the checkout the host deploys ---
export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@t GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@t
git init -q --bare -b main "$T/origin.git"
git clone -q "$T/origin.git" "$T/w" 2>/dev/null
mkdir -p "$T/w/scripts" "$T/w/apps/server"
cat >"$T/w/scripts/deploy.sh" <<'STUB'
#!/usr/bin/env bash
echo "deploy.sh $*" >>"$STUB_LOG"
[[ ${1:-} == --yes && ${2:-} == --no-runner && ${3:-} == --commit ]] || exit 9
if [[ ${STUB_RC:-0} == 0 ]]; then git merge --ff-only --quiet "$4"; r=deployed; m=ok; else r=${STUB_RESULT:-failed}; m="the stub failed"; fi
printf '{"result":"%s","message":"%s","to_commit":"%s","backup":"/b/x.sql.gz"}\n' "$r" "$m" "$4" >"$BOSSMAN_DEPLOY_STATUS"
exit "${STUB_RC:-0}"
STUB
cat >"$T/w/scripts/update-runner.sh" <<'STUB'
#!/usr/bin/env bash
echo "update-runner.sh $*" >>"$STUB_LOG"
exit "${STUB_RC:-0}"
STUB
chmod +x "$T"/w/scripts/*.sh
echo a >"$T/w/apps/server/a"
git -C "$T/w" add -A; git -C "$T/w" commit -qm base; git -C "$T/w" push -q origin HEAD:main 2>/dev/null
base="$(git -C "$T/w" rev-parse HEAD)"
git clone -q "$T/origin.git" "$T/src" 2>/dev/null
push() { # file: change a file and push main; prints the new sha
  mkdir -p "$(dirname "$T/w/$1")"; echo "$RANDOM" >"$T/w/$1"
  git -C "$T/w" add -A; git -C "$T/w" commit -qm "change $1"; git -C "$T/w" push -q origin HEAD:main 2>/dev/null
  git -C "$T/w" rev-parse HEAD
}
c1="$(push apps/server/a)"

D="$T/deployer"; mkdir -p "$D/inbox" "$D/outbox"
export BOSSMAN_DEPLOYER="$D" STUB_LOG="$T/stub.log" BOSSMAN_DEPLOY_STATUS="$T/deploy-status.json" BOSSMAN_BACKUP_DIR="$T/backups"
: >"$STUB_LOG"
# A webhook listener that appends each POST body to a file, on a free port.
cat >"$T/hook.py" <<'PY'
import http.server, sys
class H(http.server.BaseHTTPRequestHandler):
    def do_POST(self):
        open(sys.argv[1], "ab").write(self.rfile.read(int(self.headers["Content-Length"])) + b"\n")
        self.send_response(200); self.end_headers()
    def log_message(self, *a): pass
s = http.server.HTTPServer(("127.0.0.1", 0), H)
print(s.server_address[1], flush=True)
s.serve_forever()
PY
python3 -I "$T/hook.py" "$T/hook.out" >"$T/hook.port" & hook_pid=$!
for _ in $(seq 50); do [[ -s $T/hook.port ]] && break; sleep 0.1; done
conf() { printf 'REPO=%s\nWEBHOOK_URL=http://127.0.0.1:%s/hook\nWEBHOOK_ON_SUCCESS=%s\nAVAILABLE_REFRESH_SECONDS=0\n' "$T/src" "$(cat "$T/hook.port")" "${1:-0}" >"$D/host.conf"; chmod 600 "$D/host.conf"; }
conf 0
host() { "$here/host-deployer.sh" "$@" >"$T/out" 2>&1 || { cat "$T/out"; fail "host-deployer exited non-zero"; }; }
req() { # target commit [id]: write a request the way the server does
  printf '{"id":"%s","target":"%s","commit":"%s","requestedAt":"2026-10-20T12:00:00.000Z","approvedBy":"owner-1"}\n' "${3:-$(python3 -c 'import uuid;print(uuid.uuid4())')}" "$1" "$2" >"$D/inbox/request.json"
}
status() { jget "$D/outbox/status.json" "$1"; }
calls() { wc -l <"$STUB_LOG" | tr -d ' '; }

# 1. No request: publishes what is waiting on main, and nothing else.
host
[[ $(jget "$D/outbox/available.json" tip) == "$c1" && $(jget "$D/outbox/available.json" deployed) == "$base" ]] || fail "available.json tip/deployed"
has "$D/outbox/available.json" '"runnerChanged": false'
has "$D/outbox/available.json" '"infraPaths": []'
has "$D/outbox/available.json" 'change apps/server/a'
[[ ! -e $D/outbox/status.json ]] || fail "status written with no request"

# 2. A good server request runs the fixed action, writes status and history, and stays quiet on success.
req server "$c1" 11111111-1111-1111-1111-111111111111
host
[[ $(status result) == deployed && $(status to_commit) == "$c1" && $(status backup) == /b/x.sql.gz ]] || fail "status after deploy: $(cat "$D/outbox/status.json")"
has "$STUB_LOG" "deploy.sh --yes --no-runner --commit $c1"
[[ ! -e $D/inbox/request.json ]] || fail "request not consumed"
[[ $(wc -l <"$D/outbox/history.jsonl") == 1 ]] || fail "history"
[[ ! -s $T/hook.out ]] || fail "webhook posted on success while off"

# 3. The same request id again is refused.
req server "$c1" 11111111-1111-1111-1111-111111111111
host
has "$D/outbox/status.json" "already handled"

# 4. Rate limit: a second server deploy inside 10 minutes is refused, and the webhook says so.
c2="$(push apps/server/b)"
req server "$c2"
host
[[ $(status result) == rejected ]] || fail "rate limit result"
has "$D/outbox/status.json" "only one server deploy every 10 minutes"
[[ $(calls) == 1 ]] || fail "deploy ran despite the rate limit"
has "$T/hook.out" '"result": "rejected"'
python3 -I - "$T/hook.out" <<'PY' || fail "webhook payload keys"
import json, sys
p = json.loads([l for l in open(sys.argv[1]).read().splitlines() if l.strip()][-1])
assert sorted(p) == ["at", "from_commit", "message", "result", "to_commit"], sorted(p)
PY

# 5. Not the tip of main: refused (the old commit is real, but main has moved).
rm "$D/state/last-server"
req server "$c1"
host
has "$D/outbox/status.json" "is not the tip of main"

# 6. A change to deployment files is refused, however it got to main.
c3="$(push docker-compose.yml)"
req server "$c3"
host
has "$D/outbox/status.json" "deployment files (docker-compose.yml)"
[[ $(calls) == 1 ]] || fail "infra change was deployed"
for p in deploy/x.yml scripts/deploy.sh apps/server/Dockerfile .github/workflows/ci.yml .env.example; do
  echo "$p" | grep -Eq "$(grep -o "^INFRA='[^']*'" "$here/host-deployer.sh" | sed "s/^INFRA='//; s/'\$//")" || fail "$p should count as infra"
done

# 7. Bad files: garbage, shell syntax in a field, a symlink, an oversized file. None run anything.
printf 'not json' >"$D/inbox/request.json"; host; has "$D/outbox/status.json" "expected format"
# shellcheck disable=SC2016
printf '{"id":"11111111-1111-1111-1111-111111111112","target":"server","commit":"$(touch %s/pwned)","requestedAt":"2026-10-20T12:00:00Z","approvedBy":"x"}' "$T" >"$D/inbox/request.json"; host
has "$D/outbox/status.json" "expected format"
printf '{"id":"11111111-1111-1111-1111-111111111113","target":"shell","commit":"%s","requestedAt":"2026-10-20T12:00:00Z","approvedBy":"x"}' "$c3" >"$D/inbox/request.json"; host
has "$D/outbox/status.json" "expected format"
ln -s /etc/passwd "$D/inbox/request.json"; host; has "$D/outbox/status.json" "plain file"
head -c 5000 /dev/zero | tr '\0' ' ' >"$D/inbox/request.json"; host; has "$D/outbox/status.json" "under 4 KB"
[[ ! -e $T/pwned && $(calls) == 1 ]] || fail "a bad request ran something"

# 8. Runner updates: only to the deployed commit; never needs the tip.
head="$(git -C "$T/src" rev-parse HEAD)"
req runner "$c3"; host; has "$D/outbox/status.json" "only to the commit that is deployed"
req runner "$head"; host
[[ $(status result) == deployed && $(status target) == runner ]] || fail "runner status"
has "$STUB_LOG" "update-runner.sh"

# 9. A failed deploy reports the failure, keeps the status honest and posts the webhook.
git -C "$T/w" reset -q --hard "$c2"; git -C "$T/w" push -qf origin HEAD:main 2>/dev/null # drop the compose change from main
c4="$(push apps/server/c)"
rm -f "$D/state/last-server"
STUB_RC=1 STUB_RESULT=partial; export STUB_RC STUB_RESULT
req server "$c4"; host
[[ $(status result) == partial ]] || fail "partial result: $(cat "$D/outbox/status.json")"
has "$D/outbox/status.json" "the stub failed"
unset STUB_RC STUB_RESULT

# 10. Success webhook is opt-in.
conf 1
rm -f "$D/state/last-runner"; : >"$T/hook.out"
req runner "$(git -C "$T/src" rev-parse HEAD)"; host
has "$T/hook.out" '"result": "deployed"'
conf 0

# 11. Dry run: every check, no changes, request left in place.
rm -f "$D/state/last-runner"; before="$(calls)"
req runner "$(git -C "$T/src" rev-parse HEAD)"; host --dry-run
has "$T/out" "[dry-run] checks passed: would run: scripts/update-runner.sh"
[[ -e $D/inbox/request.json && $(calls) == "$before" ]] || fail "dry run changed something"
rm "$D/inbox/request.json"

# 12. A run in progress holds the lock: the next minute leaves the request alone.
req server "$c4"
exec 8>"$D/lock"; flock -n 8
host; [[ -e $D/inbox/request.json ]] || fail "request taken while locked"
flock -u 8; rm "$D/inbox/request.json"

# 13. The config file must be private; the runner-path rule matches deploy.sh.
chmod 644 "$D/host.conf"
if "$here/host-deployer.sh" >/dev/null 2>&1; then fail "world-readable config accepted"; fi
chmod 600 "$D/host.conf"
a="$(grep -o "^RUNNER_PATHS='[^']*'" "$here/host-deployer.sh" | sed "s/^RUNNER_PATHS='//; s/'\$//")"
grep -qF -- "grep -Eq '$a'" "$here/deploy.sh" || fail "runner paths differ between host-deployer.sh and deploy.sh"

echo "host-deployer.test.sh: ok"
