#!/usr/bin/env bash
# Tests host-deployer.sh against a local git "origin", stub deploy scripts and a local webhook
# listener. Nothing here touches docker or the network. Run: scripts/host-deployer.test.sh
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
T="$(mktemp -d)"; trap 'kill "${hook_pid:-0}" 2>/dev/null || true; rm -rf "$T"' EXIT
fail() { echo "FAIL: $*"; [[ -z ${DEBUG:-} ]] || { cat "${DL:-/dev/null}" "$D/deployer.log"; }; exit 1; }
has() { grep -qF -- "$2" "$1" || fail "$1 lacks: $2 (has: $(cat "$1" 2>/dev/null))"; }
hasnt() { ! grep -qF -- "$2" "$1" 2>/dev/null || fail "$1 should not have: $2"; }
jget() { node -e 'const fs=require("fs");const o=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));process.stdout.write(String(o[process.argv[2]]))' "$1" "$2"; }

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
unset COMPOSE_FILE
umask 022 # a default host umask: the deployer must tighten backups itself
export BOSSMAN_DEPLOYER="$D" STUB_LOG="$T/stub.log" BOSSMAN_DEPLOY_STATUS="$T/deploy-status.json" BOSSMAN_BACKUP_DIR="$T/backups"
: >"$STUB_LOG"
# A webhook listener that appends each POST body to a file, on a free port.
cat >"$T/hook.mjs" <<'JS'
import http from "node:http";
import { appendFileSync } from "node:fs";
const out = process.argv[2];
const s = http.createServer((req, res) => {
  let body = "";
  req.on("data", (d) => (body += d));
  req.on("end", () => { appendFileSync(out, body + "\n"); res.writeHead(200); res.end(); });
});
s.listen(0, "127.0.0.1", () => { console.log(s.address().port); });
JS
node "$T/hook.mjs" "$T/hook.out" >"$T/hook.port" & hook_pid=$!
for _ in $(seq 50); do [[ -s $T/hook.port ]] && break; sleep 0.1; done
conf() { printf 'REPO=%s\nWEBHOOK_URL=http://127.0.0.1:%s/hook\nWEBHOOK_ON_SUCCESS=%s\nAVAILABLE_REFRESH_SECONDS=0\n' "$T/src" "$(cat "$T/hook.port")" "${1:-0}" >"$D/host.conf"; chmod 600 "$D/host.conf"; }
conf 0
host() { "$here/host-deployer.sh" "$@" >"$T/out" 2>&1 || { cat "$T/out"; fail "host-deployer exited non-zero"; }; }
req() { # target commit [id]: write a request the way the server does
  printf '{"id":"%s","target":"%s","commit":"%s","requestedAt":"2026-10-20T12:00:00.000Z","approvedBy":"owner-1"}\n' "${3:-$(node -e 'console.log(crypto.randomUUID())')}" "$1" "$2" >"$D/inbox/request.json"
}
status() { jget "$D/outbox/status.json" "$1"; }
calls() { wc -l <"$STUB_LOG" | tr -d ' '; }

# 1. No request: publishes what is waiting on main, and nothing else.
host
[[ $(jget "$D/outbox/available.json" tip) == "$c1" && $(jget "$D/outbox/available.json" deployed) == "$base" ]] || fail "available.json tip/deployed"
has "$D/outbox/available.json" '"runnerChanged": false'
has "$D/outbox/available.json" '"infraPaths": []'
has "$D/outbox/available.json" "\"srcDir\": \"$(cd "$T/src" && pwd)\""
has "$D/outbox/available.json" "\"deployerDir\": \"$(cd "$D" && pwd)\""
has "$D/outbox/available.json" '"bluegreen": false, "liveColour": ""'
hasnt "$D/outbox/available.json" '"soakSeconds"' # a single server has no standby window to report
has "$D/outbox/available.json" 'change apps/server/a'
[[ ! -e $D/outbox/status.json ]] || fail "status written with no request"
# 1a. Host facts (BOS-427): the machine's name, and the ownership of the folders it knows, read with stat only.
has "$D/outbox/host.json" '{"version": 1, "name":'
has "$D/outbox/host.json" "\"path\": \"$(cd "$T/deployer" && pwd)\""
has "$D/outbox/host.json" "\"path\": \"$(cd "$D" && pwd)\""
has "$D/outbox/host.json" '"mode": "'
hasnt "$D/outbox/host.json" '"login"' # the deployer runs as root and doesn't guess the owner's account
[[ $(stat -c %a "$D/outbox/host.json") == 644 ]] || fail "host.json is not mode 644"
node -e 'const h=require(process.argv[1]);if(!Array.isArray(h.ownership)||!h.ownership.length)process.exit(1);for(const o of h.ownership)if(!/^\/[^"]*$/.test(o.path)||!/^[0-7]{3,4}$/.test(o.mode)||!o.owner||!o.group)process.exit(2)' "$D/outbox/host.json" || fail "host.json ownership is malformed: $(cat "$D/outbox/host.json")"
# 1a2. Roles (BOS-541): each known folder says what it is for. The deployer folder is "deployer"; the install
# folder is "install", and the backups folder is "backups" (here a separate folder; the default layout, below,
# has the install folder do both). One row per folder, roles in a fixed order.
mkdir -p "$BOSSMAN_BACKUP_DIR"; host
role_of() { node -e 'const h=require(process.argv[1]);const p=process.argv[2];const r=h.ownership.find(o=>o.path===p);if(!r)process.stdout.write("MISSING");else process.stdout.write((r.roles||[]).join(","))' "$D/outbox/host.json" "$1"; }
[[ $(role_of "$(cd "$D/.." && pwd)") == install ]] || fail "install folder role: $(cat "$D/outbox/host.json")"
[[ $(role_of "$(cd "$D" && pwd)") == deployer ]] || fail "deployer folder role: $(cat "$D/outbox/host.json")"
[[ $(role_of "$BOSSMAN_BACKUP_DIR") == backups ]] || fail "backups folder role: $(cat "$D/outbox/host.json")"
node -e 'const h=require(process.argv[1]);const paths=h.ownership.map(o=>o.path);if(new Set(paths).size!==paths.length)process.exit(1);if(h.ownership.some(o=>!Array.isArray(o.roles)||!o.roles.length))process.exit(2);const all=new Set(h.ownership.flatMap(o=>o.roles));for(const r of all)if(!["install","deployer","backups","data","secrets"].includes(r))process.exit(3)' "$D/outbox/host.json" || fail "host.json roles are malformed: $(cat "$D/outbox/host.json")"
# 1a2. More facts (BOS-419): repo access, folders, addresses and ports, memory, add-ons and the fixed read-only checks.
# Every field is optional for the server; none carries a URL, key or token.
node -e '
const h=require(process.argv[1]);const bad=m=>{console.error(m);process.exit(1)};
if(!["https","ssh","http","other","none"].includes(h.repo.origin))bad("repo.origin");
if(typeof h.repo.embeddedCredentials!=="boolean"||!["ok","failed","skipped"].includes(h.repo.probe))bad("repo");
if(!h.paths.src||!h.paths.deployer||!h.paths.install)bad("paths");
if(!Array.isArray(h.compose.files)||typeof h.compose.bluegreen!=="boolean")bad("compose");
if(!Array.isArray(h.network.addresses)||typeof h.network.ports!=="object")bad("network");
if(!(h.memory.totalKb>0)||h.memory.availableKb>h.memory.totalKb)bad("memory");
for(const a of ["tailscale","ntfy","penpot"])if(!["not_set_up","stopped","needs_login","running"].includes(h.addons[a]))bad("addon "+a);
if(Object.keys(h.addons).length!==3)bad("addons list");
if(!h.checks.state_file_sizes)bad("checks");
' "$D/outbox/host.json" || fail "host.json extra facts are malformed: $(cat "$D/outbox/host.json")"
hasnt "$D/outbox/host.json" "$T/origin.git" # the origin URL is never reported
# Ports come only from the allowlist, and only values that look like an address or a port.
printf 'BOSSMAN_HOST_PORT=3199\nSECRET_TOKEN=abc123\nPENPOT_BIND=bad value;\n' >"$T/src/.env"
host
has "$D/outbox/host.json" '"BOSSMAN_HOST_PORT": "3199"'
hasnt "$D/outbox/host.json" 'abc123'
hasnt "$D/outbox/host.json" 'SECRET_TOKEN'
hasnt "$D/outbox/host.json" 'PENPOT_BIND'
rm -f "$T/src/.env"
# The repo probe is cached for an hour: a second run does not repeat it.
cp "$D/state/repo-probe" "$T/probe1"; sleep 1.1; host; cmp -s "$D/state/repo-probe" "$T/probe1" || fail "repo probe was repeated within the hour"
# 1b. Between refreshes the offer is left alone, unless the server asks for a look now (inbox/check).
sed -i 's/^AVAILABLE_REFRESH_SECONDS=0$/AVAILABLE_REFRESH_SECONDS=300/' "$D/host.conf"
printf '{"tip":"stale"}\n' >"$D/outbox/available.json"
host
[[ $(jget "$D/outbox/available.json" tip) == stale ]] || fail "refreshed before it was due"
: >"$D/inbox/check"; host
[[ $(jget "$D/outbox/available.json" tip) == "$c1" ]] || fail "inbox/check did not refresh the offer"
[[ ! -e $D/inbox/check ]] || fail "inbox/check was left behind"
conf 0

# 1c. The default layout: with no BOSSMAN_BACKUP_DIR the backups live in the install folder itself, so that one
# folder is recorded as both install and backups (BOS-541). R6 reads the role, so it still knows it is private.
# The deployer sits beside $T/src, as on a real host, so the checkout is found the usual way.
D_default="$T/default-deployer"; mkdir -p "$D_default/inbox" "$D_default/outbox"
BOSSMAN_DEPLOYER="$D_default" BOSSMAN_BACKUP_DIR="" "$here/host-deployer.sh" >"$T/out" 2>&1 || { cat "$T/out"; fail "host-deployer exited non-zero (default layout)"; }
node -e 'const h=require(process.argv[1]);const p=process.argv[2];const r=h.ownership.find(o=>o.path===p);if(!r)process.exit(1);const want=["backups","install"];const got=r.roles||[];if(got.join(",")!==want.join(",")){console.error("roles: "+got.join(","));process.exit(2)}' "$D_default/outbox/host.json" "$(cd "$D_default/.." && pwd)" || fail "default install folder roles: $(cat "$D_default/outbox/host.json")"

# 2. A good server request runs the fixed action, writes status and history, and stays quiet on success.
req server "$c1" 11111111-1111-1111-1111-111111111111
host
[[ $(status result) == deployed && $(status to_commit) == "$c1" && $(status backup) == /b/x.sql.gz ]] || fail "status after deploy: $(cat "$D/outbox/status.json")"
has "$STUB_LOG" "deploy.sh --yes --no-runner --commit $c1"
has "$D/outbox/status.json" '"soak_seconds": "0"' # not blue/green: no standby window to wait for (BOS-401)
[[ ! -e $D/inbox/request.json ]] || fail "request not consumed"
[[ $(wc -l <"$D/outbox/history.jsonl") == 1 ]] || fail "history"
[[ ! -s $T/hook.out ]] || fail "webhook posted on success while off"

# 3. The same request id again is refused.
req server "$c1" 11111111-1111-1111-1111-111111111111
host
has "$D/outbox/status.json" "already handled"

# 3b. A history line written with a space after the colon is still recognised.
printf '{"id": "22222222-2222-2222-2222-222222222222", "result": "deployed"}\n' >>"$D/outbox/history.jsonl"
req server "$c1" 22222222-2222-2222-2222-222222222222
host
has "$D/outbox/status.json" "already handled"

# 3c. A compact history line (no space) is still recognised.
printf '{"id":"33333333-3333-3333-3333-333333333333","result":"deployed"}\n' >>"$D/outbox/history.jsonl"
req server "$c1" 33333333-3333-3333-3333-333333333333
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
node -e '
const fs=require("fs");const lines=fs.readFileSync(process.argv[1],"utf8").split("\n").filter(l=>l.trim());
const p=JSON.parse(lines[lines.length-1]);const got=Object.keys(p).sort().join(",");const want="at,from_commit,message,result,to_commit";
if(got!==want){console.error("keys: "+got);process.exit(1)}
' "$T/hook.out" || fail "webhook payload keys"

# 5. Not the tip of main: refused (the old commit is real, but main has moved).
rm "$D/state/last-server"
req server "$c1"
host
has "$D/outbox/status.json" "is not the tip of main"
[[ ! -e $D/outbox/available.json ]] || fail "a stale offer survived a not-the-tip refusal"

# 6. A change to deployment files is refused, however it got to main.
c3="$(push docker-compose.yml)"
req server "$c3"
host
has "$D/outbox/status.json" "deployment files (docker-compose.yml)"
[[ $(calls) == 1 ]] || fail "infra change was deployed"
infra_re="$(grep -o "^INFRA='[^']*'" "$here/host-deployer.sh" | sed "s/^INFRA='//; s/'\$//")"
not_re="$(grep -o "^NOT_INFRA='[^']*'" "$here/host-deployer.sh" | sed "s/^NOT_INFRA='//; s/'\$//")"
for p in deploy/x.yml scripts/deploy.sh scripts/rebuild-live.sh scripts/update-runner.sh scripts/host-deployer.sh apps/server/Dockerfile .env.example; do
  if ! echo "$p" | grep -Eq "$infra_re" || echo "$p" | grep -Eq "$not_re"; then fail "$p should count as infra"; fi
done
# CI files and the Penpot and ntfy add-ons don't touch Boss Man's containers.
for p in .github/workflows/ci.yml deploy/penpot.yml scripts/make-app-icons.mjs scripts/check-all.sh scripts/lint-migrations.mjs scripts/restore-test.sh deploy/ntfy.yml deploy/ntfy-bluegreen.yml; do
  if echo "$p" | grep -Eq "$infra_re" && ! echo "$p" | grep -Eq "$not_re"; then fail "$p should not count as infra"; fi
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

# 7b. More hostile shapes: a repeated key, a nested object, an extra field with odd characters, a NUL byte, a bare string.
good='"requestedAt":"2026-10-20T12:00:00Z","approvedBy":"x"'
for body in \
  "{\"id\":\"11111111-1111-1111-1111-111111111114\",\"id\":\"11111111-1111-1111-1111-111111111115\",\"target\":\"server\",\"commit\":\"$c3\",$good}" \
  "{\"id\":\"11111111-1111-1111-1111-111111111114\",\"target\":\"server\",\"commit\":\"$c3\",$good,\"x\":{\"a\":\"b\"}}" \
  "{\"id\":\"11111111-1111-1111-1111-111111111114\",\"target\":\"server\",\"commit\":\"$c3\",$good,\"x\":\"a b\\\"c\"}" \
  "\"$c3\"" "[]"; do
  rm -f "$D/outbox/status.json"; printf '%s\n' "$body" >"$D/inbox/request.json"; host
  has "$D/outbox/status.json" "expected format"
done
rm -f "$D/outbox/status.json"
printf '{"id":"11111111-1111-1111-1111-111111111114","target":"server","commit":"%s\0",%s}\n' "$c3" "$good" >"$D/inbox/request.json"; host
has "$D/outbox/status.json" "expected format"
[[ ! -e $T/pwned && $(calls) == 1 ]] || fail "a hostile request ran something"
# 7c. A pretty-printed request (other writers, other spacing) is still read.
rm -f "$D/outbox/status.json"
printf '{\n  "id": "11111111-1111-1111-1111-111111111116",\n  "target": "server",\n  "commit": "%s",\n  %s\n}\n' "$c3" "${good/,/,$'\n  '}" >"$D/inbox/request.json"; host
[[ $(status id) == 11111111-1111-1111-1111-111111111116 ]] || fail "a pretty-printed request was not read"
rm -f "$D/state/last-server"
# 7d. Status text with quotes, backslashes and newlines is written as valid JSON.
(eval "$(sed -n '/^jstr() {/,/^}/p;/^json() {/,/^}/p' "$here/host-deployer.sh")"; json message=$'say "hi"\\ \n\tdone' >"$T/j.json")
[[ $(node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).message)' "$T/j.json") == $'say "hi"\\ \n\tdone' ]] || fail "json escaping"
# 7e. The host needs no node: the script only runs node inside a container (compose exec).
! grep -nE '(^|[^a-z-])node -e' "$here/host-deployer.sh" | grep -v 'compose exec' || fail "host-deployer.sh runs node on the host"

# 8. Runner updates: only to the deployed commit; never needs the tip.
head="$(git -C "$T/src" rev-parse HEAD)"
req runner "$c3"; host; has "$D/outbox/status.json" "Nothing is broken and nothing needs doing now"
req runner "$head"; host
[[ $(status result) == deployed && $(status target) == runner ]] || fail "runner status"
has "$STUB_LOG" "update-runner.sh"
hasnt "$STUB_LOG" "update-runner.sh --now" # the runner target drains; --now is for a person at the host

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

# ================= Blue/green (opt-in): fake docker, fake world =================
# The script resets PATH, so the tests run a copy that looks in our fake bin first.
mkdir -p "$T/bin"; sed "s#^export PATH=.*#export PATH=$T/bin:\$PATH#" "$here/host-deployer.sh" >"$T/hd.sh"; chmod +x "$T/hd.sh"
grep -q "$T/bin" "$T/hd.sh" || fail "could not point the script copy at the fake docker"
W="$T/world"; DL="$T/docker.log"
cat >"$T/bin/docker" <<'FAKE'
#!/usr/bin/env bash
# A tiny pretend Docker: a world of two colours, a proxy, and files for their state.
if [[ $1 == image ]]; then # image inspect boss-man-server:<colour>
  [[ -z ${FAKE_NO_IMAGE:-} ]]; exit
fi
if [[ $1 == inspect ]]; then # inspect -f <template> <id>: the project label, or the start time of the database
  echo "docker inspect $*" >>"$DL"
  case "$3" in *compose.project*) echo bmtest ;; *StartedAt*) cat "$W/started.db" 2>/dev/null || true ;; esac
  exit 0
fi
[[ $1 == compose ]] || exit 99
shift; a="$*"; echo "docker $a" >>"$DL"
role() { cat "$W/role.$1" 2>/dev/null || echo down; }
ready() { # colour: the JSON /api/ready would print
  [[ -e $W/running.$1 ]] || exit 1
  printf '{"ok": true, "db": true, "version": "1", "commit": "%s", "role": "%s"}\n' "$(cat "$W/commit.$1")" "$(role "$1")"
}
case "$a" in
  "ps -q "*) x=${a#ps -q }; x=${x#server-}; if [[ -e $W/cid.$x ]]; then cat "$W/cid.$x"; elif [[ -e $W/running.$x ]]; then echo cid; fi ;;
  "--project-name "*" config --hash"*) # one line per svc-<name> file in the unpacked commit, as Compose's --hash prints them
    [[ -z ${FAKE_NO_HASH:-} ]] || { echo "unknown flag: --hash" >&2; exit 1; }
    [[ -z ${FAKE_NO_RENDER:-} ]] || exit 1
    echo "render $PWD" >>"$DL"; for f in svc-*; do [[ ! -f $f ]] || echo "${f#svc-} $(sha256sum <"$f" | cut -d' ' -f1)"; done ;;
  "--project-name "*" config") # the same settings as a rendered file, for a Compose without --hash
    [[ -z ${FAKE_NO_RENDER:-} ]] || exit 1
    echo "name: p"; echo "services:"; for f in svc-*; do [[ ! -f $f ]] || { echo "  ${f#svc-}:"; echo "    image: $(cat "$f")"; }; done; echo "volumes:"; echo "  data: {}" ;;
  "exec -T db pg_dump"*) echo dump ;;
  "build server-"*) c=${a#build server-}; [[ -z ${FAKE_BUILD_FAIL:-} ]] || exit 1; echo "$BOSSMAN_COMMIT" >"$W/built.$c"; echo "build $c commit=$BOSSMAN_COMMIT" >>"$DL" ;;
  "run --rm --no-deps migrate") echo "migrate tag=$BOSSMAN_MIGRATE_TAG" >>"$DL"; exit "${FAKE_MIGRATE_RC:-0}" ;;
  "up -d --no-deps --force-recreate server-"*) c=${a##*server-}; touch "$W/running.$c"; cp "$W/built.$c" "$W/commit.$c"; echo standby >"$W/role.$c" ;;
  "up -d --no-deps server-"*) c=${a##*server-}; touch "$W/running.$c"; echo standby >"$W/role.$c" ;;
  "kill -s USR1 server-"*) c=${a##*server-}; echo "signal USR1 $c" >>"$DL"; [[ -n ${FAKE_NO_DEMOTE:-} ]] || echo standby >"$W/role.$c" ;;
  "kill -s USR2 server-"*) c=${a##*server-}; echo "signal USR2 $c" >>"$DL"; echo leader >"$W/role.$c" ;;
  "stop server-"*) c=${a##*server-}; rm -f "$W/running.$c"; echo "stopped $c" >>"$DL" ;;
  "exec -T server-"*)
    c=${a#exec -T server-}; c=${c%% *}
    case "$a" in
      *"/api/setup"*) [[ -z ${FAKE_SMOKE_FAIL:-} ]] || exit 1; echo '{"needsSetup":false}' ;;
      *) ready "$c" ;;
    esac ;;
  config) [[ -n ${FAKE_UNDECLARED:-} ]] || echo "aliases: [server-blue-front, server-green-front]" ;;
  "exec -T proxy wget -q -T 3 -O /dev/null http://server-"*-front:*)
    echo "front-check" >>"$DL"
    [[ -z ${FAKE_NO_FRONT:-} ]] || exit 1
    if [[ -n ${FAKE_FRONT_FLAKY:-} ]]; then n=$(cat "$W/flaky" 2>/dev/null || echo 0); echo $((n + 1)) >"$W/flaky"; ((n >= FAKE_FRONT_FLAKY)) || exit 1; fi ;;
  "exec -T proxy wget"*)
    live=$(sed -n 's/^[[:space:]]*reverse_proxy server-\(blue\|green\)\(-front\)\{0,1\}:.*/\1/p' "$BOSSMAN_DEPLOYER/proxy/active.caddy")
    [[ ${FAKE_VERIFY_FAIL:-} != "$live" ]] || exit 1
    case "$a" in *portal.html*) echo '<html>'; exit 0 ;; esac
    ready "$live" ;;
  "exec -T proxy caddy validate"*) [[ -z ${FAKE_VALIDATE_FAIL:-} ]] || exit 1; echo "validate sees $(sed -n 's/.*Live colour: //p' "$BOSSMAN_DEPLOYER/proxy/active.caddy")" >>"$DL" ;;
  "exec -T proxy caddy reload"*) echo "reload now $(sed -n 's/.*Live colour: //p' "$BOSSMAN_DEPLOYER/proxy/active.caddy")" >>"$DL" ;;
  *) echo "fake docker: unhandled: $a" >&2; exit 98 ;;
esac
FAKE
chmod +x "$T/bin/docker"
export DL W
live_is() { grep -q "Live colour: $1" "$D/proxy/active.caddy" || fail "proxy include should name $1: $(cat "$D/proxy/active.caddy") OUT: $(cat "$T/out" "$D/deployer.log" 2>/dev/null | tail -15)"; }
order() { # log-file pattern...: each pattern must appear after the previous one
  local f=$1 n=0 m; shift
  for pat in "$@"; do
    m=$(tail -n +"$((n + 1))" "$f" | grep -n -m1 -- "$pat" | cut -d: -f1) || true
    [[ -n $m ]] || fail "order: '$pat' not found after line $n in $f"
    n=$((n + m))
  done
}
reset_world() {  # live colour = $1, leading at commit $2
  local idle=green; [[ $1 == green ]] && idle=blue
  rm -rf "$W"; mkdir -p "$W"; touch "$W/running.proxy" "$W/running.$1"; echo leader >"$W/role.$1"; echo "$2" >"$W/commit.$1"
  rm -rf "$D/proxy" "$D/state/soak" "$D/state/previous" "$D/state/hold"; mkdir -p "$D/proxy"; chmod 755 "$D/proxy"
  printf '# x\n# Written by host-deployer.sh. Live colour: %s\n(active) {\n\treverse_proxy server-%s:{args[0]} {\n\t}\n}\n' "$1" "$1" >"$D/proxy/active.caddy"
  : >"$DL"; : >"$T/hook.out"; : >"$D/deployer.log"; echo "$idle" >/dev/null
}
bg() { # run the script copy as the cron job would
  BG_POLL_SECONDS=0 BG_READY_SECONDS=1 BG_HANDOVER_SECONDS=1 SOAK_CHECK_SECONDS=1 "$T/hd.sh" "$@" >"$T/out" 2>&1 || { cat "$T/out"; fail "host-deployer (copy) exited non-zero"; }
}
bgreq() { rm -f "$D/state/last-server"; req server "$1"; }
cur="$(git -C "$T/src" rev-parse HEAD)"
export COMPOSE_FILE="docker-compose.yml:deploy/truenas.yml:deploy/truenas-bluegreen.yml"

# 14. Opt-in detection: the swap only when COMPOSE_FILE (environment, or the checkout's .env) names the file.
b1="$(push apps/server/bg1)"
reset_world blue "$cur"
bgreq "$b1"; bg --dry-run
has "$T/out" "would run: a blue/green swap to ${b1:0:8}"
rm -f "$D/inbox/request.json"
touch "$D/inbox/check"; bg
has "$D/outbox/available.json" '"bluegreen": true, "liveColour": "blue", "soakSeconds": 900'
# The trial length is the host's own setting, not a copy of its default (Dougal, BOS-368): a custom SOAK_SECONDS is reported.
printf 'REPO=%s\nSOAK_SECONDS=120\n' "$T/src" >"$D/host.conf"; chmod 600 "$D/host.conf"
: >"$D/inbox/check"; bg
has "$D/outbox/available.json" '"soakSeconds": 120'
# A value that is not a whole number of seconds is not guessed at: the server falls back to its default.
printf 'REPO=%s\nSOAK_SECONDS=abc\n' "$T/src" >"$D/host.conf"; chmod 600 "$D/host.conf"
: >"$D/inbox/check"; bg
hasnt "$D/outbox/available.json" '"soakSeconds"'
has "$D/deployer.log" "SOAK_SECONDS is not a whole number of seconds"
conf 0; : >"$D/inbox/check"; bg

# 14b. BOS-562: a checkout with files the server (user node) can't read is refused before the backup and build; nothing changes.
reset_world blue "$cur"
(cd "$T/src" && chmod 600 "$(git ls-files | head -1)")
bgreq "$b1"; bg --dry-run; has "$T/out" "the real run would stop"; rm -f "$D/inbox/request.json"
bgreq "$b1"; bg
has "$D/outbox/status.json" '"result": "failed"'
has "$D/outbox/status.json" "can't be read by the server"
[[ "$(git -C "$T/src" rev-parse HEAD)" == "$cur" ]] || fail "moved the checkout despite unreadable files"
grep -q 'pg_dump' "$STUB_LOG" && fail "backed up despite unreadable files"
(cd "$T/src" && chmod 644 "$(git ls-files | head -1)")
reset_world blue "$cur"
unset COMPOSE_FILE
bgreq "$b1"; bg --dry-run; has "$T/out" "would run: scripts/deploy.sh --yes --no-runner --commit ${b1:0:8}"; rm -f "$D/inbox/request.json"
printf "COMPOSE_FILE='docker-compose.yml:deploy/truenas-bluegreen.yml'\n" >"$T/src/.env.tmp"; mv "$T/src/.env.tmp" "$T/src/.env"
bgreq "$b1"; bg --dry-run; has "$T/out" "would run: a blue/green swap"; rm -f "$D/inbox/request.json" "$T/src/.env"
export COMPOSE_FILE="docker-compose.yml:deploy/truenas.yml:deploy/truenas-bluegreen.yml"
before="$(calls)"

# 15. Happy path: backup, build idle at the commit, migrate, start, smoke, demote, promote, flip, verify.
reset_world blue "$cur"; P="$(git -C "$T/src" rev-parse HEAD)"
bgreq "$b1"; bg
[[ $(status result) == deployed && $(status to_commit) == "$b1" ]] || fail "bg status: $(cat "$D/outbox/status.json")"
has "$D/outbox/status.json" "green is live"
has "$D/outbox/status.json" '"soak_seconds": "900"' # the host's own window rides in the status file (BOS-401)
order "$DL" "pg_dump" "build green commit=$b1" "migrate tag=green" "up -d --no-deps --force-recreate server-green" "exec -T server-green" "signal USR1 blue" "signal USR2 green" "validate sees green" "reload now green" "exec -T proxy wget"
hasnt "$DL" "build blue" # only the idle colour is built
ls "$BOSSMAN_BACKUP_DIR"/bossman-*.sql.gz >/dev/null 2>&1 || fail "no backup written"
for f in "$BOSSMAN_BACKUP_DIR"/bossman-*.sql.gz; do [[ $(stat -c %a "$f") == 600 ]] || fail "backup $f is not mode 600"; done
live_is green
[[ $(cat "$W/built.green") == "$b1" && $(git -C "$T/src" rev-parse HEAD) == "$b1" ]] || fail "idle colour not built at the commit / checkout not moved"
[[ -e $W/running.blue && -e $W/running.green ]] || fail "old colour should stay up as a standby"
[[ $(calls) == "$before" ]] || fail "deploy.sh ran in blue/green mode"
[[ -z $(ls -A "$D/inbox") ]] || fail "something was written to the server-writable inbox: $(ls -A "$D/inbox")"
[[ $(ls "$D/proxy") == active.caddy ]] || fail "stray files in the proxy folder: $(ls "$D/proxy")"
[[ $(stat -c %a "$D/proxy/active.caddy") == 644 ]] || fail "include mode"
has "$D/state/soak" "old=blue new=green"
[[ ! -s $T/hook.out ]] || fail "webhook posted for a good swap while success posts are off"

# 15b. The include names the colour on the private front network and passes on one resolved client address;
# a host whose compose files have no front network yet still gets the old form (and the old form stays readable).
grep -q 'reverse_proxy server-green-front:{args\[0\]}' "$D/proxy/active.caddy" || fail "include lacks the front upstream: $(cat "$D/proxy/active.caddy")"
grep -q 'header_up X-Forwarded-For {client_ip}' "$D/proxy/active.caddy" || fail "include lacks header_up"

# 16. The next tick, inside the window, only re-checks; after the deadline it stops the old colour.
: >"$DL"; bg
[[ -e $W/running.blue && -e $D/state/soak ]] || fail "old colour stopped too early"
hasnt "$DL" "stopped"
sed -i 's/deadline=[0-9]*/deadline=1/' "$D/state/soak"
bg
[[ ! -e $W/running.blue && ! -e $D/state/soak && -e $W/running.green ]] || fail "old colour not stopped after the window"
has "$DL" "stopped blue"
live_is green

# 16b. A host whose compose files have no front network yet gets the old form.
bx="$(push apps/server/bgfront)"
export FRONT_WAIT=0
git -C "$T/src" reset -q --hard "$P"; reset_world green "$b1"; FAKE_UNDECLARED=1 FAKE_NO_FRONT=1 bgreq "$bx"; FAKE_UNDECLARED=1 FAKE_NO_FRONT=1 bg
live_is blue
grep -q 'reverse_proxy server-blue:{args\[0\]}' "$D/proxy/active.caddy" || fail "no-front host should get the old form: $(cat "$D/proxy/active.caddy")"
hasnt "$D/proxy/active.caddy" "header_up"

# 16c. A check that fails twice and then passes is retried: the front form is written.
git -C "$T/src" reset -q --hard "$P"; reset_world green "$b1"; rm -f "$W/flaky"; FAKE_FRONT_FLAKY=2 bgreq "$bx"; FAKE_FRONT_FLAKY=2 bg
live_is blue
grep -q 'reverse_proxy server-blue-front:{args\[0\]}' "$D/proxy/active.caddy" || fail "flaky check should still give the front form: $(cat "$D/proxy/active.caddy")"

# 16d. The compose files declare front but the check keeps failing: no downgrade (current form kept), and it is logged.
git -C "$T/src" reset -q --hard "$P"; reset_world green "$b1"; : >"$DL"; FAKE_NO_FRONT=1 bgreq "$bx"; FAKE_NO_FRONT=1 bg
live_is blue
grep -q "keeping the old include form" "$D/deployer.log" || fail "declared-but-failing check not logged: $(tail -5 "$D/deployer.log")"
[[ -s $D/outbox/proxy-include-note.txt ]] || fail "no include note written"
rm -f "$D/outbox/proxy-include-note.txt"
reset_world blue "$cur"; git -C "$T/src" reset -q --hard "$P"

# 17. Post-swap checks fail inside the window: automatic switch back, rolled_back, webhook.
reset_world blue "$cur"; git -C "$T/src" reset -q --hard "$P"
b2="$(push apps/server/bg2)"; bgreq "$b2"; bg
[[ $(status result) == deployed ]] || fail "setup swap: $(cat "$D/outbox/status.json")"
: >"$DL"; : >"$T/hook.out"
FAKE_VERIFY_FAIL=green bg
[[ $(status result) == rolled_back ]] || fail "auto switch-back: $(cat "$D/outbox/status.json")"
live_is blue
order "$DL" "signal USR1 green" "signal USR2 blue" "reload now blue" "stopped green"
has "$D/outbox/status.json" "was switched back"
has "$D/deployer.log" "Check failed on green"
[[ $(cat "$W/role.blue") == leader && ! -e $W/running.green && ! -e $D/state/soak ]] || fail "world after switch-back"
[[ $(git -C "$T/src" rev-parse HEAD) == "$P" ]] || fail "checkout not put back to the old commit"
has "$T/hook.out" '"result": "rolled_back"'

# 18. Checks fail right after the flip, during the swap itself: same reversal, same alert.
reset_world blue "$cur"; git -C "$T/src" reset -q --hard "$P"
b3="$(push apps/server/bg3)"; bgreq "$b3"
FAKE_VERIFY_FAIL=green bg
[[ $(status result) == rolled_back ]] || fail "swap-time rollback: $(cat "$D/outbox/status.json")"
order "$DL" "signal USR1 blue" "signal USR2 green" "reload now green" "signal USR1 green" "signal USR2 blue" "reload now blue" "stopped green"
live_is blue; [[ ! -e $D/state/soak ]] || fail "soak recorded for a failed swap"
has "$T/hook.out" '"result": "rolled_back"'

# 18b. The old colour died and the new one then fails its checks: the switch-back has nothing to go back to, so the new colour is NOT stopped; the alert carries the recovery commands.
reset_world blue "$cur"; git -C "$T/src" reset -q --hard "$P"
b3b="$(push apps/server/bg3b)"; bgreq "$b3b"; bg
[[ $(status result) == deployed ]] || fail "setup swap 18b: $(cat "$D/outbox/status.json")"
: >"$DL"; rm -f "$W/running.blue"
FAKE_VERIFY_FAIL=green bg
[[ $(status result) == failed ]] || fail "no old colour: $(cat "$D/outbox/status.json")"
hasnt "$DL" "stopped green"; [[ -e $W/running.green ]] || fail "the new colour was stopped with nothing to go back to"
has "$D/outbox/status.json" "docker compose kill -s USR2 server-green"
has "$T/hook.out" '"result": "failed"'

# 19. A failed smoke test on the idle colour: nobody is demoted, the idle colour is stopped, failure webhook.
reset_world blue "$cur"; git -C "$T/src" reset -q --hard "$P"
b4="$(push apps/server/bg4)"; bgreq "$b4"
FAKE_SMOKE_FAIL=1 bg
[[ $(status result) == failed ]] || fail "smoke failure: $(cat "$D/outbox/status.json")"
has "$D/outbox/status.json" "smoke test"
hasnt "$DL" "signal"; has "$DL" "stopped green"; live_is blue
[[ $(cat "$W/role.blue") == leader && $(git -C "$T/src" rev-parse HEAD) == "$P" ]] || fail "live colour touched / checkout not reset"
has "$T/hook.out" '"result": "failed"'
# A failed migration stops before anything starts.
reset_world blue "$cur"; bgreq "$b4"
FAKE_MIGRATE_RC=1 bg
has "$D/outbox/status.json" "migration failed"; hasnt "$DL" "up -d"; hasnt "$DL" "signal"
# A proxy that is not running changes nothing.
reset_world blue "$cur"; rm "$W/running.proxy"; bgreq "$b4"; bg
has "$D/outbox/status.json" "proxy container is not running"; hasnt "$DL" "pg_dump"

# 20. The include is only ever written through a folder nobody else can write: a writable one stops the flip.
reset_world blue "$cur"; chmod 777 "$D/proxy"; bgreq "$b4"
bg
chmod 755 "$D/proxy"
[[ $(status result) != deployed ]] || fail "wrote the include into a world-writable folder"
has "$D/deployer.log" "nobody else can write to"; live_is blue
# The temp file is made in the root-only state folder and renamed in (not in the proxy folder, not in inbox).
# shellcheck disable=SC2016
grep -q 'mktemp "\$STATE/active' "$here/host-deployer.sh" || fail "include temp file is not made in the state folder"

# 21. Blue/green does not loosen the infra rule: a Caddyfile change is still refused.
reset_world blue "$cur"; git -C "$T/src" reset -q --hard "$P"
b5="$(push deploy/caddy/Caddyfile)"; bgreq "$b5"; bg
has "$D/outbox/status.json" "deployment files (deploy/caddy/Caddyfile)"; hasnt "$DL" "pg_dump"

# 22. Manual rollback, long after the window (no soak file, old colour stopped): back to the other colour.
git -C "$T/w" reset -q --hard "$b5^"; git -C "$T/w" push -qf origin HEAD:main 2>/dev/null # drop case 21 Caddyfile commit
reset_world blue "$cur"; git -C "$T/src" reset -q --hard "$P"
b6="$(push apps/server/bg6)"; bgreq "$b6"; bg
[[ $(status result) == deployed ]] || fail "setup swap: $(cat "$D/outbox/status.json")"
sed -i 's/deadline=[0-9]*/deadline=1/' "$D/state/soak"; bg   # the window ends: blue is stopped
[[ ! -e $W/running.blue ]] || fail "setup: blue should be stopped"
: >"$DL"; : >"$T/hook.out"
bg --rollback --dry-run; hasnt "$DL" "signal"; hasnt "$DL" "pg_dump"; live_is green
bg --rollback
[[ $(status result) == rolled_back ]] || fail "manual rollback: $(cat "$D/outbox/status.json")"
order "$DL" "pg_dump" "up -d --no-deps server-blue" "signal USR1 green" "signal USR2 blue" "reload now blue" "stopped green"
hasnt "$DL" "build"; hasnt "$DL" "migrate"; hasnt "$DL" "force-recreate"
live_is blue; [[ $(cat "$W/role.blue") == leader && ! -e $W/running.green ]] || fail "world after manual rollback"
[[ $(git -C "$T/src" rev-parse HEAD) == "$P" ]] || fail "checkout not moved to the running code"
has "$T/hook.out" '"result": "rolled_back"'
# The rejected release is held (not offered again); a newer commit lifts the hold.
[[ $(cat "$D/state/hold") == "$b6" && ! -e $D/state/previous ]] || fail "hold / previous not recorded after rollback"
touch "$D/inbox/check"; bg
[[ $(jget "$D/outbox/available.json" tip) == "$P" ]] || fail "offered the rolled-back release again"
b7="$(push apps/server/bg7)"; touch "$D/inbox/check"; bg
[[ $(jget "$D/outbox/available.json" tip) == "$b7" ]] || fail "a newer commit was not offered"
# No image to go back to: nothing is touched.
reset_world green "$cur"; : >"$DL"; FAKE_NO_IMAGE=1 "$T/hd.sh" --rollback >"$T/out" 2>&1 && fail "rollback without an image should fail"
hasnt "$DL" "signal"; hasnt "$DL" "pg_dump"; live_is green
# The other colour fails the checks after the flip: reversed, still live on the original colour.
reset_world green "$cur"; : >"$DL"; echo "blue $cur" >"$D/state/previous"; echo "$cur" >"$W/commit.blue"
FAKE_VERIFY_FAIL=blue BG_POLL_SECONDS=0 BG_READY_SECONDS=1 BG_HANDOVER_SECONDS=1 SOAK_CHECK_SECONDS=1 "$T/hd.sh" --rollback >"$T/out" 2>&1 && fail "a rollback whose checks fail must exit non-zero"
live_is green; [[ $(cat "$W/role.green") == leader ]] || fail "original colour not restored"
# A deploy that failed after its build left a different build in the stopped colour: refused, live untouched.
reset_world green "$cur"; echo "blue $cur" >"$D/state/previous"; echo "$b6" >"$W/commit.blue"; : >"$DL"
"$T/hd.sh" --rollback >"$T/out" 2>&1 && fail "rollback to an unrecorded build should fail"
hasnt "$DL" "signal"; live_is green; [[ $(cat "$W/role.green") == leader ]] || fail "live colour touched by a refused rollback"
# No record of a previous release at all: refused.
reset_world green "$cur"; echo "$cur" >"$W/commit.blue"; : >"$DL"
"$T/hd.sh" --rollback >"$T/out" 2>&1 && fail "rollback without a recorded previous release should fail"
hasnt "$DL" "signal"; live_is green
# Not blue/green: refused.
unset COMPOSE_FILE; "$T/hd.sh" --rollback >"$T/out" 2>&1 && fail "rollback without blue/green should fail"; has "$T/out" "does not use blue/green"
export COMPOSE_FILE="docker-compose.yml:deploy/truenas.yml:deploy/truenas-bluegreen.yml"

# 30. A run that was cut off (status stuck on "running"): the next tick marks it failed, puts the checkout back on what answers,
# drops a trial window for a version that is not running, and touches no container (BOS-494).
reset_world blue "$P"; git -C "$T/src" fetch -q origin 2>/dev/null || true; git -C "$T/src" reset -q --hard "$b1"
printf '{"id": "%s", "target": "server", "result": "running", "message": "Running", "from_commit": "%s", "to_commit": "%s", "started": "2026-11-04T23:05:00Z", "ended": "", "at": "2026-11-04T23:05:00Z", "backup": ""}\n' "11111111-1111-1111-1111-111111111111" "$P" "$b1" >"$D/outbox/status.json"
printf 'old=blue new=green deadline=%s commit=%s prev=%s\n' "$(($(date +%s) + 900))" "$b1" "$P" >"$D/state/soak"
: >"$DL"; bg
[[ $(status result) == failed ]] || fail "interrupted run: $(cat "$D/outbox/status.json")"
has "$D/outbox/status.json" "cut off"
[[ $(git -C "$T/src" rev-parse HEAD) == "$P" ]] || fail "checkout not put back on the running commit"
[[ ! -e $D/state/soak ]] || fail "soak for a version that is not running was kept"
hasnt "$DL" "stopped"; hasnt "$DL" "signal"; live_is blue
# Ticking again changes nothing more.
bg; [[ $(status result) == failed ]] || fail "second tick changed the status"

# 31. BOS-487: which services an update changes, read from each service's rendered settings (fake files svc-<name>), and
# which of db/proxy still run with older settings. Nothing here may start, stop or recreate a container.
svc_check() { rm -f "$D/state/last-server"; : >"$D/inbox/check"; : >"$DL"; bg; } # a refresh, as the cron tick does it
avail() { jget "$D/outbox/available.json" "$1"; }
no_changes_made() { ! grep -qE '^docker (up|run|restart|stop|kill|rm|build|exec)' "$DL" || fail "the refresh changed something: $(cat "$DL")"; }
at() { git -C "$T/src" fetch -q origin 2>/dev/null; git -C "$T/src" reset -q --hard "$1"; }
push svc-db >/dev/null; push svc-proxy >/dev/null; sB="$(push svc-server)"
reset_world blue "$sB"; at "$sB"; rm -f "$D/state/applied-services" "$D/state/hold"
touch "$W/running.db"; echo cid1 >"$W/cid.db"; echo 2026-11-07T10:00:00Z >"$W/started.db"
conf 0
# a server-only change: only the server is listed, and nothing is pending
sC="$(push svc-server)"
svc_check; no_changes_made
[[ $(avail changedServices) == server ]] || fail "server-only change: $(cat "$D/outbox/available.json")"
has "$D/outbox/available.json" '"changedServices": ["server"]'
has "$D/outbox/available.json" '"servicesChecked": true'
has "$D/outbox/available.json" '"pendingServices": []'
has "$D/outbox/available.json" '"dbContainerId": "cid1", "dbStartedAt": "2026-11-07T10:00:00Z"'
[[ ! -e $D/state/render ]] || fail "the render folder was left behind"
# the same service files twice, and a change that touches no service: nothing changed (no noise from paths or the commit)
sD="$(push apps/server/a)"
at "$sC"; svc_check; has "$D/outbox/available.json" '"changedServices": []'; has "$D/outbox/available.json" '"servicesChecked": true'
# db only
sE="$(push svc-db)"; at "$sD"; svc_check; has "$D/outbox/available.json" '"changedServices": ["db"]'
# proxy only, then db and proxy together
sF="$(push svc-proxy)"; at "$sE"; svc_check; has "$D/outbox/available.json" '"changedServices": ["proxy"]'
at "$sD"; svc_check; has "$D/outbox/available.json" '"changedServices": ["db", "proxy"]'
# a service added, and one removed, count as changed
git -C "$T/w" rm -q svc-server; git -C "$T/w" commit -qm "drop svc-server"; git -C "$T/w" push -q origin HEAD:main 2>/dev/null
sG="$(git -C "$T/w" rev-parse HEAD)"; at "$sF"; svc_check; has "$D/outbox/available.json" '"changedServices": ["server"]'
sH="$(push svc-extra)"; at "$sG"; svc_check; has "$D/outbox/available.json" '"changedServices": ["extra"]'
# the same render works for a Compose without --hash (it hashes each service block of the rendered file)
FAKE_NO_HASH=1 svc_check; has "$D/outbox/available.json" '"changedServices": ["extra"]'; has "$D/outbox/available.json" '"servicesChecked": true'
at "$sD"; FAKE_NO_HASH=1 svc_check; has "$D/outbox/available.json" '"changedServices": ["db", "extra", "proxy", "server"]'
# it can't render: reported as not checked, an update is still offered, and the reason is in the log
FAKE_NO_RENDER=1 svc_check; has "$D/outbox/available.json" '"servicesChecked": false'; has "$D/outbox/available.json" '"changedServices": []'
has "$D/outbox/available.json" "\"tip\": \"$sH\""; has "$D/deployer.log" "could not be rendered"
[[ ! -e $D/state/render ]] || fail "the render folder was left behind after a failure"
# switched off in host.conf: not compared, and docker is not asked to render anything
printf 'REPO=%s\nAVAILABLE_REFRESH_SECONDS=0\nSERVICE_COMPARE=0\n' "$T/src" >"$D/host.conf"; chmod 600 "$D/host.conf"
svc_check; has "$D/outbox/available.json" '"servicesChecked": false'; hasnt "$DL" "config"; has "$D/deployer.log" "Service compare is off"
conf 0
# pending: the live checkout asks for new db settings, the container has not been recreated since
rm -f "$D/state/applied-services"; at "$sC"; svc_check; has "$D/outbox/available.json" '"pendingServices": []' # first look: recorded as applied
at "$sE"; svc_check; has "$D/outbox/available.json" '"pendingServices": ["db"]'
echo 2026-11-07T11:00:00Z >"$W/started.db"; svc_check; has "$D/outbox/available.json" '"pendingServices": ["db"]' # a restart keeps the same container: not applied
has "$D/outbox/available.json" '"dbStartedAt": "2026-11-07T11:00:00Z"'
echo cid2 >"$W/cid.db"; svc_check; has "$D/outbox/available.json" '"pendingServices": []' # recreated: applied
has "$D/outbox/available.json" '"dbContainerId": "cid2"'
at "$sF"; svc_check; has "$D/outbox/available.json" '"pendingServices": ["proxy"]'
svc_check; has "$D/outbox/available.json" '"pendingServices": ["proxy"]' # and stays so until the proxy is recreated
# no deploy path starts, stops or recreates the database or the proxy: the server deploy rolls the colours only (DR-020 B)
for f in host-deployer.sh rebuild-live.sh deploy.sh; do
  # Any compose up/run/restart/stop/kill/rm/create/down (also in the hint text) must name only the server colours,
  # the server or the launcher: every `up` and `run` carries --no-deps, and none names db or proxy. A bare
  # `up -d` or `restart` therefore fails here.
  if grep -nE '(compose|docker)[^#]* (up|run|restart|stop|kill|rm|create|down)\b' "$here/$f" \
    | grep -vE '^[0-9]+:\s*#|exec -T |rm -f ' \
    | grep -vE '(up|run)\b.*--no-deps .*(server|launcher|migrate|\$\{svcs\[@\]\})|(stop|kill)\b.*"?server' ; then
    fail "$f has a compose up/run/restart/stop/kill/rm/create/down that is not limited to the server services"
  fi
  if grep -nE '(compose|docker)[^#]* (up|run|restart|stop|kill|rm|create|down)\b[^#]*\b(db|proxy)\b' "$here/$f" | grep -vE '^[0-9]+:\s*#|exec -T (db|proxy)|--no-deps migrate'; then
    fail "$f starts or recreates db or proxy"
  fi
done

# With no BOSSMAN_DEPLOYER, the copy uses the folder it sits in.
own="$(mktemp -d)"; mkdir -p "$own/deployer"; cp "$here/host-deployer.sh" "$own/deployer/"
out="$( (unset BOSSMAN_DEPLOYER; bash "$own/deployer/host-deployer.sh" --dry-run 2>&1) || true)"
[[ $out == *"$own/deployer/inbox"* ]] || { echo "FAIL: default deployer folder is not its own folder: $out"; exit 1; }
rm -rf "$own"

echo "host-deployer.test.sh: ok"
