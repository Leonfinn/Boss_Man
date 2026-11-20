#!/usr/bin/env bash
# Checks smoke-staging.sh against a tiny fake Boss Man (a node HTTP server on a free port) and a fake docker.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
t="$(mktemp -d)"; SRV_PID=""
trap '[[ -z $SRV_PID ]] || kill "$SRV_PID" 2>/dev/null || true; rm -rf "$t"' EXIT
fail() { echo "FAIL: $*"; exit 1; }
command -v node >/dev/null || { echo "smoke-staging.test.sh: node not found"; exit 1; }
sha=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
mkdir -p "$t/stg" "$t/bin"

cat >"$t/server.mjs" <<'JS'
import http from "node:http";
import { writeFileSync } from "node:fs";
const [, , portFile, commit, mode] = process.argv;
const fresh = mode === "fresh"; let owner = null; // fresh: an empty staging with no owner yet (first-run setup open)
const P = "11111111-1111-1111-1111-111111111111", C = "22222222-2222-2222-2222-222222222222", T = "33333333-3333-3333-3333-333333333333";
const s = http.createServer((req, res) => {
  const send = (code, body, type = "application/json") => { res.writeHead(code, { "content-type": type }); res.end(typeof body === "string" ? body : JSON.stringify(body)); };
  let data = ""; req.on("data", (d) => (data += d)); req.on("end", () => {
    if (req.url === "/api/health") return send(200, { ok: true, commit });
    if (req.url === "/") return send(200, "<html><body>board</body></html>", "text/html");
    if (req.url === "/api/setup" && req.method === "GET") return send(200, { needsSetup: fresh && !owner });
    if (req.url === "/api/setup") { if (!fresh || owner) return send(409, { error: "already_set_up" }); if (JSON.parse(data).password.length < 12) return send(400, { error: "invalid" }); owner = JSON.parse(data).password; return send(201, { username: "smoke" }); }
    if (req.url === "/api/login" && fresh) return JSON.parse(data).password === owner ? send(200, { username: "smoke" }) : send(401, { error: "wrong" });
    if (req.url === "/api/login") return ["right", "pa\\ss\"w"].includes(JSON.parse(data).password) ? send(200, { username: "smoke" }) : send(401, { error: "wrong" });
    if (req.url === "/api/companies") return send(200, [{ id: C, projects: [{ id: P, companyId: C, name: "p" }] }]);
    if (req.url === `/api/projects/${P}/tickets`) return send(201, { id: T });
    if (req.url === `/api/tickets/${T}/state`) return send(200, { ok: true });
    if (req.url === `/api/companies/${C}/runner`) return send(200, { registered: true, connected: true, imageVersion: "abc123" });
    send(404, {});
  });
});
s.listen(0, "127.0.0.1", () => writeFileSync(portFile, String(s.address().port)));
JS
start_server() { # commit the server reports, then optionally "fresh" (no owner yet)
  rm -f "$t/port"; node "$t/server.mjs" "$t/port" "$1" "${2:-}" & SRV_PID=$!
  local end=$((SECONDS + 20))
  until [[ -s $t/port ]]; do ((SECONDS < end)) || fail "fake server did not start"; sleep 0.2; done
  printf 'BOSSMAN_BIND=127.0.0.1\nBOSSMAN_HOST_PORT=%s\n' "$(cat "$t/port")" >"$t/stg/.env"
}
stop_server() { kill "$SRV_PID" 2>/dev/null || true; wait "$SRV_PID" 2>/dev/null || true; SRV_PID=""; }
cat >"$t/bin/docker" <<'FAKE'
#!/usr/bin/env bash
cat "$FAKE_PS"
FAKE
chmod +x "$t/bin/docker"
export PATH="$t/bin:$PATH" FAKE_PS="$t/ps" SMOKE_WAIT=3 SMOKE_TIMEOUT=5
printf 'c1\nc2\n' >"$t/ps"
res() { awk -F'\t' -v n="$1" '$1 == n { print $2 }' <<<"$out"; }

# All good, with a smoke account.
printf 'smoke_username=smoke\nsmoke_password=right\n' >"$t/creds"; chmod 600 "$t/creds"
start_server "$sha"
out="$(SMOKE_CREDENTIALS="$t/creds" "$here/smoke-staging.sh" "$t/stg" "$sha")" || fail "good run failed: $out"
for c in address version board signin ticket runner production; do [[ $(res $c) == pass ]] || fail "$c should pass: $out"; done
[[ $(res agent_run) == skipped ]] || fail "agent_run should be skipped: $out"
[[ $out != *right* ]] || fail "the password was printed"

# A password with a backslash and a quote reaches the server intact, and a CRLF credentials file does not add a CR (BOS-1796).
printf 'smoke_username=smoke\r\nsmoke_password=pa\\ss"w\r\n' >"$t/creds-odd"
out="$(SMOKE_CREDENTIALS="$t/creds-odd" "$here/smoke-staging.sh" "$t/stg" "$sha")" || fail "odd password run failed: $out"
[[ $(res signin) == pass ]] || fail "backslash/quote/CR password should sign in: $out"

# No smoke account: sign-in checks are skipped, never failed.
out="$("$here/smoke-staging.sh" "$t/stg" "$sha")" || fail "no-credentials run failed: $out"
[[ $(res signin) == skipped && $(res ticket) == skipped && $(res runner) == skipped ]] || fail "no creds should skip: $out"
[[ $(res address) == pass && $(res board) == pass ]] || fail "no-creds checks: $out"

# Wrong password: sign-in fails, exit 1.
printf 'smoke_username=smoke\nsmoke_password=wrong\n' >"$t/creds-bad"
if out="$(SMOKE_CREDENTIALS="$t/creds-bad" "$here/smoke-staging.sh" "$t/stg" "$sha")"; then fail "bad password should exit 1"; fi
[[ $(res signin) == fail ]] || fail "bad password: $out"

# Production containers changed during the deploy: caught through the list the deployer took first.
if out="$(SMOKE_PRODUCTION_BEFORE="c1,c9" "$here/smoke-staging.sh" "$t/stg" "$sha")"; then fail "changed production should exit 1"; fi
[[ $(res production) == fail ]] || fail "production change: $out"
stop_server

# An empty staging (no owner yet): the smoke account is created from the file, then signs in; a second run still signs in,
# and a file with a different password then fails with the "already has an owner" hint (BOS-2072).
start_server "$sha" fresh
printf 'smoke_username=smoke\nsmoke_password=newpass-long-enough\n' >"$t/creds-new"
out="$(SMOKE_CREDENTIALS="$t/creds-new" "$here/smoke-staging.sh" "$t/stg" "$sha")" || fail "fresh staging run failed: $out"
[[ $(res signin) == pass && $(res ticket) == pass ]] || fail "fresh staging should create the smoke account: $out"
[[ $out == *"first owner"* ]] || fail "fresh run should say it created the account: $out"
out="$(SMOKE_CREDENTIALS="$t/creds-new" "$here/smoke-staging.sh" "$t/stg" "$sha")" || fail "second run failed: $out"
[[ $(res signin) == pass && $out != *"first owner"* ]] || fail "second run should just sign in: $out"
if out="$(SMOKE_CREDENTIALS="$t/creds-bad" "$here/smoke-staging.sh" "$t/stg" "$sha")"; then fail "other password should fail"; fi
[[ $out == *"already has an owner"* ]] || fail "401 on an existing owner should explain itself: $out"
[[ $out != *newpass* ]] || fail "the password was printed"
stop_server

# An empty staging and a password under 12 characters: setup is refused, and the message says so (not "already has an owner").
start_server "$sha" fresh
printf 'smoke_username=smoke\nsmoke_password=short\n' >"$t/creds-short"
if out="$(SMOKE_CREDENTIALS="$t/creds-short" "$here/smoke-staging.sh" "$t/stg" "$sha")"; then fail "short password should fail"; fi
[[ $out == *"at least 12 characters"* && $out != *"already has an owner"* ]] || fail "short password should be named: $out"
[[ $out != *short\;* && $out != *"=short"* ]] || fail "the password was printed"
stop_server

# Wrong commit on staging: version fails.
start_server bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
if out="$("$here/smoke-staging.sh" "$t/stg" "$sha")"; then fail "wrong commit should exit 1"; fi
[[ $(res version) == fail ]] || fail "wrong commit: $out"
stop_server

# Nothing answering: the address check fails and the rest are skipped.
if out="$("$here/smoke-staging.sh" "$t/stg" "$sha")"; then fail "no answer should exit 1"; fi
[[ $(res address) == fail && $(res board) == skipped && $(res runner) == skipped ]] || fail "no answer: $out"

# Bad usage.
if "$here/smoke-staging.sh" "$t/stg" notasha >/dev/null 2>&1; then fail "bad commit accepted"; fi
echo "smoke-staging.test.sh: ok"
