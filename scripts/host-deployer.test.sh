#!/usr/bin/env bash
# Tests host-deployer.sh against a local git "origin", stub deploy scripts and a local webhook
# listener. Nothing here touches docker or the network. Run: scripts/host-deployer.test.sh
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
T="$(mktemp -d)"; trap 'kill "${hook_pid:-0}" 2>/dev/null || true; rm -rf "$T"' EXIT
fail() { echo "FAIL: $*"; [[ -z ${DEBUG:-} ]] || { cat "${DL:-/dev/null}" "$D/deployer.log"; }; exit 1; }
# gpush <repo> <push args...>: git push with git's stderr kept; a failed push ends the whole test, naming the helper
# and printing git's message (BOS-1835). Used inside $(...) too, where exit ends only the subshell, so signal $$.
gpush() {
  local err; err="$(git -C "$1" push -q "${@:2}" 2>&1)" || { echo "FAIL: gpush($1 ${*:2}) failed: $err" >&2; kill -TERM "$$"; exit 1; }
}
has() { grep -qF -- "$2" "$1" || fail "$1 lacks: $2 (has: $(cat "$1" 2>/dev/null))"; }
hasnt() { ! grep -qF -- "$2" "$1" 2>/dev/null || fail "$1 should not have: $2"; }
jget() { node -e 'const fs=require("fs");const o=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));process.stdout.write(String(o[process.argv[2]]))' "$1" "$2"; }

# --- fixture: origin, a working clone that moves main, and the checkout the host deploys ---
export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@t GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@t
git init -q --bare -b main "$T/origin.git"
git clone -q "$T/origin.git" "$T/w"
mkdir -p "$T/w/scripts" "$T/w/apps/server"
cat >"$T/w/scripts/deploy.sh" <<'STUB'
#!/usr/bin/env bash
echo "deploy.sh $*" >>"$STUB_LOG"
# A restart (BOS-647) adds --force before --commit.
if [[ ${3:-} == --force ]]; then set -- "$1" "$2" "${@:4}"; fi
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
git -C "$T/w" add -A; git -C "$T/w" commit -qm base; gpush "$T/w" origin HEAD:main
base="$(git -C "$T/w" rev-parse HEAD)"
git clone -q "$T/origin.git" "$T/src"
push() { # file: change a file and push main; prints the new sha
  mkdir -p "$(dirname "$T/w/$1")"; echo "$RANDOM" >"$T/w/$1"
  git -C "$T/w" add -A; git -C "$T/w" commit -qm "change $1"; gpush "$T/w" origin HEAD:main
  # Exactly one 40-char sha, or end the whole test naming the helper (BOS-1817): a stray line or an empty
  # value would otherwise only show up later as the deployer rejecting the request's shape. push runs in a
  # $(...) subshell, where exit would end only the subshell, so signal the main script ($$ is the parent).
  local sha; sha="$(git -C "$T/w" rev-parse HEAD)"
  [[ $sha =~ ^[0-9a-f]{40}$ ]] || { echo "FAIL: push($1) did not give one 40-char sha, got: [$sha]" >&2; kill -TERM "$$"; exit 1; }
  echo "$sha"
}
c1="$(push apps/server/a)"

D="$T/deployer"; mkdir -p "$D/inbox" "$D/outbox"
unset COMPOSE_FILE
umask 022 # a default host umask: the deployer must tighten backups itself
export BOSSMAN_DEPLOYER="$D" STUB_LOG="$T/stub.log" BOSSMAN_DEPLOY_STATUS="$T/deploy-status.json" BOSSMAN_BACKUP_DIR="$T/backups"
: >"$STUB_LOG"
# Memory as the deployer reads it (BOS-420): plenty free unless a test says otherwise, and no container limit.
meminfo() { # [total kB] [available kB] [swap free kB of 2 GiB]
  printf 'MemTotal:       %s kB\nMemFree:          100000 kB\nMemAvailable:   %s kB\nSwapTotal:      2097152 kB\nSwapFree:       %s kB\n' "${1:-33554432}" "${2:-30000000}" "${3:-2097152}" >"$T/meminfo"
}
meminfo; mkdir -p "$T/cgroup"
export BOSSMAN_MEMINFO="$T/meminfo" BOSSMAN_CGROUP_DIR="$T/cgroup"
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
  # Build the id first and check it, so a failed node start under load stops here with a clear message.
  local rid="${3:-}"
  [[ -n $rid ]] || rid="$(node -e 'console.log(crypto.randomUUID())')"
  [[ $rid =~ ^[0-9A-Za-z-]{1,64}$ ]] || { echo "FAIL: req($1) request id is not a plain id, got: [$rid]" >&2; exit 1; }
  [[ $2 =~ ^[0-9a-f]{40}$ ]] || { echo "FAIL: req($1) commit is not one 40-char sha, got: [$2]" >&2; exit 1; }
  printf '{"id":"%s","target":"%s","commit":"%s","requestedAt":"2026-10-20T12:00:00.000Z","approvedBy":"owner-1"}\n' "$rid" "$1" "$2" >"$D/inbox/request.json"
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
# BOS-990: the host reports the sha256 of the script file it runs from, and of the checkout's copy (empty when the checkout has none).
has "$D/outbox/host.json" "\"deployer\": {\"scriptSha\": \"$(sha256sum "$here/host-deployer.sh" | cut -d' ' -f1)\", \"repoSha\": \""
[[ $(node -e 'const h=require(process.argv[1]);process.stdout.write(/^([0-9a-f]{64})?$/.test(h.deployer.repoSha)?"ok":"bad")' "$D/outbox/host.json") == ok ]] || fail "deployer.repoSha is malformed: $(cat "$D/outbox/host.json")"
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
# The ntfy add-on's own https address is reported (so the phone page can show it); anything else is not.
printf 'NTFY_BASE_URL=https://box.example.ts.net:8443\n' >"$T/src/.env"
host
has "$D/outbox/host.json" '"ntfy": {"baseUrl": "https://box.example.ts.net:8443"}'
hasnt "$D/outbox/host.json" '"container"' # no docker here, so no container name is guessed
printf 'NTFY_BASE_URL=https://user:pw@box.example.ts.net:8443/?x=1\n' >"$T/src/.env"
host
hasnt "$D/outbox/host.json" 'baseUrl'
hasnt "$D/outbox/host.json" 'user:pw'
rm -f "$T/src/.env"
# BOS-770: every BOSSMAN_NETGUARD_ALLOW line in .env is reported in order, host:port entries only, so a duplicate
# (Compose uses only the last) shows; a comment, a commented-out line and anything that isn't host:port are left out.
printf 'BOSSMAN_NETGUARD_ALLOW=git.example.lan:3000\n# BOSSMAN_NETGUARD_ALLOW=old.example.lan:1\nSECRET_TOKEN=abc123\nexport BOSSMAN_NETGUARD_ALLOW="penpot.example.lan:9001, 10.0.0.9:22 bad;entry" # the design tool\n' >"$T/src/.env"
host
node -e '
const h=require(process.argv[1]);const g=h.netguardEnv;
if(!g||g.envFound!==true||JSON.stringify(g.lines)!==JSON.stringify([["git.example.lan:3000"],["penpot.example.lan:9001","10.0.0.9:22"]])){console.error(JSON.stringify(g));process.exit(1)}
' "$D/outbox/host.json" || fail "netguardEnv is wrong: $(cat "$D/outbox/host.json")"
hasnt "$D/outbox/host.json" 'old.example.lan'
hasnt "$D/outbox/host.json" 'abc123'
hasnt "$D/outbox/host.json" 'design tool'
# DR-052: the .env the stack starts with is reported as its full path (the checkout's, where Compose reads it), and
# not at all when there is none, so the server never has to guess it.
has "$D/outbox/host.json" "\"env\": {\"file\": \"$(cd "$T/src" && pwd)/.env\"}"
rm -f "$T/src/.env"
host
has "$D/outbox/host.json" '"netguardEnv": {"envFound": false, "lines": []}'
hasnt "$D/outbox/host.json" '"env": {'
# The repo probe is cached for an hour: a second run does not repeat it.
cp "$D/state/repo-probe" "$T/probe1"; sleep 1.1; host; cmp -s "$D/state/repo-probe" "$T/probe1" || fail "repo probe was repeated within the hour"
# BOS-986: a probe that fails reports one short, secret-free line saying why, and it is cached with the result.
# The error is what git printed, never a URL, an address with a user, or a long key.
rm -f "$D/state/repo-probe"
git -C "$T/src" remote set-url origin "ssh://someone@git.example.test:2222/repo.git"
host
has "$D/outbox/host.json" '"probe": "failed"'
has "$D/outbox/host.json" '"probeWhy": "'
hasnt "$D/outbox/host.json" "someone@git.example.test"
cp "$D/outbox/host.json" "$T/failed.json"
host
node -e 'const h=require(process.argv[1]);const w=h.repo.probeWhy;if(!w||w.length>200||/git\.example\.test|someone@/.test(w)){console.error("probeWhy: "+JSON.stringify(w));process.exit(1)}' "$T/failed.json" || fail "probeWhy leaks the host or is too long: $(cat "$T/failed.json")"
# A cache written by an older deployer (two fields) still reads as ok/failed with no reason, and never breaks a report.
printf 'failed 2026-11-09_10:00:00\n' >"$D/state/repo-probe"
host
has "$D/outbox/host.json" '"probe": "failed", "probedAt": "2026-11-09_10:00:00", "probeWhy": ""'
git -C "$T/src" remote set-url origin "$T/origin.git"
rm -f "$D/state/repo-probe"; host
has "$D/outbox/host.json" '"probe": "ok"'
has "$D/outbox/host.json" '"probeWhy": ""'
# BOS-986: compose.files is de-duplicated, so a file named twice (or under two spellings) shows once.
printf 'COMPOSE_FILE=docker-compose.yml:deploy/truenas.yml:deploy/tailscale.yml:deploy/tailscale-bluegreen.yml:deploy/tailscale.yml:./deploy/truenas.yml\n' >"$T/src/.env"
host
has "$D/outbox/host.json" '"files": ["docker-compose.yml", "deploy/truenas.yml", "deploy/tailscale.yml", "deploy/tailscale-bluegreen.yml"]'
rm -f "$T/src/.env"; host
# BOS-986: the "meant to stop" filter for container_status. Run a copy of the script whose docker is a fake that
# mimics the real split: `docker ps` has no ExitCode field (asking for one makes real Docker fail), so the report
# reads it from `docker inspect` for the containers that aren't up. The world holds a running server, a one-shot
# migrate/netguard that exited 0 with restart policy "no", the standby colour that exited 0, a cleanly stopped
# database (exit 0, restart policy "unless-stopped", so not meant to stop), an up-but-unhealthy container, and two
# containers that really failed. Only the database and the two failures count; all three are named.
mkdir -p "$T/fd"; cat >"$T/fd/docker" <<'FAKE'
#!/usr/bin/env bash
# ps <format> lines are: ID, Names, State, Status, RunningFor, project label, service label (a tab between each).
if [[ $1 == ps && $2 == -a && $3 == --filter && $4 == label=com.docker.compose.project && $5 == --format ]]; then
  printf 'aaa\tsrv\t%s\t%s\t2 hours ago\tsrv\tsrv\n' "${FAKE_RUN:-running}" "${FAKE_STATUS:-Up 2 hours}"
  printf 'bbb\tbm-migrate-1\texited\tExited (0) 5 minutes ago\t5 minutes ago\tbm\tmigrate\n'
  printf 'ccc\tbm-netguard-1\texited\tExited (0) 5 minutes ago\t5 minutes ago\tbm\tnetguard\n'
  printf 'ddd\tserver-green\texited\tExited (%s) 1 minute ago\t1 minute ago\tbm\tserver-green\n' "${FAKE_GREEN_EXIT:-0}"
  # BOS-1584: FAKE_BLUE=running|exited adds the other colour, to test the standby filter with a known live colour.
  [[ -n ${FAKE_BLUE:-} ]] && printf 'bl1\tserver-blue\t%s\tUp 1 hour\t1 hour ago\tbm\tserver-blue\n' "$FAKE_BLUE"
  printf 'eee\tbm-worker-1\texited\tExited (%s) 2 hours ago\t2 hours ago\tbm\tworker\n' "${FAKE_EXIT:-137}"
  printf 'fff\tbm-cache-1\trestarting\tRestarting (255) 1 second ago\t1 minute ago\tbm\tcache\n'
  printf 'ggg\tbm-db-1\texited\tExited (0) 10 minutes ago\t10 minutes ago\tbm\tdb\n'
  printf 'hhh\tbm-worker-1\texited\tExited (%s) 2 hours ago\t2 hours ago\tbm\tworker\n' "${FAKE_EXIT:-137}" # the same container again: counted once
  # BOS-2680: FAKE_RUNNERS=1 adds the launcher's runners. The staging runner's image was built by Compose, so it
  # carries the service label runner-app-co and a project (columns 8 and 9: stack and company; `-` is an empty label).
  [[ -n ${FAKE_RUNNERS:-} ]] && printf 'rs1\tboss-man-staging-runner-staging-co\trunning\tUp 4 hours (unhealthy)\t4 hours ago\tstagingproj\trunner-app-co\tstaging\tstaging-co\n'
  # BOS-2781: a stopped staging container (and a restarting one, already in the unhealthy list) must not count as not running.
  [[ -n ${FAKE_RUNNERS:-} ]] && printf 'rs4\tstaging-db-1\texited\tExited (1) 3 hours ago\t3 hours ago\tstagingproj\tdb\tstaging\t-\n'
  [[ -n ${FAKE_RUNNERS:-} ]] && printf 'rs5\tstaging-cache-1\trestarting\tRestarting (1) 2 seconds ago\t3 hours ago\tstagingproj\tcache\tstaging\t-\n'
  exit 0
fi
# BOS-2680: the launcher's runners by label. A production runner has no compose labels, no stack and a company.
if [[ $1 == ps && $2 == -a && $3 == --filter && $4 == label=boss-man.launcher=1 && $5 == --format ]]; then
  if [[ -n ${FAKE_RUNNERS:-} ]]; then
    printf 'rs1\tboss-man-staging-runner-staging-co\trunning\tUp 4 hours (unhealthy)\t4 hours ago\tstagingproj\trunner-app-co\tstaging\tstaging-co\n'
    printf 'rp1\tboss-man-runner-prod-co\trunning\tUp 4 hours (unhealthy)\t4 hours ago\t-\t-\t-\tprod-co\n'
    printf 'rp2\tboss-man-runner-fine-co\trunning\tUp 4 hours (healthy)\t4 hours ago\t-\t-\t-\tfine-co\n'
  fi
  exit 0
fi
# inspect -f <format> <ids...>: the exit code, and the restart policy, per container id.
if [[ $1 == inspect && $2 == -f && $3 == '{{.State.ExitCode}}' ]]; then
  shift 3
  # FAKE_INSPECT_EMPTY mimics inspect printing nothing (the container was removed between ps and inspect, or inspect
  # was denied). The report must still be valid JSON (Rod's review of BOS-986 round 2).
  [[ -n ${FAKE_INSPECT_EMPTY:-} ]] && exit 0
  for id in "$@"; do
    case $id in
      ddd) echo "${FAKE_GREEN_EXIT:-0}" ;;
      bl1) echo "${FAKE_BLUE_EXIT:-1}" ;;
      bbb|ccc|ggg) echo 0 ;;
      eee|hhh) echo "${FAKE_EXIT:-137}" ;;
      fff) echo 255 ;;
      *) echo 0 ;;
    esac
  done
  exit 0
fi
if [[ $1 == inspect && $2 == -f && $3 == '{{.HostConfig.RestartPolicy.Name}}' ]]; then
  case $4 in
    bbb|ccc) echo no ;;
    *) echo unless-stopped ;;
  esac
  exit 0
fi
if [[ $1 == inspect && $2 == -f && $3 == *StartPeriod* ]]; then
  # BOS-2481: FAKE_STARTED_AGO=<seconds> says the container started that long ago, with a 60 s start period.
  [[ -n ${FAKE_STARTED_AGO:-} ]] && echo "$(date -u -d "-${FAKE_STARTED_AGO} seconds" +%Y-%m-%dT%H:%M:%SZ)|60000000000"
  exit 0
fi
if [[ $1 == inspect && $2 == -f && $3 == *Health.FailingStreak* ]]; then
  # BOS-2680: the failing streak, then one "<exit> <json output>" line per probe; the last one is the newest.
  printf '3\n0 ""\n1 "cannot stat /home/node/runner-data/connected\\nsecond line"'
  exit 0
fi
if [[ $1 == ps && $2 == -aq ]]; then exit 0; fi
exit 0
FAKE
chmod +x "$T/fd/docker"
# Real Docker fails when a format asks for a field it doesn't have (Dougal's infra review). Make sure the report
# never asks `docker ps` for {{.ExitCode}} again, so a regression fails here instead of on a real host.
grep -Eq 'ps -a[^|]*--format[^|]*\{\{\.ExitCode\}\}' "$here/host-deployer.sh" && fail "host-deployer still asks docker ps for {{.ExitCode}}"
fdscript() { sed "s#^export PATH=.*#export PATH=$T/fd:\$PATH#" "$here/host-deployer.sh" >"$T/fd/hd.sh"; chmod +x "$T/fd/hd.sh"; }
fdscript
"$T/fd/hd.sh" >"$T/out" 2>&1 || { cat "$T/out"; fail "host-deployer (fact-only fake) exited non-zero"; }
node -e '
const c=require(process.argv[1]).checks.container_status;
const bad=m=>{console.error(m, JSON.stringify(c));process.exit(1)};
if(c.total!==7)bad("total should count each container instance once (7 real ones)");
if(c.notRunning!==3)bad("only the cleanly stopped db and the two real failures count");
if(c.unhealthy!==1)bad("the restarting one is unhealthy");
const names=c.stopped.map(s=>s.name).sort().join(",");
if(names!=="bm-cache-1,bm-db-1,bm-worker-1")bad("names: "+names);
if(!c.stopped.every(s=>/^[0-9-]+$/.test(String(s.exit))&&/ago/.test(s.since)))bad("exit/since missing");
' "$D/outbox/host.json" || fail "container_status (fake) is wrong: $(cat "$D/outbox/host.json")"
# A cleanly stopped server/db is a real fault even when it exited 0 (Rod's point 3): only one-shots and the standby hide.
node -e 'const c=require(process.argv[1]).checks.container_status;if(!c.stopped.some(s=>s.name==="bm-db-1"))process.exit(1)' "$D/outbox/host.json" || fail "an exit-0 database must still be named"
# A running container that is failing its health check counts as unhealthy (Rod's point 2).
FAKE_STATUS="Up 3 minutes (unhealthy)" "$T/fd/hd.sh" >"$T/out" 2>&1 || fail "host-deployer (unhealthy running) exited non-zero"
node -e 'const c=require(process.argv[1]).checks.container_status;if(c.unhealthy!==2)process.exit(1)' "$D/outbox/host.json" || fail "a running (unhealthy) container must count"
# BOS-2481: the report names them, by service name only.
node -e 'const c=require(process.argv[1]).checks.container_status;if(c.unhealthyNames!=="srv; bm-cache-1")process.exit(1)' "$D/outbox/host.json" || fail "unhealthy containers must be named by container name: $(cat "$D/outbox/host.json")"
# BOS-2680: the last health probe (exit code, streak, first line, no paths) is reported for the running unhealthy one.
node -e 'const c=require(process.argv[1]).checks.container_status;if(c.unhealthyReason!=="srv (exit 1, 3 failed in a row: cannot stat <path>)")process.exit(1)' "$D/outbox/host.json" || fail "unhealthy reason missing or wrong: $(cat "$D/outbox/host.json")"
# BOS-2481: inside its health-check start period it is settling, not unhealthy (the restarting one still counts).
FAKE_STATUS="Up 20 seconds (unhealthy)" FAKE_STARTED_AGO=20 "$T/fd/hd.sh" >"$T/out" 2>&1 || fail "host-deployer (start period) exited non-zero"
node -e 'const c=require(process.argv[1]).checks.container_status;if(c.unhealthy!==1||c.unhealthyNames!=="bm-cache-1")process.exit(1)' "$D/outbox/host.json" || fail "a container inside its start period must not count: $(cat "$D/outbox/host.json")"
# BOS-2680: a staging runner whose image carries the service label runner-app-co is reported under its own name, with
# its project, stack and company; a production runner (no compose labels) is checked too; a healthy one is not named.
FAKE_RUNNERS=1 FAKE_STATUS="Up 2 hours" "$T/fd/hd.sh" >"$T/out" 2>&1 || fail "host-deployer (runners) exited non-zero"
node -e '
const c=require(process.argv[1]).checks.container_status;
const bad=m=>{console.error(m, JSON.stringify(c));process.exit(1)};
if(c.unhealthyNames!=="bm-cache-1; boss-man-runner-prod-co")bad("names (the staging runner must not count)");
if(/runner-app-co/.test(c.unhealthyNames+c.unhealthyWhere+c.unhealthyReason))bad("the inherited service label must not be used");
if(!c.stagingUnhealthyNames.startsWith("boss-man-staging-runner-staging-co"))bad("staging runner must be listed apart");
if(!c.unhealthyWhere.includes("boss-man-runner-prod-co (company prod-co)")||/staging/.test(c.unhealthyWhere))bad("where");
if(!c.unhealthyReason.includes("boss-man-runner-prod-co (exit 1, 3 failed in a row: cannot stat <path>)"))bad("reason");
if(c.total!==12)bad("total should count the three launcher runners once each and the two staging extras (7 + 3 + 2)");
// BOS-2781: stopped staging containers are listed apart; production counts stay as before.
if(c.stagingStopped!==1||c.stagingStoppedNames!=="staging-db-1")bad("stopped staging container must be listed apart (a restarting one is only in the unhealthy list)");
if(c.stagingUnhealthy!==2||c.stagingUnhealthyNames!=="boss-man-staging-runner-staging-co; staging-cache-1")bad("restarting staging container is staging-unhealthy");
if(c.notRunning!==3||c.stopped.some(s=>/staging/.test(s.name)))bad("staging containers must not count as not running");
' "$D/outbox/host.json" || fail "runner naming wrong: $(cat "$D/outbox/host.json")"
# Past the start period it counts again.
FAKE_STATUS="Up 5 minutes (unhealthy)" FAKE_STARTED_AGO=300 "$T/fd/hd.sh" >"$T/out" 2>&1 || fail "host-deployer (after start period) exited non-zero"
node -e 'const c=require(process.argv[1]).checks.container_status;if(c.unhealthy!==2)process.exit(1)' "$D/outbox/host.json" || fail "a container past its start period must count"
# A one-shot that failed (non-zero exit) is a real failure, not "meant to stop".
FAKE_EXIT=1 "$T/fd/hd.sh" >"$T/out" 2>&1 || fail "host-deployer (failed one-shot) exited non-zero"
node -e 'const s=require(process.argv[1]).checks.container_status.stopped.map(x=>x.name+":"+x.exit);process.stdout.write(s.sort().join(","))' "$D/outbox/host.json" >"$T/names" || true
[[ $(cat "$T/names") == "bm-cache-1:255,bm-db-1:0,bm-worker-1:1" ]] || fail "a failed one-shot must count: $(cat "$T/names")"
# A worker that exited 0 with a normal restart policy is still named, not hidden as a finished one-shot.
FAKE_EXIT=0 "$T/fd/hd.sh" >"$T/out" 2>&1 || fail "host-deployer (all up) exited non-zero"
node -e 'const c=require(process.argv[1]).checks.container_status;if(c.notRunning!==3)process.exit(1)' "$D/outbox/host.json" || fail "only the migrate/netguard one-shots and the standby colour should be ignored"
# BOS-1584: with blue/green on and blue the live colour (running), the stopped green standby is meant to be stopped
# whatever its exit code (docker stop gives 137). Blue/green is on when COMPOSE_FILE names the bluegreen file, and the
# live colour is read from the proxy include.
mkdir -p "$D/proxy"; printf 'reverse_proxy server-blue:3100\n' >"$D/proxy/active.caddy"
bgnames() { COMPOSE_FILE="docker-compose.yml:deploy/truenas-bluegreen.yml" "$T/fd/hd.sh" >"$T/out" 2>&1 || { cat "$T/out"; fail "host-deployer (standby) exited non-zero"; }
  node -e 'const s=require(process.argv[1]).checks.container_status.stopped.map(x=>x.name+":"+x.exit);process.stdout.write(s.sort().join(","))' "$D/outbox/host.json"; }
for gx in 0 137 143 1; do
  [[ $(FAKE_BLUE=running FAKE_GREEN_EXIT=$gx bgnames) == "bm-cache-1:255,bm-db-1:0,bm-worker-1:137" ]] || fail "standby green (exit $gx) beside a running blue must be ignored"
done
# A crashed live colour is still reported: blue is live but not running, so green's stop is not "meant" and blue is named.
names="$(FAKE_BLUE=exited FAKE_BLUE_EXIT=137 FAKE_GREEN_EXIT=137 bgnames)"
[[ $names == *"server-blue:137"* && $names == *"server-green:137"* ]] || fail "a live colour that is down must still be reported, with its standby: $names"
rm -f "$D/proxy/active.caddy"
# BOS-1584: the repo probe goes over the same ssh command a deploy uses. A checkout's core.sshCommand (the deploy key)
# must survive: the probe adds only the no-prompt options. A fake ssh records what it was given and refuses.
printf '#!/usr/bin/env bash\nprintf "%%s\\n" "$*" >>"%s/ssh.args"\nexit 255\n' "$T" >"$T/fd/fakessh"; chmod +x "$T/fd/fakessh"
git -C "$T/src" config core.sshCommand "$T/fd/fakessh -i /keys/deploy_key -o IdentitiesOnly=yes"
git -C "$T/src" remote set-url origin "ssh://someone@git.example.test/repo.git"
rm -f "$D/state/repo-probe" "$T/ssh.args"; host
has "$T/ssh.args" "-i /keys/deploy_key -o IdentitiesOnly=yes"
has "$T/ssh.args" "BatchMode=yes"
git -C "$T/src" config --unset core.sshCommand
git -C "$T/src" remote set-url origin "$T/origin.git"
rm -f "$D/state/repo-probe"; host
# When inspect returns nothing for every container (removed between ps and inspect, or inspect denied), `exit` must
# still be a string so host.json stays valid JSON and the panel keeps every other fact (Rod's must-fix).
FAKE_INSPECT_EMPTY=1 "$T/fd/hd.sh" >"$T/out" 2>&1 || { cat "$T/out"; fail "host-deployer (empty inspect) exited non-zero"; }
node -e '
const h=require(process.argv[1]);
const c=h.checks.container_status;
if(!c||!Array.isArray(c.stopped))process.exit(2);
if(!c.stopped.every(s=>typeof s.exit==="string")){console.error(JSON.stringify(c.stopped));process.exit(3)};
' "$D/outbox/host.json" || fail "an empty inspect must leave a valid host.json with string exits: $(cat "$D/outbox/host.json")"
# ntfy reach (BOS-1466): "running" is not "the server can resolve ntfy". The report says whether the ntfy container
# shares a Docker network with a running server container; false is the blue/green install started without
# deploy/ntfy-bluegreen.yml. Only the ntfy and server service labels answer; network names never appear in host.json.
mkdir -p "$T/nt"; cat >"$T/nt/docker" <<'FAKE'
#!/usr/bin/env bash
if [[ $1 == ps && $2 == --filter ]]; then
  case $3 in
    label=com.docker.compose.service=ntfy) [[ $4 == --format ]] && echo ntfy-1 ;;
    label=com.docker.compose.service=server-green) [[ $4 == --format ]] && echo sg1 ;;
  esac
  exit 0
fi
if [[ $1 == exec && $2 == ntfy-1 && $3 == wget ]]; then
  printf '# TYPE ntfy_subscribers_total gauge\nntfy_subscribers_total %s\n' "${FAKE_NTFY_SUBS:-2}"
  exit 0
fi
if [[ $1 == inspect && $2 == -f ]]; then
  case $4 in
    ntfy-1) [[ $3 == *StartedAt* ]] && echo "2026-11-14T10:00:00.123456789Z" || echo "${FAKE_NTFY_NETS:-bm_edge }" ;;
    sg1) echo "bm_front bm_internal " ;;
  esac
  exit 0
fi
exit 0
FAKE
chmod +x "$T/nt/docker"
sed "s#^export PATH=.*#export PATH=$T/nt:\$PATH#" "$here/host-deployer.sh" >"$T/nt/hd.sh"; chmod +x "$T/nt/hd.sh"
"$T/nt/hd.sh" >"$T/out" 2>&1 || { cat "$T/out"; fail "host-deployer (ntfy fake) exited non-zero"; }
node -e 'const n=require(process.argv[1]).ntfy;if(!n||n.container!=="ntfy-1"||n.serverReach!==false)process.exit(1)' "$D/outbox/host.json" || fail "ntfy on edge only must report serverReach false: $(cat "$D/outbox/host.json")"
hasnt "$D/outbox/host.json" 'bm_front'
FAKE_NTFY_NETS="bm_edge bm_front " "$T/nt/hd.sh" >"$T/out" 2>&1 || { cat "$T/out"; fail "host-deployer (ntfy on front) exited non-zero"; }
node -e 'const n=require(process.argv[1]).ntfy;if(!n||n.serverReach!==true)process.exit(1)' "$D/outbox/host.json" || fail "ntfy on the front network must report serverReach true: $(cat "$D/outbox/host.json")"
# BOS-1589: the report carries when ntfy last started and how many phones are connected now (0 = a silent phone).
node -e 'const n=require(process.argv[1]).ntfy;if(n.startedAt!=="2026-11-14T10:00:00.123456789Z"||n.subscribers!==2)process.exit(1)' "$D/outbox/host.json" || fail "ntfy facts must carry startedAt and subscribers 2: $(cat "$D/outbox/host.json")"
FAKE_NTFY_SUBS=0 "$T/nt/hd.sh" >"$T/out" 2>&1 || { cat "$T/out"; fail "host-deployer (ntfy 0 subscribers) exited non-zero"; }
node -e 'const n=require(process.argv[1]).ntfy;if(n.subscribers!==0)process.exit(1)' "$D/outbox/host.json" || fail "0 subscribers must be reported as 0: $(cat "$D/outbox/host.json")"
# --facts writes the report on demand, with no request and no deploy run (BOS-986), so a fix can be checked at once.
printf '{"id":"x"\n' >"$D/inbox/request.json"
rm -f "$D/outbox/host.json"; : >"$STUB_LOG"
"$T/fd/hd.sh" --facts >"$T/out" 2>&1 || { cat "$T/out"; fail "host-deployer --facts exited non-zero"; }
has "$D/outbox/host.json" '"container_status"'
[[ -e $D/inbox/request.json ]] || fail "--facts took the request"
[[ ! -s $STUB_LOG ]] || fail "--facts ran a deploy: $(cat "$STUB_LOG")"
rm -f "$D/inbox/request.json"
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
# BOS-1469: the refusal is its own record and never replaces the last real result in status.json.
[[ $(jget "$D/outbox/refused.json" result) == rejected ]] || fail "rate limit result"
has "$D/outbox/refused.json" "only one server deploy every 10 minutes"
has "$D/outbox/status.json" "already handled" # the step before's result is still there
! grep -q "only one server deploy" "$D/outbox/status.json" || fail "refusal text leaked into status.json"
[[ $(calls) == 1 ]] || fail "deploy ran despite the rate limit"
has "$T/hook.out" '"result": "rejected"'
node -e '
const fs=require("fs");const lines=fs.readFileSync(process.argv[1],"utf8").split("\n").filter(l=>l.trim());
const p=JSON.parse(lines[lines.length-1]);const got=Object.keys(p).sort().join(",");const want="at,from_commit,message,result,to_commit";
if(got!==want){console.error("keys: "+got);process.exit(1)}
' "$T/hook.out" || fail "webhook payload keys"

# 5. A commit that is not on main is refused (BOS-753: an older commit on main is no longer refused; see 13b).
rm "$D/state/last-server"
side="$(git -C "$T/w" commit-tree "$c1^{tree}" -p "$c1" -m "side branch")"
gpush "$T/w" origin "$side:refs/heads/side"
printf '%s\n' "$side" >"$D/inbox/checked" # even listed as checked: off main is never deployed
req server "$side"
host
[[ $(status result) == rejected ]] || fail "a commit off main was not refused: $(cat "$D/outbox/status.json")"
has "$D/outbox/status.json" "is not on main any more"
[[ ! -e $D/outbox/available.json ]] || fail "a stale offer survived an off-main refusal"
[[ $(calls) == 1 ]] || fail "a commit off main was deployed"
rm -f "$D/inbox/checked"

# 6. A change to deployment files is refused, however it got to main.
c3="$(push docker-compose.yml)"
req server "$c3"
host
has "$D/outbox/status.json" "deployment files (docker-compose.yml"
has "$D/outbox/status.json" "could not compare" # no Compose here to render the settings: hand, with the reason (BOS-2885)
[[ $(calls) == 1 ]] || fail "infra change was deployed"
infra_re="$(grep -o "^INFRA='[^']*'" "$here/host-deployer.sh" | sed "s/^INFRA='//; s/'\$//")"
compose_re="$(grep -o "^COMPOSE_FILES='[^']*'" "$here/host-deployer.sh" | sed "s/^COMPOSE_FILES='//; s/'\$//")"
not_re="$(grep -o "^NOT_INFRA='[^']*'" "$here/host-deployer.sh" | sed "s/^NOT_INFRA='//; s/'\$//")"
# Hand-only whatever the host's settings say: deploy scripts, .env*, and the files under deploy/ that are not Compose files.
for p in scripts/deploy.sh scripts/rebuild-live.sh scripts/update-runner.sh scripts/host-deployer.sh scripts/install-deployer.sh scripts/daily-backup.sh .env.example .dockerignore apps/runner/Dockerfile.dockerignore apps/server/Dockerfile.dockerignore deploy/caddy/Caddyfile deploy/tailscale/serve.json deploy/x.toml deploy/cfg/app.xml deploy/index.html deploy/l; do # daily-backup.sh runs as root in the backup container (BOS-2176)
  if ! echo "$p" | grep -Eq "$infra_re" || echo "$p" | grep -Eq "$compose_re" || echo "$p" | grep -Eq "$not_re"; then fail "$p should count as infra"; fi
done
# Compose files are candidates: hand only when the rendered settings say so (BOS-2885). needs_hand takes them out of INFRA's deploy/ clause.
for p in docker-compose.yml docker-compose.images.yml deploy/x.yml deploy/truenas-bluegreen.yml deploy/check-worker/compose.yaml; do
  if ! echo "$p" | grep -Eq "$compose_re"; then fail "$p should be a compose candidate"; fi
done
# CI files, build inputs (Dockerfiles, .npmrc) and the Penpot and ntfy add-ons don't touch Boss Man's containers.
for p in .github/workflows/ci.yml deploy/penpot.yml scripts/make-app-icons.mjs scripts/check-all.sh scripts/lint-migrations.mjs scripts/restore-test.sh deploy/ntfy.yml deploy/ntfy-bluegreen.yml apps/server/Dockerfile apps/updater/Dockerfile .npmrc; do
  if { echo "$p" | grep -Eq "$infra_re" && ! echo "$p" | grep -Eq "$compose_re" || echo "$p" | grep -Eq "$compose_re"; } && ! echo "$p" | grep -Eq "$not_re"; then fail "$p should not count as infra"; fi
done

# The host's .env must stay out of every image (BOS-2908): .dockerignore excludes it, at the top and in any folder.
for pat in '.env' '.env.*' '**/.env' '**/.env.*'; do
  grep -Fxq -- "$pat" "$here/../.dockerignore" || fail ".dockerignore does not exclude $pat"
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

# 7c. (BOS-2213) The refusal names which check failed, and for an empty id or a short commit (the two ways the
# original BOS-1817 flake could have looked: status.json then also shows id "" and to_commit "") it says so.
rm -f "$D/outbox/status.json"; : >"$D/inbox/request.json"; host
has "$D/outbox/status.json" "the file is empty"
rm -f "$D/outbox/status.json"
printf '{"id":"","target":"server","commit":"%s",%s}\n' "$c3" "$good" >"$D/inbox/request.json"; host
has "$D/outbox/status.json" "expected format (the id is not"
rm -f "$D/outbox/status.json"
printf '{"id":"11111111-1111-1111-1111-111111111114","target":"server","commit":"abc123",%s}\n' "$good" >"$D/inbox/request.json"; host
has "$D/outbox/status.json" "(the commit is not one 40-character hash)"
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
# 8a (BOS-947). A card for a commit the server has moved past still builds, from the version the server runs.
req runner "$base"; host
[[ $(status result) == deployed && $(status to_commit) == "$head" && $(status requested_commit) == "$base" ]] || fail "8a: older runner card: $(cat "$D/outbox/status.json")"
has "$D/outbox/status.json" "built from the version the server runs now; the card named ${base:0:8}"
has "$STUB_LOG" "update-runner.sh"
# 8b. A commit that is not part of what the server runs (a switch-back) is refused, in plain words, with what to press.
# Its own branch name: step 7 already pushed an unrelated "side" branch, and pushing over it failed (silently) every run.
git -C "$T/w" checkout -q -b switch-back "$base" && echo side >"$T/w/side.txt" && git -C "$T/w" add -A && git -C "$T/w" commit -qm side && gpush "$T/w" origin switch-back
side="$(git -C "$T/w" rev-parse HEAD)"; git -C "$T/w" checkout -q - ; git -C "$T/src" fetch -q origin switch-back
rm -f "$D/state/last-runner"; before="$(calls)"
req runner "$side"; host
[[ $(status result) == rejected ]] || fail "8b: side commit: $(cat "$D/outbox/status.json")"
has "$D/outbox/status.json" "Open Settings → Server and runner → Updates and press Build and update runners"
rm -f "$D/state/last-runner"
req runner "$head"; host
[[ $(status result) == deployed && $(status target) == runner ]] || fail "runner status"
has "$STUB_LOG" "update-runner.sh"
hasnt "$STUB_LOG" "update-runner.sh --now" # the runner target drains; --now is for a person at the host

# 9. A failed deploy reports the failure, keeps the status honest and posts the webhook.
git -C "$T/w" reset -q --hard "$c2"; gpush "$T/w" -f origin HEAD:main # drop the compose change from main
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

# 12b. Memory headroom (BOS-420): published every tick in its own file, mode 644, valid JSON.
host
has "$D/outbox/headroom.json" '"totalMb": 32768, "availableMb": 29296'
has "$D/outbox/headroom.json" '"swapTotalMb": 2048, "swapUsedMb": 0'
has "$D/outbox/headroom.json" '"needMb": 4096, "needFrom": "build"' # one server: the build allowance and the margin
hasnt "$D/outbox/headroom.json" '"holding"'
[[ $(stat -c %a "$D/outbox/headroom.json") == 644 ]] || fail "headroom.json is not mode 644"
node -e 'JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"))' "$D/outbox/headroom.json" || fail "headroom.json is not JSON: $(cat "$D/outbox/headroom.json")"
DEPLOY_MIN_FREE_MB=1500 host
has "$D/outbox/headroom.json" '"needMb": 1500, "needFrom": "setting"'
# A container limit /proc/meminfo doesn't show (an LXC without lxcfs): 4 GiB allowed, 3.5 GiB used = 512 MB free.
echo 4294967296 >"$T/cgroup/memory.max"; echo 3758096384 >"$T/cgroup/memory.current"; host
has "$D/outbox/headroom.json" '"totalMb": 4096, "availableMb": 512'
printf 'anon 1\ninactive_file 268435456\n' >"$T/cgroup/memory.stat"; host # 256 MB of that is cache the kernel can drop
has "$D/outbox/headroom.json" '"totalMb": 4096, "availableMb": 768'
rm -f "$T/cgroup/memory.stat"
echo max >"$T/cgroup/memory.max"; host # cgroup v2 "max" = no limit
has "$D/outbox/headroom.json" '"totalMb": 32768, "availableMb": 29296'
rm -f "$T/cgroup/memory.max" "$T/cgroup/memory.current"
# 12c. The floor: below it a request stays in the inbox (logged once, shown in headroom.json), a dry run says so,
# and the owner's "Update now anyway" (quiet: override) is taken; the update's lowest free memory is then logged.
rm -f "$D/state/last-server"; meminfo 33554432 2097152 1048576 # 2048 MB free, 1024 MB of swap in use
req server "$c4"; before="$(calls)"; host; host
[[ -e $D/inbox/request.json && $(calls) == "$before" ]] || fail "a request was taken below the memory floor"
has "$D/outbox/headroom.json" '"holding": "low memory"'
has "$D/outbox/headroom.json" '"swapUsedMb": 1024'
[[ $(grep -c "Holding the update request: 2048 MB free, an update needs 4096 MB (build)" "$D/deployer.log") == 1 ]] || fail "the hold was not logged exactly once: $(grep Holding "$D/deployer.log")"
host --dry-run; has "$T/out" "[dry-run] would hold the request"
DEPLOY_MIN_FREE_MB=1000 host --dry-run; has "$T/out" "[dry-run] checks passed" # a lower floor set by the owner lets it through
[[ -e $D/inbox/request.json ]] || fail "dry run took the request"
printf '{"id":"%s","target":"server","commit":"%s","requestedAt":"2026-10-20T12:00:00.000Z","approvedBy":"owner-1","quiet":"override"}\n' "$(node -e 'console.log(crypto.randomUUID())')" "$c4" >"$D/inbox/request.json"
host
[[ $(status result) == deployed && $(status to_commit) == "$c4" ]] || fail "override request not deployed: $(cat "$D/outbox/status.json")"
has "$D/deployer.log" "the owner chose to update now"
has "$D/deployer.log" "Memory during the update to ${c4:0:8}: lowest free 2048 MB (at before-build), swap use peaked at 1024 MB."
[[ ! -e $D/state/holding && ! -e $D/state/mem-low ]] || fail "hold or samples left behind"
meminfo; host
hasnt "$D/outbox/headroom.json" '"holding"'
has "$D/outbox/headroom.json" "\"lastUpdate\": {\"commit\": \"$c4\", \"lowMb\": 2048, \"lowAt\": \"before-build\", \"swapPeakMb\": 1024}"
node -e 'JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"))' "$D/outbox/headroom.json" || fail "headroom.json is not JSON: $(cat "$D/outbox/headroom.json")"
# A host that can't read its memory never holds, and still writes a record.
rm -f "$D/state/last-server"; c4b="$(push apps/server/c4b)"; mv "$T/meminfo" "$T/meminfo.off"; req server "$c4b"; host
[[ $(status to_commit) == "$c4b" ]] || fail "no memory numbers held a request: $(cat "$D/outbox/status.json")"
hasnt "$D/outbox/headroom.json" '"availableMb"'
mv "$T/meminfo.off" "$T/meminfo"
# Only a server update is held (Freddy, BOS-420): a runner update has no wait, card or "Update now", so the floor must
# not leave it stuck in the inbox. Below the floor it is taken as before.
rm -f "$D/state/last-runner"; meminfo 33554432 2097152; req runner "$(git -C "$T/src" rev-parse HEAD)"; host
[[ ! -e $D/inbox/request.json && $(status target) == runner && $(status result) == deployed ]] || fail "a runner update was held by the memory floor: $(cat "$D/outbox/status.json")"
hasnt "$D/outbox/headroom.json" '"holding"'
meminfo

# 13. The config file must be private; the runner-path rule matches deploy.sh.
chmod 644 "$D/host.conf"
if "$here/host-deployer.sh" >/dev/null 2>&1; then fail "world-readable config accepted"; fi
chmod 600 "$D/host.conf"
a="$(grep -o "^RUNNER_PATHS='[^']*'" "$here/host-deployer.sh" | sed "s/^RUNNER_PATHS='//; s/'\$//")"
grep -qF -- "grep -Eq '$a'" "$here/deploy.sh" || fail "runner paths differ between host-deployer.sh and deploy.sh"

# 13b. Restart (BOS-647), single server: deploy.sh --force at the commit that runs; never a fetch or a move.
rm -f "$D/state/last-server" "$D/state/last-restart"
head="$(git -C "$T/src" rev-parse HEAD)"; before="$(calls)"
req restart "$head"; host --dry-run
has "$T/out" "would run: scripts/deploy.sh --yes --no-runner --force --commit ${head:0:8}"
rm -f "$D/inbox/request.json"
req restart "$head"; host
[[ $(status result) == deployed && $(status target) == restart && $(status to_commit) == "$head" ]] || fail "restart status: $(cat "$D/outbox/status.json")"
has "$D/outbox/status.json" "Restarted at ${head:0:8}"
has "$STUB_LOG" "deploy.sh --yes --no-runner --force --commit $head"
[[ $(calls) == $((before + 1)) && $(git -C "$T/src" rev-parse HEAD) == "$head" ]] || fail "restart moved the checkout or ran twice"
# It shares the server's rate limit (one slot, state/last-server), both ways.
[[ -e $D/state/last-server && ! -e $D/state/last-restart ]] || fail "restart did not use the server's rate-limit slot"
req restart "$head"; host
[[ $(jget "$D/outbox/refused.json" result) == rejected ]] || fail "second restart inside the limit: $(cat "$D/outbox/refused.json")"
has "$D/outbox/refused.json" "updated or restarted less than 10 minutes ago"
[[ $(status result) == deployed && $(status target) == restart ]] || fail "the refused restart replaced the real result: $(cat "$D/outbox/status.json")"
[[ $(calls) == $((before + 1)) ]] || fail "a restart ran inside the rate limit"
# A commit that is not what runs (an update ran since the click): refused, nothing runs.
rm -f "$D/state/last-server"
req restart "$base"; host
[[ $(status result) == rejected ]] || fail "restart of another commit: $(cat "$D/outbox/status.json")"
has "$D/outbox/status.json" "The version running changed since you asked"
[[ $(calls) == $((before + 1)) && $(git -C "$T/src" rev-parse HEAD) == "$head" ]] || fail "a restart for another commit ran something"
# Only the exact lower-case target is accepted.
req Restart "$head"; host; has "$D/outbox/status.json" "expected format"
# A restart that fails its health check says so.
STUB_RC=1 STUB_RESULT=failed req restart "$head"; STUB_RC=1 STUB_RESULT=failed host
[[ $(status result) == failed && $(status target) == restart ]] || fail "failed restart: $(cat "$D/outbox/status.json")"
# 13g. BOS-753: main moved on after the owner approved (a merge between the card and the press, or before this tick).
# The approval is not refused: the newest commit on main that the merge gate checked goes out, and the status says so.
# It starts from what runs now (the restart tests above left main and the checkout at $head).
rm -f "$D/state/last-server"
deployed="$(git -C "$T/src" rev-parse HEAD)"
c5="$(push apps/server/d)"; c6="$(push apps/server/e)" # main: deployed c5 c6; c6 has not passed its check yet
printf '%s\n' "$c5" >"$D/inbox/checked"
before="$(calls)"
req server "$deployed"; host
[[ $(status result) == deployed && $(status to_commit) == "$c5" && $(status requested_commit) == "$deployed" ]] || fail "13g: newest checked commit not deployed: $(cat "$D/outbox/status.json")"
has "$STUB_LOG" "deploy.sh --yes --no-runner --commit $c5"
has "$D/outbox/status.json" "Deployed ${deployed:0:8} to ${c5:0:8}. You approved ${deployed:0:8}; main had moved on to ${c6:0:8}"
has "$D/outbox/status.json" "have not passed their merge check yet. ${c5:0:8} is the newest one that has"
[[ $(status runner_changed) == false ]] || fail "13g: runner_changed: $(cat "$D/outbox/status.json")"
[[ $(calls) == $((before + 1)) ]] || fail "13g: deploy ran $(($(calls) - before)) times"
# 13h. Deploy latest pressed for the tip, then two more merges land, both checked: the new tip goes out, and the runner
# change it brings is reported, though the card's own range had none.
rm -f "$D/state/last-server"
c7="$(push apps/runner/src/x)"; c8="$(push apps/server/f)"
printf '%s\n' "$c5" "$c6" "$c7" "$c8" >"$D/inbox/checked"
before="$(calls)"
req server "$c6"; host
[[ $(status result) == deployed && $(status to_commit) == "$c8" && $(status requested_commit) == "$c6" ]] || fail "13h: tip not deployed: $(cat "$D/outbox/status.json")"
has "$D/outbox/status.json" "You approved ${c6:0:8}; main had moved on to ${c8:0:8} by the time the deployer ran, so the deployer took that newest checked version instead."
[[ $(status runner_changed) == true ]] || fail "13h: runner_changed: $(cat "$D/outbox/status.json")"
[[ $(calls) == $((before + 1)) ]] || fail "13h: deploy ran $(($(calls) - before)) times"
# 13i. An older server that writes no checked list: the approved commit goes out as approved (still on main), not a refusal.
rm -f "$D/state/last-server" "$D/inbox/checked"
c9="$(push apps/server/g)"; c10="$(push apps/server/h)"
req server "$c9"; host
[[ $(status result) == deployed && $(status to_commit) == "$c9" ]] || fail "13i: approved commit not deployed: $(cat "$D/outbox/status.json")"
has "$D/outbox/status.json" "Boss Man did not say which newer commits passed their merge check, so the deployer kept to ${c9:0:8}"
# 13j. A newer checked commit that needs a hand-apply is skipped: the approved one goes out, and the status says why.
rm -f "$D/state/last-server"
c11="$(push docker-compose.yml)"
printf '%s\n' "$c10" "$c11" >"$D/inbox/checked"
req server "$c10"; host
[[ $(status result) == deployed && $(status to_commit) == "$c10" ]] || fail "13j: $(cat "$D/outbox/status.json")"
has "$D/outbox/status.json" "the newer commits change deployment files and have to be applied by hand"
git -C "$T/w" reset -q --hard "$c10"; gpush "$T/w" -f origin HEAD:main # drop the compose change again
# 13k. A stale card for a commit that already runs: nothing new, never a refusal, and no newer unchecked commit is taken.
rm -f "$D/state/last-server" "$D/inbox/checked"
req server "$c10"; host
[[ $(status result) == nothing_new && $(status to_commit) == "$c10" ]] || fail "13k: $(cat "$D/outbox/status.json")"

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
if [[ $1 == stats ]]; then # stats --no-stream --format {{.MemUsage}} <id>
  [[ -n ${FAKE_STATS:-} ]] || exit 1
  echo "$FAKE_STATS"; exit 0
fi
if [[ $1 == inspect && $3 == *compose.project* ]]; then echo bmtest; exit 0; fi # the project label (BOS-487)
if [[ $1 == inspect && $3 == "{{.State.StartedAt}}" ]]; then # the start time of the database (BOS-487)
  echo "docker inspect $*" >>"$DL"; cat "$W/started.db" 2>/dev/null || true; exit 0
fi
if [[ $1 == inspect ]]; then # inspect -f <format> cid<service>: id, start, restarts, oom, running, exit code (BOS-488)
  s=${4#cid}; f() { cat "$W/$1.$s" 2>/dev/null || echo "$2"; }
  r=false; [[ -e $W/running.$s ]] && r=true
  echo "cid$s $(f start 2026-11-07T08:00:00Z) $(f restarts 0) $(f oom false) $r $(f exit 0)"; exit
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
  "ps -aq "*) x=${a#ps -aq }; x=${x#server-}; [[ -e $W/running.$x || -e $W/exists.$x ]] && echo "cid$x" || true ;;
  "exec -T db psql"*) cat "$W/pgstart" 2>/dev/null || echo "2026-11-07 08:00:00.5+00" ;;
  "--project-name "*" config --hash"*) # one line per svc-<name> file in the unpacked commit, as Compose's --hash prints them
    [[ -z ${FAKE_NO_HASH:-} ]] || { echo "unknown flag: --hash" >&2; exit 1; }
    [[ -z ${FAKE_NO_RENDER:-} ]] || exit 1
    echo "render $PWD" >>"$DL"; for f in svc-*; do [[ ! -f $f ]] || echo "${f#svc-} $(sha256sum <"$f" | cut -d' ' -f1)"; done ;;
  "--project-name "*" config") # the same settings as a rendered file, for a Compose without --hash
    [[ -z ${FAKE_NO_RENDER:-} ]] || exit 1
    echo "name: p"; echo "services:"; for f in svc-*; do [[ ! -f $f ]] || { echo "  ${f#svc-}:"; if [[ $(head -n 1 "$f") == "#yaml" ]]; then tail -n +2 "$f" | sed 's/^/    /'; else echo "    image: $(cat "$f")"; fi; }; done; echo "volumes:"; echo "  data: {}" ;;
  "exec -T db pg_dump"*) echo dump ;;
  "up -d --no-deps backup") # BOS-2176; BOS-2221: the daily folder must already exist (made by the host user, not by Docker)
    [[ -d $BOSSMAN_BACKUP_DIR/daily ]] && echo "daily folder ready" >>"$DL"; echo "ensure backup service" >>"$DL" ;;
  "build server-"*) c=${a#build server-}; [[ -z ${FAKE_BUILD_FAIL:-} ]] || exit 1; if [[ -n ${FAKE_BUILD_NET_ONCE:-} && ! -e $W/net-failed ]]; then : >"$W/net-failed"; echo "ERROR: failed to fetch anonymous token: Get https://auth.docker.io/token: dial tcp: connect: network is unreachable" >&2; exit 1; fi; [[ -z ${FAKE_BUILD_NET_ALWAYS:-} ]] || { echo "ERROR: failed to fetch anonymous token: network is unreachable" >&2; exit 1; }; [[ -z ${FAKE_BUILD_CODE_ERR:-} ]] || { echo "ERROR: process did not complete successfully: exit code: 2 (tsc error TS2304)" >&2; echo "build-attempt" >>"$W/code-attempts"; exit 1; };[[ -z ${FAKE_BUILD_HANG:-} ]] || exec sleep 30; echo "$BOSSMAN_COMMIT" >"$W/built.$c"; echo "build $c commit=$BOSSMAN_COMMIT" >>"$DL" ;;
  "run --rm --no-deps migrate") echo "migrate tag=$BOSSMAN_MIGRATE_TAG" >>"$DL"; exit "${FAKE_MIGRATE_RC:-0}" ;;
  "up -d --no-deps --force-recreate server-"*) c=${a##*server-}; touch "$W/running.$c"; cp "$W/built.$c" "$W/commit.$c"; echo standby >"$W/role.$c" ;;
  "up -d --no-deps server-"*) c=${a##*server-}; touch "$W/running.$c"; echo standby >"$W/role.$c" ;;
  "kill -s USR1 server-"*) c=${a##*server-}; echo "signal USR1 $c" >>"$DL"; [[ -n ${FAKE_NO_DEMOTE:-} ]] || echo standby >"$W/role.$c" ;;
  "kill -s USR2 server-"*) c=${a##*server-}; echo "signal USR2 $c" >>"$DL"; echo leader >"$W/role.$c" ;;
  "stop server-"*) echo "plain stop without a grace: $a" >>"$DL"; exit 98 ;; # BOS-794: every planned stop names its grace
  "stop -t "*" server-"*) c=${a##*server-}; echo "stop grace ${a#stop -t }" >>"$DL"; rm -f "$W/running.$c"; touch "$W/exists.$c"; echo "stopped $c" >>"$DL" ;;
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
  rm -rf "$W"; mkdir -p "$W"; touch "$W/running.proxy" "$W/running.db" "$W/running.$1"; echo leader >"$W/role.$1"; echo "$2" >"$W/commit.$1"
  rm -rf "$D/proxy" "$D/state/soak" "$D/state/previous" "$D/state/hold" "$D/state/baseline" "$D/state/stopped-by-plan" "$D/state/last-health-alert" "$D/state/planned-db" "$D/outbox/health.json"; mkdir -p "$D/proxy"; chmod 755 "$D/proxy"
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
order "$DL" "pg_dump" "ensure backup service" "build green commit=$b1" "migrate tag=green" "up -d --no-deps --force-recreate server-green" "exec -T server-green" "signal USR1 blue" "signal USR2 green" "validate sees green" "reload now green" "exec -T proxy wget"
hasnt "$DL" "build blue" # only the idle colour is built
order "$DL" "daily folder ready" "ensure backup service" # BOS-2221: folder exists before the service starts
[[ $(stat -c %u "$BOSSMAN_BACKUP_DIR/daily") == "$(stat -c %u "$BOSSMAN_BACKUP_DIR")" ]] || fail "daily folder owner differs from the backup folder"
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
# Memory (BOS-420): measuring goes on through the standby window, so nothing is reported yet.
[[ -s $D/state/mem-low ]] || fail "no memory samples kept during the swap"
hasnt "$D/deployer.log" "Memory during the update to ${b1:0:8}"

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
has "$D/deployer.log" "Memory during the update to ${b1:0:8}: lowest free 29296 MB"
[[ ! -e $D/state/mem-low ]] || fail "memory samples left after the window"
# 16a. On blue/green an update also needs room for a second server: a freshly started one (DEPLOY_NEW_SERVER_MB, 4096),
# or the cap when that is smaller; plus the build allowance and the margin. What the live one uses is reported beside it
# but never raises the need: a leaking live server must not hold back the update that replaces it.
bg; has "$D/outbox/headroom.json" '"needMb": 8192, "needFrom": "fresh", "newServerMb": 4096'
hasnt "$D/outbox/headroom.json" "liveServerMb" # Docker can't say: nothing reported
FAKE_STATS="17.5GiB / 31.3GiB" bg; has "$D/outbox/headroom.json" '"needMb": 8192, "needFrom": "fresh", "newServerMb": 4096, "liveServerMb": 17920'
FAKE_STATS="900MiB / 31.3GiB" bg; has "$D/outbox/headroom.json" '"needMb": 8192, "needFrom": "fresh", "newServerMb": 4096, "liveServerMb": 900'
BOSSMAN_SERVER_MEMORY=12g FAKE_STATS="10.5GiB / 31.3GiB" bg; has "$D/outbox/headroom.json" '"needMb": 8192, "needFrom": "fresh"' # a cap above a fresh server changes nothing
BOSSMAN_SERVER_MEMORY=2g bg; has "$D/outbox/headroom.json" '"needMb": 6144, "needFrom": "limit", "newServerMb": 2048'
DEPLOY_NEW_SERVER_MB=3000 bg; has "$D/outbox/headroom.json" '"needMb": 7096, "needFrom": "fresh", "newServerMb": 3000'
DEPLOY_NEW_SERVER_MB=lots bg; has "$D/outbox/headroom.json" '"needMb": 8192, "needFrom": "fresh"' # not a number: the default

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
has "$D/outbox/status.json" "migration failed"; hasnt "$DL" "up -d --no-deps server";hasnt "$DL" "signal"
# BOS-2058 (rule b): a build that hangs is stopped at BG_BUILD_SECONDS; the update fails, nothing starts, the live colour stays.
reset_world blue "$cur"; git -C "$T/src" reset -q --hard "$P"; bgreq "$b4"
FAKE_BUILD_HANG=1 BG_BUILD_SECONDS=1 bg
[[ $(status result) == failed ]] || fail "hung build: $(cat "$D/outbox/status.json")"
has "$D/outbox/status.json" "did not finish within"
hasnt "$DL" "migrate"; hasnt "$DL" "up -d --no-deps server"; hasnt "$DL" "signal"; live_is blue
[[ $(git -C "$T/src" rev-parse HEAD) == "$P" ]] || fail "hung build: checkout not put back"
# BOS-2552: a build that fails once on a registry/network error is retried once, and the first error is kept in the log.
reset_world blue "$cur"; git -C "$T/src" reset -q --hard "$P"; bgreq "$b4"
FAKE_BUILD_NET_ONCE=1 BG_BUILD_RETRY_PAUSE=0 bg
[[ $(status result) == deployed ]] || fail "network error then pass: $(cat "$D/outbox/status.json")"
has "$D/deployer.log" "registry or network error"; has "$D/deployer.log" "network is unreachable"
[[ $(grep -c '^build green' "$DL") == 1 ]] || fail "retry: expected one finished build"
# Both attempts hit the network error: one retry only, then the update fails and says why.
reset_world blue "$cur"; git -C "$T/src" reset -q --hard "$P"; bgreq "$b4"
FAKE_BUILD_NET_ALWAYS=1 BG_BUILD_RETRY_PAUSE=0 bg
[[ $(status result) == failed ]] || fail "network error twice: $(cat "$D/outbox/status.json")"
has "$D/outbox/status.json" "retry failed too"; hasnt "$DL" "up -d --no-deps server"; live_is blue
# A real build error is not retried.
reset_world blue "$cur"; git -C "$T/src" reset -q --hard "$P"; bgreq "$b4"
FAKE_BUILD_CODE_ERR=1 BG_BUILD_RETRY_PAUSE=0 bg
[[ $(status result) == failed ]] || fail "code error: $(cat "$D/outbox/status.json")"
[[ $(wc -l <"$W/code-attempts") == 1 ]] || fail "code error was retried"
hasnt "$D/deployer.log" "Trying once more"
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
git -C "$T/w" reset -q --hard "$b5^"; gpush "$T/w" -f origin HEAD:main # drop case 21 Caddyfile commit
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

# 23. Restart (BOS-647), blue/green: a fresh copy of the commit that runs, swapped in like an update; no fetch, no move.
reset_world blue "$P"; git -C "$T/src" reset -q --hard "$P"
echo "green $cur" >"$D/state/previous"; echo "$b6" >"$D/state/hold"; before="$(calls)"
rm -f "$D/state/last-server"; req restart "$P"; bg --dry-run
has "$T/out" "would run: a blue/green restart (fresh copy) at ${P:0:8}"; rm -f "$D/inbox/request.json"
req restart "$P"; bg
[[ $(status result) == deployed && $(status target) == restart && $(status to_commit) == "$P" ]] || fail "bg restart status: $(cat "$D/outbox/status.json")"
has "$D/outbox/status.json" "Restarted at ${P:0:8}: a fresh green is live"
order "$DL" "pg_dump" "build green commit=$P" "migrate tag=green" "up -d --no-deps --force-recreate server-green" "signal USR1 blue" "signal USR2 green" "reload now green"
live_is green; [[ -e $W/running.blue && $(cat "$W/role.green") == leader ]] || fail "world after a bg restart"
[[ $(git -C "$T/src" rev-parse HEAD) == "$P" && $(calls) == "$before" ]] || fail "bg restart moved the checkout or ran deploy.sh"
has "$D/state/soak" "old=blue new=green"; has "$D/state/soak" "commit=$P prev=$P"
# The rebuilt colour held the release before: the rollback record goes, so --rollback refuses rather than "going back" to the same code.
[[ ! -e $D/state/previous ]] || fail "state/previous kept after a restart"
[[ $(cat "$D/state/hold") == "$b6" ]] || fail "a restart dropped the hold on a rejected release"
# A restart during the trial window is refused: it would rebuild the copy the window switches back to.
: >"$DL"; rm -f "$D/state/last-server"; req restart "$P"; bg
[[ $(status result) == rejected ]] || fail "restart during the trial: $(cat "$D/outbox/status.json")"
has "$D/outbox/status.json" "still in its 15-minute trial"; hasnt "$DL" "pg_dump"; live_is green
# The fresh copy fails its checks during the window: switched back to the copy it replaced, worded as a restart.
: >"$DL"; FAKE_VERIFY_FAIL=green bg
[[ $(status result) == rolled_back && $(status target) == restart ]] || fail "restart switch-back: $(cat "$D/outbox/status.json")"
has "$D/outbox/status.json" "The fresh copy started by the restart was switched back"
live_is blue; [[ $(git -C "$T/src" rev-parse HEAD) == "$P" ]] || fail "checkout moved by a restart switch-back"
# A restart that was cut off is marked failed like an update, and a trial window for another version is dropped.
reset_world blue "$P"; git -C "$T/src" reset -q --hard "$P"
printf '{"id": "%s", "target": "restart", "result": "running", "message": "Running", "from_commit": "%s", "to_commit": "%s", "started": "2026-11-08T10:00:00Z", "ended": "", "at": "2026-11-08T10:00:00Z", "backup": ""}\n' "44444444-4444-4444-4444-444444444444" "$P" "$P" >"$D/outbox/status.json"
printf 'old=blue new=green deadline=%s commit=%s prev=%s\n' "$(($(date +%s) + 900))" "$b1" "$P" >"$D/state/soak"
: >"$DL"; bg
[[ $(status result) == failed && $(status target) == restart ]] || fail "interrupted restart: $(cat "$D/outbox/status.json")"
has "$D/outbox/status.json" "The restart run for ${P:0:8} was cut off"
[[ ! -e $D/state/soak ]] || fail "soak for a version that is not running kept after an interrupted restart"
hasnt "$DL" "signal"; live_is blue

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

# 32. BOS-487: which services an update changes, read from each service's rendered settings (fake files svc-<name>), and
# which of db/proxy still run with older settings. Nothing here may start, stop or recreate a container.
svc_check() { rm -f "$D/state/last-server"; : >"$D/inbox/check"; : >"$DL"; bg; } # a refresh, as the cron tick does it
avail() { jget "$D/outbox/available.json" "$1"; }
no_changes_made() { ! grep -qE '^docker (up|run|restart|stop|kill|rm|build|exec)' "$DL" || fail "the refresh changed something: $(cat "$DL")"; }
at() { git -C "$T/src" fetch -q origin; git -C "$T/src" reset -q --hard "$1"; }
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
git -C "$T/w" rm -q svc-server; git -C "$T/w" commit -qm "drop svc-server"; gpush "$T/w" origin HEAD:main
sG="$(git -C "$T/w" rev-parse HEAD)"; at "$sF"; svc_check; has "$D/outbox/available.json" '"changedServices": ["server"]'
sH="$(push svc-extra)"; at "$sG"; svc_check; has "$D/outbox/available.json" '"changedServices": ["extra"]'
# the same render works for a Compose without --hash (it hashes each service block of the rendered file)
FAKE_NO_HASH=1 svc_check; has "$D/outbox/available.json" '"changedServices": ["extra"]'; has "$D/outbox/available.json" '"servicesChecked": true'
at "$sD"; FAKE_NO_HASH=1 svc_check; has "$D/outbox/available.json" '"changedServices": ["db", "extra", "proxy", "server"]'
# it can't render: reported as not checked, an update is still offered, and the reason is in the log
FAKE_NO_RENDER=1 svc_check; has "$D/outbox/available.json" '"servicesChecked": false'; has "$D/outbox/available.json" '"changedServices": []'
has "$D/outbox/available.json" "\"tip\": \"$sH\""; has "$D/deployer.log" "could not be rendered"
[[ ! -e $D/state/render ]] || fail "the render folder was left behind after a failure"
# it can't unpack the commit: reported as not checked, the reason is logged, and docker is never asked to render the
# empty folder (BOS-1690: the unpack's failure check is a plain function call now, not a negated subshell with a redirect)
# shellcheck disable=SC2016  # the fake's own script text: it expands when the fake runs
printf '#!/usr/bin/env bash\n[[ -z ${FAKE_NO_UNPACK:-} ]] || { echo "tar: fake unpack failure" >&2; exit 2; }\nexec "%s" "$@"\n' "$(command -v tar)" >"$T/bin/tar"; chmod +x "$T/bin/tar"
FAKE_NO_UNPACK=1 svc_check; has "$D/outbox/available.json" '"servicesChecked": false'; has "$D/deployer.log" "could not unpack"
has "$D/deployer.log" "tar: fake unpack failure"; hasnt "$DL" "config"
[[ ! -e $D/state/render ]] || fail "the render folder was left behind after a failed unpack"
rm -f "$T/bin/tar"
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
# 32b. BOS-2885: Compose and deploy/ files send an update to the hand path only when THIS host's rendered settings change in a
# way the swap can't apply. infraPaths in available.json is the same verdict the refusal and pick_newest_checked use.
pushc() { # file content...: change a file to exactly this content (one line per argument) and push main; prints the sha
  mkdir -p "$(dirname "$T/w/$1")"; printf '%s\n' "${@:2}" >"$T/w/$1"
  git -C "$T/w" add -A; git -C "$T/w" commit -qm "set $1"; gpush "$T/w" origin HEAD:main; git -C "$T/w" rev-parse HEAD
}
pushc2() { # two files in one commit: file1 content1 file2 (a random line)
  mkdir -p "$(dirname "$T/w/$1")" "$(dirname "$T/w/$3")"; printf '%s\n' "$2" >"$T/w/$1"; echo "$RANDOM" >"$T/w/$3"
  git -C "$T/w" add -A; git -C "$T/w" commit -qm "set $1 and $3"; gpush "$T/w" origin HEAD:main; git -C "$T/w" rev-parse HEAD
}
hand_of() { # live-commit: what the host reports for the tip now on main
  at "$1"; svc_check; jget "$D/outbox/available.json" infraPaths
}
auto() { [[ $(hand_of "$1") == "" ]] || fail "$2 should be automatic: $(cat "$D/outbox/available.json")"; hasnt "$D/outbox/available.json" handReason; }
handed() { # live-commit what reason
  [[ $(hand_of "$1") == *"$2"* ]] || fail "$2 should be hand: $(cat "$D/outbox/available.json")"
  has "$D/outbox/available.json" "$3"
}
# The cases push Compose changes to main and leave them there, so they run at the end of the file (hand_cases), after
# every section that deploys from main.
hand_cases() {
nl=$'\n'
# BOS-2910: Dockerfiles that already name a build frontend are part of what runs
pushc apps/synA/Dockerfile '# syntax=docker/dockerfile:1.7' 'FROM scratch' 'RUN echo a' >/dev/null
pushc apps/synB/Dockerfile '# syntax=docker/dockerfile:1.7' 'FROM scratch' >/dev/null
pushc apps/synC/Dockerfile 'FROM scratch' >/dev/null
sBase="$(pushc svc-server '#yaml' 'image: srv' 'environment:' '  A: one')"
# a compose file nothing renders from, an updater Dockerfile and an unloaded overlay: automatic
live="$sBase"; pushc docker-compose.images.yml "x$RANDOM" >/dev/null; auto "$live" "an unloaded compose file"
pushc apps/updater/Dockerfile "x$RANDOM" >/dev/null; auto "$live" "a Dockerfile"
pushc deploy/check-worker/compose.yaml "x$RANDOM" >/dev/null; auto "$live" "an unloaded overlay"
pushc .npmrc "x$RANDOM" >/dev/null; auto "$live" ".npmrc"
# BOS-2910: a Dockerfile change that keeps its syntax line (or has none) stays automatic
pushc apps/synA/Dockerfile '# syntax=docker/dockerfile:1.7' 'FROM scratch' 'RUN echo b' >/dev/null; auto "$live" "a RUN edit that keeps the syntax line"
pushc apps/synC/Dockerfile 'FROM scratch' 'RUN echo c' >/dev/null; auto "$live" "a Dockerfile with no syntax line"
# an ordinary server setting (its environment) changes: automatic
pushc2 svc-server $'#yaml\nimage: srv\nenvironment:\n  A: two' docker-compose.yml >/dev/null; auto "$live" "an ordinary server setting"
# db or proxy settings change: their own card, so hand, with the reason
sDb="$(pushc2 svc-db $'#yaml\nimage: pg2' docker-compose.yml)"; handed "$live" docker-compose.yml "it changes the db service"
live="$sDb" # the db change is part of what runs from here on
# a server service gains host reach: each one is hand
for reach in $'volumes:\n  - type: bind\n    source: /host/x\n    target: /x' $'privileged: true' $'cap_add:\n  - NET_ADMIN' $'devices:\n  - /dev/x:/dev/x' $'network_mode: host' $'pid: host' $'security_opt:\n  - seccomp:unconfined'; do
  pushc2 svc-server "#yaml${nl}image: srv${nl}environment:${nl}  A: one${nl}$reach" docker-compose.yml >/dev/null
  handed "$live" docker-compose.yml "the server gains access to the host"
done
# keys outside the server allow-list (BOS-2885 security review): volumes_from, group_add, build, env_file, cgroup, uts, user: hand
for odd in $'volumes_from:\n  - launcher' $'group_add:\n  - "998"' $'build:\n  context: /' $'env_file:\n  - /host/secrets.env' $'cgroup: host' $'uts: host' $'user: root'; do
  pushc2 svc-server "#yaml${nl}image: srv${nl}environment:${nl}  A: one${nl}$odd" docker-compose.yml >/dev/null
  handed "$live" docker-compose.yml "setting, which the host does not apply by itself"
done
# a named volume is not host reach; a bind that was already there is not gained
pushc2 svc-server $'#yaml\nimage: srv\nvolumes:\n  - type: volume\n    source: data\n    target: /data' docker-compose.yml >/dev/null; auto "$live" "a named volume"
live="$(pushc svc-server '#yaml' 'image: srv' 'privileged: true')"
pushc2 svc-server $'#yaml\nimage: srv2\nprivileged: true' docker-compose.yml >/dev/null; auto "$live" "a reach that was already there"
# a render that fails: hand, and the reason says so
pushc docker-compose.yml "x$RANDOM" >/dev/null
FAKE_NO_RENDER=1 handed "$live" docker-compose.yml "could not compare"
# files that are not Compose settings stay hand-only: the Caddyfile is mounted, so a render can't see it change
pushc deploy/caddy/Caddyfile "x$RANDOM" >/dev/null; handed "$live" deploy/caddy/Caddyfile ""
hasnt "$D/outbox/available.json" handReason
pushc deploy/prometheus.toml "x$RANDOM" >/dev/null; handed "$live" deploy/prometheus.toml ""
pushc deploy/cfg/app.xml "x$RANDOM" >/dev/null; handed "$live" deploy/cfg/app.xml ""
# a build-only change next to a hand-only one lists only the hand-only file
pushc apps/updater/Dockerfile "x$RANDOM" >/dev/null; [[ $(hand_of "$live") != *updater/Dockerfile* ]] || fail "a Dockerfile was listed as a hand file"
# BOS-2910: a change to a "# syntax=" line picks the build frontend, which can read the host's .env: hand
pushc apps/synA/Dockerfile '# syntax=example.com/evil/frontend:1' 'FROM scratch' 'RUN echo b' >/dev/null; handed "$live" apps/synA/Dockerfile ""
pushc apps/synB/Dockerfile 'FROM scratch' >/dev/null; handed "$live" apps/synB/Dockerfile ""
pushc apps/synC/Dockerfile '# SYNTAX = example.com/evil/frontend:1' 'FROM scratch' >/dev/null; handed "$live" apps/synC/Dockerfile ""
pushc apps/synD/Dockerfile '#syntax=example.com/evil/frontend:1' 'FROM scratch' >/dev/null; handed "$live" apps/synD/Dockerfile ""
}

# no deploy path starts, stops or recreates the database or the proxy: the server deploy rolls the colours only (DR-020 B)
for f in host-deployer.sh rebuild-live.sh deploy.sh; do
  # Any compose up/run/restart/stop/kill/rm/create/down (also in the hint text) must name only the server colours,
  # the server or the launcher: every `up` and `run` carries --no-deps, and none names db or proxy. A bare
  # `up -d` or `restart` therefore fails here.
  if grep -nE '(compose|docker)[^#]* (up|run|restart|stop|kill|rm|create|down)\b' "$here/$f" \
    | grep -vE '^[0-9]+:\s*#|exec -T |rm -f |^[0-9]+:\s*finish (partial|failed) ' \
    | grep -vE '(up|run)\b.*--no-deps .*(server|launcher|migrate|backup|\$\{svcs\[@\]\})|(stop|kill)\b.*"?server' ; then
    fail "$f has a compose up/run/restart/stop/kill/rm/create/down that is not limited to the server services"
  fi
  if grep -nE '(compose|docker)[^#]* (up|run|restart|stop|kill|rm|create|down)\b[^#]*\b(db|proxy)\b' "$here/$f" | grep -vE '^[0-9]+:\s*#|exec -T (db|proxy)|--no-deps migrate'; then
    fail "$f starts or recreates db or proxy"
  fi
done
# 31. The whole-stack checklist (DR-020 D, BOS-488): five items, recorded in outbox/health.json and in the status file.
hget() { jget "$D/outbox/health.json" "$1"; }
swap() { # a good swap to a new commit, blue -> green; then a clean log and webhook file
  local c
  reset_world blue "$cur"; git -C "$T/src" reset -q --hard "$P"
  c="$(push "apps/server/hc$RANDOM")"; bgreq "$c"; bg
  [[ $(status result) == deployed ]] || fail "setup swap: $(cat "$D/outbox/status.json") $(cat "$T/out")"
  SW="$c"; : >"$DL"; : >"$T/hook.out"
}
all_pass() { local i; for i in live other leader db restarts; do [[ $(hget "check_$i") == pass ]] || fail "check_$i: $(cat "$D/outbox/health.json")"; done; }
failed_only() { # item...: exactly these items fail
  local i w=" $* "
  for i in live other leader db restarts; do
    if [[ $w == *" $i "* ]]; then [[ $(hget "check_$i") == fail ]] || fail "check_$i should fail: $(cat "$D/outbox/health.json")"
    else [[ $(hget "check_$i") == pass ]] || fail "check_$i should pass: $(cat "$D/outbox/health.json")"; fi
  done
}
# 31a. Healthy swap and healthy tick: every item passes, in health.json and in the status file.
swap
[[ $(hget stack) == healthy && $(hget phase) == swap && $(hget commit) == "$SW" ]] || fail "health after swap: $(cat "$D/outbox/health.json")"
all_pass
has "$D/outbox/status.json" '"stack": "healthy"'; has "$D/outbox/status.json" '"check_db": "pass"'
bg; [[ $(hget phase) == soak ]] || fail "a soak tick did not run the checklist"; all_pass
# 31b. The standby crashed during the trial: degraded, one page, nothing switched, and no repeat page.
rm -f "$W/running.blue"; echo 137 >"$W/exit.blue"; touch "$W/exists.blue"
bg
failed_only other
[[ $(hget stack) == degraded && $(hget check_other) == fail && $(hget check_live) == pass ]] || fail "crashed standby: $(cat "$D/outbox/health.json")"
[[ $(status result) == partial ]] || fail "crashed standby should page as partial: $(cat "$D/outbox/status.json")"
has "$D/outbox/status.json" "server-blue should be running as a standby"
hasnt "$DL" "signal"; live_is green; [[ -e $D/state/soak ]] || fail "the window was ended by a degraded tick"
bg; bg
[[ $(grep -c '"result": "partial"' "$T/hook.out") == 1 ]] || fail "expected one page, got: $(cat "$T/hook.out")"
rm -f "$W/exit.blue" "$W/exists.blue"; touch "$W/running.blue"; echo standby >"$W/role.blue"
bg; all_pass; [[ ! -e $D/state/last-health-alert ]] || fail "alert marker kept after recovery"
# 31c. Two leaders: degraded, no switch.
swap; echo leader >"$W/role.blue"; bg
failed_only other leader
has "$D/outbox/health.json" "2 leaders"; live_is green; hasnt "$DL" "signal"
# 31c2. Two leaders at the deadline: stopping the old colour fixes it, so the end check passes and nothing is paged.
swap; echo leader >"$W/role.blue"; sed -i 's/deadline=[0-9]*/deadline=1/' "$D/state/soak"; bg
[[ $(hget phase) == end && $(hget stack) == healthy ]] || fail "two leaders at the deadline: $(cat "$D/outbox/health.json")"
[[ $(status result) != partial ]] || fail "empty page after a healthy end check: $(cat "$D/outbox/status.json")"
[[ ! -s $T/hook.out ]] || ! grep -q '"result": "partial"' "$T/hook.out" || fail "paged on a healthy end check"
# 31d. No leader at all: the live check fails first, so it is switched back; the record still says why.
swap; echo standby >"$W/role.green"; bg
[[ $(status result) == rolled_back ]] || fail "no leader: $(cat "$D/outbox/status.json")"
[[ $(hget check_leader) == fail ]] || fail "no-leader record: $(cat "$D/outbox/health.json")"; has "$D/outbox/health.json" "0 leaders"
# 31e. The database was recreated or its process restarted: degraded (a failure, never a pass).
swap; echo 2026-11-07T09:00:00Z >"$W/start.db"; bg
failed_only db; [[ $(status result) == partial ]] || fail "recreated db: $(cat "$D/outbox/status.json")"
swap; echo "2026-11-07 09:00:00+00" >"$W/pgstart"; bg
failed_only db; has "$D/outbox/health.json" "server process restarted"
# 31f. A planned database step re-baselines once; the next tick is healthy again.
swap; echo 2026-11-07T09:00:00Z >"$W/start.db"; echo "2026-11-07 09:00:00+00" >"$W/pgstart"; touch "$D/state/planned-db"; bg
all_pass; [[ ! -e $D/state/planned-db ]] || fail "planned-db marker kept"
# 31g. Restarts and OOM kills of each container count.
for s in blue green db proxy; do swap; echo 1 >"$W/restarts.$s"; bg; [[ $(hget check_restarts) == fail ]] || fail "restart of $s not seen: $(cat "$D/outbox/health.json")"; done
swap; echo true >"$W/oom.green"; bg; [[ $(hget check_restarts) == fail ]] || fail "OOM kill not seen"; has "$D/outbox/health.json" "running out of memory"
# 31h. The end of the window: the old colour is stopped by plan (exit 0, recorded) and that is healthy.
swap; sed -i 's/deadline=[0-9]*/deadline=1/' "$D/state/soak"; bg
[[ $(hget phase) == end ]] || fail "no end-of-window check"; all_pass
grep -qx blue "$D/state/stopped-by-plan" || fail "planned stop not recorded"
has "$DL" "stop grace 60 server-blue"; has "$D/deployer.log" "Stopped server-blue in"
# 31h1 (QA, BOS-826 on BOS-794). The grace is BG_STOP_SECONDS; a value that is not 1-4 digits falls back to 60 rather than
# reaching `compose stop -t` (an empty or negative -t, or a shell injection through the env, must not).
swap; sed -i 's/deadline=[0-9]*/deadline=1/' "$D/state/soak"; BG_STOP_SECONDS=7 bg
has "$DL" "stop grace 7 server-blue"; all_pass
for bad in abc -5 12345 "7; touch $T/injected" ""; do
  swap; sed -i 's/deadline=[0-9]*/deadline=1/' "$D/state/soak"; BG_STOP_SECONDS="$bad" bg
  has "$DL" "stop grace 60 server-blue"
done
[[ ! -e $T/injected ]] || fail "BG_STOP_SECONDS was run as shell"
# 31h2 (BOS-794). A planned stop that outlived its grace and needed SIGKILL (137), or ended on SIGTERM (143), is still planned:
# healthy, not paged, and the detail says it needed SIGKILL.
for x in 137 143; do
  swap; sed -i 's/deadline=[0-9]*/deadline=1/' "$D/state/soak"; echo "$x" >"$W/exit.blue"; bg
  [[ $(hget phase) == end ]] || fail "no end check for a planned stop with exit $x"; all_pass
  [[ $(status result) != partial ]] || fail "a planned stop with exit $x paged: $(cat "$D/outbox/status.json")"
  [[ $x != 137 ]] || has "$D/outbox/health.json" "needed SIGKILL after"
done
# The same grace on a stop by hand or a recreate: the compose file sets it for both colours.
grep -qE '^  stop_grace_period: [0-9]+s$' "$here/../deploy/truenas-bluegreen.yml" || fail "x-server has no stop_grace_period"
# ...but OOM-killed after the plan stop, a planned stop with another exit code, an unplanned 137, or running when the plan says stopped, is not.
swap; sed -i 's/deadline=[0-9]*/deadline=1/' "$D/state/soak"; echo 137 >"$W/exit.blue"; echo true >"$W/oom.blue"; bg
[[ $(hget phase) == end && $(hget check_other) == fail ]] || fail "OOM kill after the plan stop: $(cat "$D/outbox/health.json")"; has "$D/outbox/health.json" "server-blue was killed for running out of memory"
rm -f "$W/oom.blue"
swap; sed -i 's/deadline=[0-9]*/deadline=1/' "$D/state/soak"; echo 1 >"$W/exit.blue"; bg
[[ $(hget check_other) == fail ]] || fail "exit 1 after the plan stop: $(cat "$D/outbox/health.json")"; has "$D/outbox/health.json" "exited with code 1"
swap; sed -i 's/deadline=[0-9]*/deadline=1/' "$D/state/soak"; echo 137 >"$W/exit.blue"; bg; all_pass
grep -vx blue "$D/state/stopped-by-plan" >"$T/sbp" || true; cp "$T/sbp" "$D/state/stopped-by-plan"
! BG_POLL_SECONDS=0 SOAK_CHECK_SECONDS=1 "$T/hd.sh" --ack-health >"$T/out" 2>&1 || fail "ack passed with an unplanned exit 137: $(cat "$T/out")"
[[ $(hget check_other) == fail ]] || fail "unplanned exit 137: $(cat "$D/outbox/health.json")"; has "$D/outbox/health.json" "exit code 137, so it crashed or was killed"
# 31j. A failed item other than the live colour does not keep the window open: the old colour is still stopped at the deadline,
# the stop is recorded, the end check says degraded, and there is one page that names the way to accept the new state.
swap; echo 1 >"$W/restarts.proxy"; sed -i 's/deadline=[0-9]*/deadline=1/' "$D/state/soak"; bg
[[ ! -e $D/state/soak ]] || fail "a restarts failure kept the window open"
grep -qx blue "$D/state/stopped-by-plan" || fail "window end did not record the planned stop"
[[ $(hget phase) == end && $(hget check_restarts) == fail && $(hget check_other) == pass ]] || fail "window end with a restart: $(cat "$D/outbox/health.json")"
[[ $(status result) == partial ]] || fail "window end with a restart should page: $(cat "$D/outbox/status.json")"
has "$D/outbox/status.json" "--ack-health"
live_is green
# ...and --ack-health accepts the current state: baseline renewed, checklist healthy.
bg --ack-health; all_pass; [[ $(hget phase) == ack ]] || fail "ack did not re-run the checklist: $(cat "$D/outbox/health.json")"
# BOS-794: the passing ack replaces the page in the status file, so the server stops saying "degraded"; nothing_new, not deployed.
[[ $(status result) == nothing_new && $(status target) == server ]] || fail "ack did not clear the partial status: $(cat "$D/outbox/status.json")"
has "$D/outbox/status.json" "Health accepted"; has "$D/outbox/status.json" '"stack": "healthy"'
# A second ack has no page to replace and leaves the status file alone.
cp "$D/outbox/status.json" "$T/st.before"; bg --ack-health; cmp -s "$T/st.before" "$D/outbox/status.json" || fail "a second ack rewrote the status file"
# 31k. The same for the database, and an unreadable database start time (a hung or unreachable psql) is a failed db item.
swap; echo 2026-11-07T09:00:00Z >"$W/start.db"; sed -i 's/deadline=[0-9]*/deadline=1/' "$D/state/soak"; bg
[[ ! -e $D/state/soak ]] || fail "a db failure kept the window open"; [[ $(hget check_db) == fail ]] || fail "db at window end"
swap; : >"$W/pgstart"; bg
[[ $(hget check_db) == fail ]] || fail "no psql answer should fail the db item: $(cat "$D/outbox/health.json")"; has "$D/outbox/health.json" "could not read the database"
rm -f "$W/pgstart"
# 31i. A swap whose database was recreated mid-deploy is not declared good: switched back.
reset_world blue "$cur"; git -C "$T/src" reset -q --hard "$P"
c="$(push apps/server/hc-db)"; bgreq "$c"
# the fake restarts the database as soon as the new colour is started
mv "$T/bin/docker" "$T/bin/docker.real"
# shellcheck disable=SC2016 # the wrapper script is written literally; $W and $* expand when it runs
printf '#!/usr/bin/env bash\ncase "$*" in *"up -d --no-deps --force-recreate server-"*) echo 2026-11-07T09:00:00Z >"$W/start.db" ;; esac\nexec "%s" "$@"\n' "$T/bin/docker.real" >"$T/bin/docker"; chmod +x "$T/bin/docker"
bg
mv "$T/bin/docker.real" "$T/bin/docker"
[[ $(status result) == rolled_back ]] || fail "db restarted during the swap: $(cat "$D/outbox/status.json")"
has "$D/outbox/status.json" "whole-stack check found"; live_is blue

# --- The staging lane (BOS-1472): its own request/status files, main-only commits, smoke checks, memory hold ---
cat >"$T/w/scripts/deploy-staging.sh" <<'STUB'
#!/usr/bin/env bash
echo "deploy-staging.sh $* production_dirs=${BOSSMAN_PRODUCTION_DIRS:-}" >>"$STUB_LOG"
[[ -z ${STUB_STAGING_RC:-} ]] || { echo "build step failed: image pull denied"; echo "login with password=hunter2 rejected"; echo "curl -H Authorization: Bearer faketoken123 failed"; echo "retry Authorization: Basic dXNlcjpwYXNz failed"; echo "sent bearer standalone55 once"; exit "$STUB_STAGING_RC"; }
git checkout --quiet "$1"
STUB
cat >"$T/w/scripts/smoke-staging.sh" <<'STUB'
#!/usr/bin/env bash
echo "smoke-staging.sh $2 before=${SMOKE_PRODUCTION_BEFORE-unset}" >>"$STUB_LOG"
printf 'address\tpass\tanswers\n'
if [[ -n ${SMOKE_CREDENTIALS:-} && -f $SMOKE_CREDENTIALS ]]; then printf 'signin\tpass\tsigned in\n'; else printf 'signin\tskipped\tnot set up\n'; fi
printf 'runner\tpass\trunner connected, image abc123\n'
if [[ -n ${STUB_SMOKE_FAIL:-} ]]; then printf 'board\tfail\tHTTP 500\n'; exit 1; fi
STUB
chmod +x "$T"/w/scripts/*.sh
git -C "$T/w" add -A; git -C "$T/w" commit -qm "staging stubs"; gpush "$T/w" origin HEAD:main
s1="$(git -C "$T/w" rev-parse HEAD)"
git clone -q "$T/origin.git" "$T/stg"
# A commit that is on a side branch only, never on main.
git -C "$T/w" checkout -q -b side; echo side >"$T/w/side.txt"; git -C "$T/w" add -A; git -C "$T/w" commit -qm side
side="$(git -C "$T/w" rev-parse HEAD)"; git -C "$T/w" push -q origin HEAD:refs/heads/staging-offmain || fail "could not push the side branch"; git -C "$T/w" checkout -q -
git -C "$T/w" reset -q --hard "$s1"
sreq() { # commit [id]
  printf '{"id":"%s","target":"staging","commit":"%s","requestedAt":"2026-10-20T12:00:00.000Z","approvedBy":"owner-1"}\n' "${2:-$(node -e 'console.log(crypto.randomUUID())')}" "$1" >"$D/inbox/staging-request.json"
}
sstatus() { jget "$D/outbox/staging-status.json" "$1"; }
# BOS-2592: a refused (rejected) request is recorded in staging-refused.json, not staging-status.json.
srefused() { jget "$D/outbox/staging-refused.json" "$1"; }
R="$D/outbox/staging-refused.json"
: >"$STUB_LOG"; rm -f "$D/outbox/status.json" "$D/outbox/history.jsonl"

# Lane off (no STAGING_DIR): the lane file says so and a request is answered, not left waiting.
conf 0; host
has "$D/outbox/staging-lane.json" '"configured": "false"'
sreq "$s1"; host
[[ $(srefused result) == rejected ]] || fail "lane off: $(cat "$R")"
has "$R" "not configured"
[[ ! -e $D/inbox/staging-request.json ]] || fail "lane off left the request in the inbox"
hasnt "$STUB_LOG" "deploy-staging.sh"
# A symlinked request is never read (BOS-1775): the id behind it must not reach the world-readable status file.
printf '{"id":"secret"}\n' >"$T/secret-target.json"; ln -s "$T/secret-target.json" "$D/inbox/staging-request.json"; host
[[ $(srefused result) == rejected ]] || fail "lane off, symlink: $(cat "$R")"
hasnt "$R" "secret"
hasnt "$D/outbox/staging-history.jsonl" "secret"
# A plain file whose id is not a UUID is not echoed either.
printf '{"id":"secret"}\n' >"$D/inbox/staging-request.json"; host
hasnt "$R" "secret"

# Lane on: a main commit deploys, then the smoke checks run, with production's folder passed for the isolation checks.
conf 0; printf 'STAGING_DIR=%s\nSTAGING_RATE_LIMIT_SECONDS=3600\n' "$T/stg" >>"$D/host.conf"
host
has "$D/outbox/staging-lane.json" '"configured": "true"'
sid="$(node -e 'console.log(crypto.randomUUID())')"
sreq "$s1" "$sid"; host
[[ $(sstatus result) == deployed && $(sstatus smoke) == passed && $(sstatus check_address) == pass && $(sstatus check_signin) == skipped ]] || fail "staging deploy: $(cat "$D/outbox/staging-status.json")"
[[ $(sstatus to_commit) == "$s1" && $(sstatus id) == "$sid" && $(sstatus runner_image) == abc123 ]] || fail "staging status fields: $(cat "$D/outbox/staging-status.json")"
[[ $(git -C "$T/stg" rev-parse HEAD) == "$s1" ]] || fail "the stub did not check out the commit"
has "$STUB_LOG" "deploy-staging.sh $s1 production_dirs=$(cd "$T/src" && pwd)"
has "$STUB_LOG" "smoke-staging.sh $s1 before="
has "$D/outbox/staging-history.jsonl" "$sid"
[[ ! -e $D/outbox/status.json ]] || fail "a staging deploy wrote production's status.json"
hasnt "$D/outbox/history.jsonl" "$sid"
[[ ! -e $D/inbox/staging-request.json ]] || fail "the staging request was not taken"

# Replay: the same id is refused. Rate limit: a new id within the window is refused.
sreq "$s1" "$sid"; host
has "$R" "already handled"
[[ $(sstatus result) == deployed && $(sstatus id) == "$sid" ]] || fail "a replay refusal replaced the last real staging record: $(cat "$D/outbox/staging-status.json")"
sreq "$s1"; host
# BOS-2592: the refusal goes to staging-refused.json; the real record (the deploy above) is left exactly as it was.
has "$R" "only one staging deploy"
[[ $(sstatus result) == deployed && $(sstatus id) == "$sid" ]] || fail "a rate-limit refusal replaced the last real staging record: $(cat "$D/outbox/staging-status.json")"
hasnt "$D/outbox/staging-status.json" "only one staging deploy"
[[ $(grep -c "^deploy-staging.sh" "$STUB_LOG") == 1 ]] || fail "staging deployed more than once: $(cat "$STUB_LOG")"

# Only main: a commit on a side branch is refused before anything runs.
rm -f "$D/state/last-staging"; sreq "$side"; host
has "$R" "is not on main"
[[ $(grep -c "^deploy-staging.sh" "$STUB_LOG") == 1 ]] || fail "a non-main commit reached deploy-staging.sh"
# A commit from before the lane (no scripts/smoke-staging.sh) is refused, and the lane file says which repository staging follows.
rm -f "$D/state/last-staging"; sreq "$c1"; host
has "$R" "older than the staging lane"
[[ $(grep -c "^deploy-staging.sh" "$STUB_LOG") == 1 ]] || fail "a pre-lane commit reached deploy-staging.sh"
has "$D/outbox/staging-lane.json" "\"origin\": \"$T/origin.git\""
# A malformed request (shell characters in the commit) is refused.
# shellcheck disable=SC2016 # the command substitution is literal text in the request: it must never be run
printf '{"id":"%s","target":"staging","commit":"$(touch %s/pwned)","requestedAt":"2026-10-20T12:00:00.000Z","approvedBy":"owner-1"}\n' "$sid" "$T" >"$D/inbox/staging-request.json"; host
has "$R" "expected format"; [[ ! -e $T/pwned ]] || fail "request text was executed"
# A production request target is not accepted in the staging file.
printf '{"id":"%s","target":"server","commit":"%s","requestedAt":"2026-10-20T12:00:00.000Z","approvedBy":"owner-1"}\n' "$(node -e 'console.log(crypto.randomUUID())')" "$s1" >"$D/inbox/staging-request.json"; host
has "$R" "expected format"

# Memory: held (left in the inbox) while an update would not have room; taken when memory frees up.
rm -f "$D/state/last-staging"; meminfo 33554432 100; sreq "$s1"; host
[[ $(sstatus result) == held && -e $D/inbox/staging-request.json ]] || fail "low memory did not hold staging: $(cat "$D/outbox/staging-status.json")"
hasnt "$D/outbox/staging-history.jsonl" '"held"'
meminfo; host
[[ $(sstatus result) == deployed && ! -e $D/inbox/staging-request.json ]] || fail "held staging request not taken after memory freed: $(cat "$D/outbox/staging-status.json")"

# Smoke account file: used only when it is a plain file with mode 600 of ours; its values are never in the outbox.
printf 'smoke_username=s\nsmoke_password=hunter2\n' >"$D/smoke-credentials"; chmod 600 "$D/smoke-credentials"
rm -f "$D/state/last-staging"; sreq "$s1"; host
[[ $(sstatus check_signin) == pass ]] || fail "smoke account not used: $(cat "$D/outbox/staging-status.json")"
hasnt "$D/outbox/staging-status.json" hunter2
chmod 644 "$D/smoke-credentials"; rm -f "$D/state/last-staging"; sreq "$s1"; host
[[ $(sstatus check_signin) == skipped ]] || fail "a world-readable smoke account file was used"
rm -f "$D/smoke-credentials"

# A failing smoke check is reported with its name; a failing deploy is "failed" and smoke is not run.
rm -f "$D/state/last-staging"; sreq "$s1"; STUB_SMOKE_FAIL=1 host
[[ $(sstatus smoke) == failed && $(sstatus failed_checks) == board && $(sstatus check_board) == fail ]] || fail "smoke failure: $(cat "$D/outbox/staging-status.json")"
rm -f "$D/state/last-staging"; : >"$STUB_LOG"; sreq "$s1"; STUB_STAGING_RC=1 host
[[ $(sstatus result) == failed && $(sstatus smoke) == skipped ]] || fail "deploy failure: $(cat "$D/outbox/staging-status.json")"
hasnt "$STUB_LOG" "smoke-staging.sh"
# The failed record carries the run's last log lines, with secrets blanked, so nobody has to open the host.
has "$D/outbox/staging-status.json" "image pull denied"
has "$D/outbox/staging-status.json" "password=[redacted]"
hasnt "$D/outbox/staging-status.json" "hunter2"
# The whole credential after Bearer or Basic goes, not just the scheme word (BOS-2209).
hasnt "$D/outbox/staging-status.json" "faketoken123"
hasnt "$D/outbox/staging-status.json" "dXNlcjpwYXNz"
hasnt "$D/outbox/staging-status.json" "standalone55"

# A staging deploy cut off by a restart leaves "running" behind: the next tick marks it failed, so the lane isn't wedged (review).
cut="$(node -e 'console.log(crypto.randomUUID())')"
printf '{"id":"%s","target":"staging","result":"running","message":"Running","to_commit":"%s","started":"2026-10-20T12:00:00Z","ended":"","at":"2026-10-20T12:00:00Z"}\n' "$cut" "$s1" >"$D/outbox/staging-status.json"
: >"$STUB_LOG"; host
[[ $(sstatus result) == failed && $(sstatus id) == "$cut" ]] || fail "cut-off staging run not marked failed: $(cat "$D/outbox/staging-status.json")"
has "$D/outbox/staging-status.json" "cut off"
hasnt "$STUB_LOG" "deploy-staging.sh"

# A production request waiting is handled first; the staging request waits for the next tick.
rm -f "$D/state/last-staging" "$D/state/last-server"; sreq "$s1"; : >"$STUB_LOG"
c2="$(push apps/server/b)"; (cd "$T/src" && git fetch -q origin main); req server "$c2"; host
[[ -e $D/inbox/staging-request.json ]] || fail "staging ran ahead of a waiting production request"
rm -f "$D/inbox/staging-request.json"
# The staging section left host.conf pointing at the staging checkout; the sections below set their own.
conf 0

# ================= BOS-1004: "Create phone login" (inbox/phone-login.json), fake docker, fake ntfy =================
# The deployer makes the phone's read-only ntfy user inside the ntfy container and returns the password sealed to the
# public key in the request. The password must be in no file the deployer writes and on no command line.
unset COMPOSE_FILE
PL="$T/pl"; PLW="$PL/world"; PLLOG="$PL/docker.log"; PD="$PL/deployer"
mkdir -p "$PL/bin" "$PLW" "$PD/inbox" "$PD/outbox"; : >"$PLLOG"; : >"$PLW/users"
sed "s#^export PATH=.*#export PATH=$PL/bin:\$PATH#" "$here/host-deployer.sh" >"$PL/hd.sh"; chmod +x "$PL/hd.sh"
printf 'REPO=%s\nAVAILABLE_REFRESH_SECONDS=0\n' "$T/src" >"$PD/host.conf"; chmod 600 "$PD/host.conf"
cat >"$PL/bin/docker" <<'FAKE'
#!/usr/bin/env bash
# A pretend ntfy container: users in a file, passwords kept apart so the test can compare them. Logs arguments only.
echo "docker $*" >>"$PLLOG"
if [[ $1 == ps ]]; then printf '%s' "${PL_CIDS-abc123def456}" | tr ' ' '\n' | grep . || true; exit 0; fi
[[ $1 == exec && $2 == -e && $3 == NTFY_PASSWORD ]] || { echo "fake docker: unhandled: $*" >&2; exit 98; }
shift 3; cid=$1; shift; [[ $1 == ntfy ]] || exit 98; shift
if [[ -n ${PL_FAIL:-} && $1 == "$PL_FAIL" ]]; then echo "boom: the password is ${NTFY_PASSWORD:-none}" >&2; exit 1; fi
case "$1 $2" in
  "token list") grep -q . "$PLW/tokens.$3" 2>/dev/null && printf 'user %s (role: user, tier: none)\n- %s (no label), never expires\n' "$3" "$(cat "$PLW/tokens.$3")" || printf 'user %s (role: user, tier: none)\n' "$3" ;;
  "token add") [[ $3 == bossman-publish ]] || exit 97; printf 'tk_%s' "$(printf 'a%.0s' $(seq 1 29))" >"$PLW/tokens.$3"; printf 'token %s created for user %s, never expires\n' "$(cat "$PLW/tokens.$3")" "$3" ;;
  "user list") [[ -n ${PL_NOPUB:-} ]] || printf 'user bossman-publish (role: user, tier: none)\n- write-only access to topic x\n'; sed 's/.*/user & (role: user, tier: none)/' "$PLW/users" ;;
  "user add") [[ $3 == --role=user && ${NTFY_PASSWORD:-} =~ ^[A-Za-z0-9]{24}$ ]] || exit 97; echo "$4" >>"$PLW/users"; printf '%s' "$NTFY_PASSWORD" >"$PLW/pw.$4" ;;
  "user change-pass") [[ ${NTFY_PASSWORD:-} =~ ^[A-Za-z0-9]{24}$ ]] || exit 97; printf '%s' "$NTFY_PASSWORD" >"$PLW/pw.$3" ;;
  access*) [[ $3 == read-only || $4 == read-only || $4 == write-only ]] || exit 97; echo "$*" >>"$PLW/acl" ;;
  *) echo "fake ntfy: unhandled: $*" >&2; exit 98 ;;
esac
FAKE
chmod +x "$PL/bin/docker"
export PLLOG PLW
openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out "$PL/key.pem" 2>/dev/null
pubb64() { openssl pkey -in "$1" -pubout -outform DER 2>/dev/null | base64 -w0; }
PUB="$(pubb64 "$PL/key.pem")"
plreq() { # action user topic pubkey [id]: write a request the way the server does; sets PLID
  PLID="${5:-$(node -e 'console.log(crypto.randomUUID())')}"
  printf '{"id":"%s","action":"%s","user":"%s","topic":"%s","pubkey":"%s"}\n' "$PLID" "$1" "$2" "$3" "$4" >"$PD/inbox/phone-login.json"
  rm -f "$PD/state/last-phone-login"
}
plhost() { BOSSMAN_DEPLOYER="$PD" "$PL/hd.sh" >"$T/out" 2>&1 || { cat "$T/out"; fail "host-deployer exited non-zero (phone login)"; }; }
plx() { grep '^docker exec' "$PLLOG" | grep -vc ' wget -qO- http://localhost:9090/metrics' || true; } # how many commands ran inside a container (the tick's own read-only ps/inspect and the ntfy metrics read don't count)
plres() { jget "$PD/outbox/phone-login.json" "$1"; }
unseal() { jget "$PD/outbox/phone-login.json" sealed | base64 -d | openssl pkeyutl -decrypt -inkey "$PL/key.pem" -pkeyopt rsa_padding_mode:oaep -pkeyopt rsa_oaep_md:sha256 -pkeyopt rsa_mgf1_md:sha256; }
no_plaintext() { # the password must be in nothing the deployer or the log wrote, nor on any command line
  [[ -n $1 ]] || fail "empty password"
  ! grep -rqF -- "$1" "$PD" "$PLLOG" "$T/out" "$T/hook.out" 2>/dev/null || fail "the password is in the clear in: $(grep -rlF -- "$1" "$PD" "$PLLOG" "$T/out" 2>/dev/null)"
}
# PL1. Create: the user is added with the role and access fixed here, and the password comes back sealed only.
plreq create phone-read alerts "$PUB"; plhost
[[ $(plres result) == created && $(plres id) == "$PLID" ]] || fail "PL1: $(cat "$PD/outbox/phone-login.json")"
[[ ! -e $PD/inbox/phone-login.json ]] || fail "PL1: the request was left in the inbox"
pw1="$(unseal)"; [[ $pw1 =~ ^[A-Za-z0-9]{24}$ && $pw1 == "$(cat "$PLW/pw.phone-read")" ]] || fail "PL1: the sealed password does not decrypt to the one ntfy was given"
no_plaintext "$pw1"
has "$PLLOG" "docker exec -e NTFY_PASSWORD abc123def456 ntfy user add --role=user phone-read"
has "$PLLOG" "docker exec -e NTFY_PASSWORD abc123def456 ntfy access phone-read alerts read-only"
has "$PD/state/phone-login.log" " $PLID created phone-read"
# PL2. The same create again: the user exists, nothing changes, nothing is sealed.
plreq create phone-read alerts "$PUB"; : >"$PLLOG"; plhost
[[ $(plres result) == exists && -z $(plres sealed) ]] || fail "PL2: $(cat "$PD/outbox/phone-login.json")"
hasnt "$PLLOG" "user add"; hasnt "$PLLOG" "change-pass"; [[ $(cat "$PLW/pw.phone-read") == "$pw1" ]] || fail "PL2: the password changed"
# PL3. Reset: a new password, access applied again, and an old request id is never run twice.
plreq reset phone-read alerts "$PUB"; ID3=$PLID; : >"$PLLOG"; plhost
[[ $(plres result) == reset ]] || fail "PL3: $(cat "$PD/outbox/phone-login.json")"
pw3="$(unseal)"; [[ $pw3 != "$pw1" && $pw3 == "$(cat "$PLW/pw.phone-read")" ]] || fail "PL3: reset did not change the password"
no_plaintext "$pw3"; no_plaintext "$pw1"
has "$PLLOG" "ntfy user change-pass phone-read"; has "$PLLOG" "ntfy access phone-read alerts read-only"
plreq reset phone-read alerts "$PUB" "$ID3"; : >"$PLLOG"; plhost
hasnt "$PLLOG" "change-pass" # the same id again is ignored
[[ $(plres id) == "$ID3" ]] || fail "PL3: a replay overwrote the answer"
# PL4. Reset of a user that is not there.
cp "$PLW/users" "$PLW/users.keep"; : >"$PLW/users"
plreq reset phone-read alerts "$PUB"; : >"$PLLOG"; plhost
[[ $(plres result) == missing ]] || fail "PL4: $(cat "$PD/outbox/phone-login.json")"; hasnt "$PLLOG" "change-pass"
cp "$PLW/users.keep" "$PLW/users"
# PL4b. Only phone-read: an existing admin (or any other) user is never reset, and docker is not touched.
echo owner-admin >>"$PLW/users"
plreq reset owner-admin alerts "$PUB"; : >"$PLLOG"; plhost
[[ $(plres result) == rejected ]] || fail "PL4b: $(cat "$PD/outbox/phone-login.json")"; [[ $(plx) == 0 ]] || fail "PL4b: the container was used: $(cat "$PLLOG")"
# PL5. Bad fields are refused before docker is touched: user, reserved user, topic, key (bad, tiny, not RSA), action.
openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:1024 -out "$PL/small.pem" 2>/dev/null
openssl genpkey -algorithm EC -pkeyopt ec_paramgen_curve:P-256 -out "$PL/ec.pem" 2>/dev/null
for bad in "create Bad_User alerts $PUB" "create ab alerts $PUB" "create admin alerts $PUB" "create bossman-publish alerts $PUB" "create phone-two alerts $PUB" "reset phone-reader alerts $PUB" "create phone-read al/erts $PUB" "create phone-read alerts.x $PUB" \
  "create phone-read alerts bm90LWEta2V5" "create phone-read alerts $(pubb64 "$PL/small.pem")" "create phone-read alerts $(pubb64 "$PL/ec.pem")" "delete phone-read alerts $PUB"; do
  # shellcheck disable=SC2086 # the words are split on purpose
  plreq $bad; : >"$PLLOG"; plhost
  [[ $(plres result) == rejected && $(plres id) == "$PLID" ]] || fail "PL5 ($bad): $(cat "$PD/outbox/phone-login.json")"
  [[ $(plx) == 0 ]] || fail "PL5 ($bad): the container was used: $(cat "$PLLOG")"
done
# A request with an extra field, a symlink or junk is ignored without any answer for it.
printf '{"id":"%s","action":"create","user":"phone-read","topic":"a","pubkey":"%s","extra":"x"}\n' "$(node -e 'console.log(crypto.randomUUID())')" "$PUB" >"$PD/inbox/phone-login.json"; : >"$PLLOG"; plhost
[[ ! -e $PD/inbox/phone-login.json && $(plx) == 0 ]] || fail "PL5: an extra field was accepted"
ln -s /etc/hostname "$PD/inbox/phone-login.json"; plhost; [[ ! -e $PD/inbox/phone-login.json && ! -L $PD/inbox/phone-login.json && $(plx) == 0 ]] || fail "PL5: a symlink was followed"
# PL6. Rate limit: a second request inside 30 s is refused.
plreq reset phone-read alerts "$PUB"; plhost; plreq reset phone-read alerts "$PUB"; date +%s >"$PD/state/last-phone-login"; : >"$PLLOG"; plhost
if [[ $(plres result) == rejected ]] && has "$PD/outbox/phone-login.json" "30 seconds" && [[ $(plx) == 0 ]]; then :; else fail "PL6: $(cat "$PD/outbox/phone-login.json")"; fi
# PL7. No ntfy container, or two: nothing is changed.
plreq create phone-read alerts "$PUB"; : >"$PLLOG"; PL_CIDS="" plhost
[[ $(plres result) == unavailable ]] || fail "PL7a: $(cat "$PD/outbox/phone-login.json")"; hasnt "$PLLOG" "exec -e"
plreq create phone-read alerts "$PUB"; : >"$PLLOG"; PL_CIDS="abc123def456 fed654cba321" plhost
[[ $(plres result) == failed ]] || fail "PL7b: $(cat "$PD/outbox/phone-login.json")"; hasnt "$PLLOG" "exec -e"
# PL8. A failing ntfy command is reported without the password, and a failed create leaves no sealed answer.
: >"$PLW/users"
plreq create phone-read alerts "$PUB"; PL_FAIL=user plhost
[[ $(plres result) == failed && -z $(plres sealed) ]] || fail "PL8a: $(cat "$PD/outbox/phone-login.json")"
plreq create phone-read alerts "$PUB"; PL_FAIL=access plhost
[[ $(plres result) == failed && -z $(plres sealed) ]] || fail "PL8b: $(cat "$PD/outbox/phone-login.json")"
no_plaintext "$(cat "$PLW/pw.phone-read")"
# PL9. The host says whether it can seal; a dry run changes nothing.
has "$PD/outbox/host.json" '"phoneLogin": {"openssl": true}'
plreq reset phone-read alerts "$PUB"; : >"$PLLOG"; BOSSMAN_DEPLOYER="$PD" "$PL/hd.sh" --dry-run >"$T/out" 2>&1 || fail "PL9 dry run"
[[ -e $PD/inbox/phone-login.json && $(plx) == 0 ]] || fail "PL9: a dry run handled the request"
rm -f "$PD/inbox/phone-login.json"
# PS (BOS-1581): action "setup" makes the publish user, write-only access and a token; the token comes back sealed only.
export PL_NOPUB=1; : >"$PLW/users"; : >"$PLLOG"
plreq setup bossman-publish alerts "$PUB"; plhost
[[ $(plres result) == setup && $(plres id) == "$PLID" ]] || fail "PS1: $(cat "$PD/outbox/phone-login.json")"
tok1="$(unseal)"; [[ $tok1 =~ ^tk_[a-z0-9]{29}$ && $tok1 == "$(cat "$PLW/tokens.bossman-publish")" ]] || fail "PS1: the sealed token is not the one ntfy made"
has "$PLLOG" "ntfy user add --role=user bossman-publish"; has "$PLLOG" "ntfy access bossman-publish alerts write-only"; has "$PLLOG" "ntfy token add bossman-publish"
no_plaintext "$tok1"; no_plaintext "$(cat "$PLW/pw.bossman-publish")"
# PS2. Pressing it again finds all three: no user add, no token add, the same token comes back, and the answer says nothing changed.
plreq setup bossman-publish alerts "$PUB"; : >"$PLLOG"; plhost
[[ $(plres result) == setup && $(unseal) == "$tok1" ]] || fail "PS2: $(cat "$PD/outbox/phone-login.json")"
hasnt "$PLLOG" "user add"; hasnt "$PLLOG" "token add"; has "$PD/outbox/phone-login.json" "Nothing was changed"
[[ $(grep -c . "$PLW/users") == 1 ]] || fail "PS2: a second user was made"
# PS3. Only the publish user can be set up, and phone logins cannot be made for it.
for bad in "setup phone-read alerts $PUB" "setup admin alerts $PUB" "create bossman-publish alerts $PUB" "reset bossman-publish alerts $PUB"; do
  # shellcheck disable=SC2086
  plreq ${bad%% "$PUB"} "$PUB"; : >"$PLLOG"; plhost
  [[ $(plres result) == rejected && $(plx) == 0 ]] || fail "PS3 ($bad): $(cat "$PD/outbox/phone-login.json")"
done
# PS4. A failing ntfy step reports failed with no sealed token.
rm -f "$PLW/tokens.bossman-publish"
plreq setup bossman-publish alerts "$PUB"; PL_FAIL=token plhost
[[ $(plres result) == failed && -z $(plres sealed) ]] || fail "PS4: $(cat "$PD/outbox/phone-login.json")"
unset PL_NOPUB
rm -f "$PD/inbox/phone-login.json"

# BOS-1826: the offer is the whole range. It held only the newest 30 commits (git log -n 30), so the card said "30 changes"
# however many were waiting, and the first 300 paths, so host-deployer.sh (listed late, as paths sort) could drop out.
# Its own origin and checkout, so the fixture above is untouched: 150 commits, one of them adding 310 files.
LR="$T/long-range"; mkdir -p "$LR/deployer/inbox" "$LR/deployer/outbox"
git init -q --bare -b main "$LR/origin.git"
git clone -q "$LR/origin.git" "$LR/w"
mkdir -p "$LR/w/apps/server" "$LR/w/scripts"; echo a >"$LR/w/apps/server/a"
git -C "$LR/w" add -A; git -C "$LR/w" commit -qm base; gpush "$LR/w" origin HEAD:main
git clone -q "$LR/origin.git" "$LR/src"
for i in $(seq 1 310); do echo "$i" >"$LR/w/apps/server/f$i"; done
echo x >"$LR/w/scripts/host-deployer.sh"
git -C "$LR/w" add -A; git -C "$LR/w" commit -qm "add 311 files"
for i in $(seq 2 150); do git -C "$LR/w" commit -q --allow-empty -m "commit $i"; done
gpush "$LR/w" origin HEAD:main
printf 'REPO=%s\nAVAILABLE_REFRESH_SECONDS=0\n' "$LR/src" >"$LR/deployer/host.conf"; chmod 600 "$LR/deployer/host.conf"
BOSSMAN_DEPLOYER="$LR/deployer" "$here/host-deployer.sh" >"$T/out" 2>&1 || { cat "$T/out"; fail "host-deployer exited non-zero (long range)"; }
lr="$(node -e 'const o=require(process.argv[1]);process.stdout.write([o.commits.length,o.paths.length,o.infraPaths.join(","),o.commits.at(-1).subject].join(" "))' "$LR/deployer/outbox/available.json")"
[[ $lr == "150 311 scripts/host-deployer.sh add 311 files" ]] || fail "long range: wanted 150 commits, 311 paths and host-deployer.sh, got: $lr"

conf 0; reset_world blue "$cur"; hand_cases # BOS-2885

# With no BOSSMAN_DEPLOYER, the copy uses the folder it sits in.
own="$(mktemp -d)"; mkdir -p "$own/deployer"; cp "$here/host-deployer.sh" "$own/deployer/"
out="$( (unset BOSSMAN_DEPLOYER; bash "$own/deployer/host-deployer.sh" --dry-run 2>&1) || true)"
[[ $out == *"$own/deployer/inbox"* ]] || { echo "FAIL: default deployer folder is not its own folder: $out"; exit 1; }
rm -rf "$own"

echo "host-deployer.test.sh: ok"
