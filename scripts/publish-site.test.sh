#!/usr/bin/env bash
# Checks publish-site.sh: it builds, saves the live sitemap before deploying, deploys, then sends the notice,
# and a failed notice never fails the publish. Uses a fake node and a fake wrangler; nothing is deployed.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
t="$(mktemp -d)"; trap 'rm -rf "$t"' EXIT
fail() { echo "FAIL: $*"; exit 1; }

# A tiny checkout with just what the script calls: a git HEAD and a script beside it to stand in for the notice's hook.
# The copies are written out with printf, not "cp": a checkout whose scripts are hard links would make "cp" the
# ticket's own script, and then the hook below would reach Boss Man for real (BOS-2070).
repo="$t/repo"; mkdir -p "$repo/scripts" "$repo/apps/site/scripts"
printf '%s\n' "$(cat "$here/publish-site.sh")" >"$repo/scripts/publish-site.sh"
printf '#!/bin/sh\necho hook-ran\n' >"$repo/scripts/request-ceo-ticket.sh"
# Check it really is the stub before the test is allowed to use it (see the note above).
[ "$(tail -n 1 "$repo/scripts/request-ceo-ticket.sh")" = "echo hook-ran" ] || fail "could not write the stub hook into the temp checkout"

chmod +x "$repo/scripts/publish-site.sh" "$repo/scripts/request-ceo-ticket.sh"
git init -q "$repo"; git -C "$repo" config user.email t@t; git -C "$repo" config user.name t
touch "$repo/x"; git -C "$repo" add -A; git -C "$repo" commit -qm one
s="$repo/scripts/publish-site.sh"

# Some sandboxes (this runner's did, BOS-2070) can't run a new file by its own path from inside a script started by
# another script: "sh: ...: No such file or directory" even though the file is there and runs from a plain shell.
# The stub hook is run by path because that is what the publish step supplies, so where that can't work the stub's
# text is read out and run instead. Either way only the stub's text runs, never the real request-ceo-ticket.sh.
stub="$repo/scripts/request-ceo-ticket.sh"
hook_stub=0
# The probe nests the way the fake `node` runs the hook (script -> `sh -c` -> stub), or it proves nothing.
if [ "$(bash -c 'sh -c "$1"' probe "sh $stub" 2>/dev/null)" != hook-ran ]; then hook_stub=1; fi

# Fake node: the build writes a sitemap into SITE_OUT; --fetch-previous writes a previous sitemap; --previous
# fails (INDEXNOW_FAIL) or succeeds. Every call is logged so the order can be checked.
mkdir -p "$t/bin"
cat >"$t/bin/node" <<'FAKE'
#!/usr/bin/env bash
echo "node $*" >>"$FAKE_LOG"
script="${1:-}"; shift || true
case "$script" in
  *build.mjs) echo "install_result=${INSTALL_RESULT_FILE:-}" >>"$FAKE_LOG"; mkdir -p "${SITE_OUT:?}"; printf '<urlset><url><loc>%s/a</loc></url></urlset>\n' "${SITE_URL}" >"$SITE_OUT/sitemap.xml" ;;
  *indexnow.mjs)
    case "${1:-}" in
      --fetch-previous) echo '<urlset><url><loc>x/old</loc></url></urlset>' >"$2" ;;
      --previous)
        # The publish step's INDEXNOW_ON_FAILURE must be set to the CEO-ticket hook (BOS-2070). Record it, then
        # run it like indexnow.mjs does after a second failure when INDEXNOW_FAIL asks for one. The stub hook only
        # prints. Where the sandbox can't run a new file by path it is the stub's text that runs instead.
        echo "on_failure=${INDEXNOW_ON_FAILURE:-}" >>"$FAKE_LOG"
        if [ -n "${INDEXNOW_FAIL:-}" ]; then
          INDEXNOW_FAILURE="IndexNow answered HTTP 403"
          export INDEXNOW_FAILURE
          if [ -n "${HOOK_STUB:-}" ]; then
            sh -c '. "$1"' sh "${INDEXNOW_ON_FAILURE#sh }"
          else
            sh -c "$INDEXNOW_ON_FAILURE"
          fi
          echo "hook-status=$?" >>"$FAKE_LOG"
        fi
        exit 0 ;;
    esac ;;
esac
FAKE
cat >"$t/bin/wrangler" <<'FAKE'
#!/usr/bin/env bash
echo "wrangler $*" >>"$FAKE_LOG"
[ -z "${DEPLOY_FAIL:-}" ] || { echo "fake wrangler: deploy failed" >&2; exit 1; }
echo "Deployment complete"
FAKE
# Fake curl for the install test result (BOS-1488): the release listing, then the file. CURL_FAIL makes it fail. It never
# touches the network, so the test is the same on every machine.
cat >"$t/bin/curl" <<'FAKE'
#!/usr/bin/env bash
[ -z "${CURL_FAIL:-}" ] || exit 22
out=""; url=""
while [ $# -gt 0 ]; do case "$1" in -o) out="$2"; shift 2 ;; http*) url="$1"; shift ;; *) shift ;; esac; done
case "$url" in
  */releases\?*) echo '[{"draft":false,"assets":[{"name":"images.env","browser_download_url":"https://example.test/images.env"},{"name":"install-result.json","browser_download_url":"https://example.test/install-result.json"}]}]' ;;
  */install-result.json) echo '{"version":"0.1.0","date":"2026-11-23","result":"pass","minutes":6}' >"$out" ;;
  *) exit 22 ;;
esac
FAKE
chmod +x "$t/bin/node" "$t/bin/wrangler" "$t/bin/curl"
unset GITHUB_REPOSITORY INSTALL_RESULT_FILE
export PATH="$t/bin:$PATH" FAKE_LOG="$t/calls.log"

# Run the publish script. Where the sandbox can't run a new file by path, the fake `node` reads the stub hook's text
# instead of running the path (HOOK_STUB); the publish script itself always runs by its own path.
[ "$hook_stub" = 0 ] && run() { : >"$FAKE_LOG"; "$s" >"$t/out" 2>&1 || { cat "$t/out" >&2; return 1; }; }
[ "$hook_stub" = 1 ] && run() { : >"$FAKE_LOG"; HOOK_STUB=1 "$s" >"$t/out" 2>&1 || { cat "$t/out" >&2; return 1; }; }

# The notice's hook by default: the stub checkout's own request-ceo-ticket.sh, run with `sh` (the publish step's
# word for it). Where the sandbox can't run a new file by path, the fake `node` runs the stub's text read from disk
# instead, but the default the publish step supplies is the same two words.
default_hook="sh $repo/scripts/request-ceo-ticket.sh"

# 1. The happy path: build, fetch previous, deploy, notice — in that order, with the right values.
CF_PAGES_PROJECT=site INDEXNOW_KEY=k12345678 WRANGLER=wrangler DIST_TMP="$t/run1" SITE_URL="https://example.test/" \
  run || fail "publish should succeed"
order="$(sed -e 's/ .*//' "$FAKE_LOG" | grep -v '^on_failure=\|^install_result=' | tr '\n' ' ')"
[[ "$order" == "node node wrangler node " ]] || fail "wrong call order: $order"
grep -qxF "on_failure=$default_hook" "$FAKE_LOG" || fail "the notice should run the CEO-ticket hook by default: $(grep on_failure "$FAKE_LOG")"
grep -q "build.mjs" "$FAKE_LOG" || fail "no build step"
grep -q "wrangler pages deploy .* --project-name site --branch main" "$FAKE_LOG" || fail "wrangler args wrong: $(grep wrangler "$FAKE_LOG")"
grep -q -- "--fetch-previous .*previous-sitemap.xml" "$FAKE_LOG" || fail "previous sitemap not saved"
grep -q -- "--previous .*previous-sitemap.xml" "$FAKE_LOG" || fail "notice did not use the previous sitemap"
grep -q "SITE_URL=https://example.test$\|publish-site: building https://example.test " "$t/out" || fail "trailing slash not trimmed"

# 2. A failed notice does not fail the publish: same as case 1, with the notice failing, still exits 0. The token and
# address are blanked so the hook only proves it ran: with a real run token it would open a ticket on the live server.
INDEXNOW_FAIL=1 CF_PAGES_PROJECT=site INDEXNOW_KEY=k12345678 WRANGLER=wrangler DIST_TMP="$t/run2" SITE_URL="https://example.test" \
  BOSSMAN_TOKEN='' BOSSMAN_API_URL='' \
  run || fail "a failed notice must not fail the publish"
grep -q "Deployment complete" "$t/out" || fail "deploy output missing on notice failure"
# ..., and when it really fails twice it runs the hook, which gets the reason and exits cleanly.
grep -q "hook-ran" "$t/out" || fail "the CEO-ticket hook did not run after a failed notice: $(cat "$t/out")"
hook_status="$(sed -n 's/^hook-status=//p' "$FAKE_LOG")"
[[ "$hook_status" == "0" ]] || fail "the default hook should not fail: status '$hook_status'"
# The real hook is written for `sh` (no bash-only syntax), so the shell the publish step supplies must run it cleanly.
sh -n "$here/request-ceo-ticket.sh" || fail "request-ceo-ticket.sh is not a clean POSIX sh script"

# 3. A failed deploy DOES fail the publish (nothing to notice after).
if DEPLOY_FAIL=1 CF_PAGES_PROJECT=site WRANGLER=wrangler DIST_TMP="$t/run3" SITE_URL="https://example.test" "$s" >"$t/out" 2>&1; then
  fail "a failed deploy must fail the publish"
fi


# 4. No project set: builds only, deploys nothing, still exits 0.
: >"$FAKE_LOG"
CF_PAGES_PROJECT='' WRANGLER=wrangler DIST_TMP="$t/run4" SITE_URL="https://example.test" "$s" >"$t/out" 2>&1 || fail "dry run should succeed"
grep -q wrangler "$FAKE_LOG" && fail "must not deploy with no project set"
grep -q "built only" "$t/out" || fail "dry run should say it built only"

# 5. A non-https SITE_URL is refused before anything runs.
: >"$FAKE_LOG"
if CF_PAGES_PROJECT=site SITE_URL="http://example.test" "$s" >"$t/out" 2>&1; then fail "http SITE_URL should be refused"; fi
grep -q "must be an https address" "$t/out" || fail "refusal should name the reason"
[ -s "$FAKE_LOG" ] && fail "nothing should run on a bad SITE_URL"

# 6. A mistyped project name is refused before any deploy.
: >"$FAKE_LOG"
if CF_PAGES_PROJECT="My_Site " SITE_URL="https://example.test" DIST_TMP="$t/run6" "$s" >"$t/out" 2>&1; then fail "bad project name should be refused"; fi
grep -q "not a valid Cloudflare Pages project name" "$t/out" || fail "refusal should name the project"
grep -q wrangler "$FAKE_LOG" && fail "must not deploy a bad project name"

# 7. No SITE_URL: the error points at Settings → Secrets.
: >"$FAKE_LOG"
if env -u SITE_URL CF_PAGES_PROJECT=site "$s" >"$t/out" 2>&1; then fail "missing SITE_URL should be refused"; fi
grep -q "Settings → Secrets" "$t/out" || fail "missing SITE_URL error should say where to set it"
[ -s "$FAKE_LOG" ] && fail "nothing should run with no SITE_URL"

# 8. The newest release's install test result is saved and handed to the build (BOS-1488).
: >"$FAKE_LOG"
GITHUB_REPOSITORY=owner/repo CF_PAGES_PROJECT='' DIST_TMP="$t/run8" SITE_URL="https://example.test" "$s" >"$t/out" 2>&1 || fail "publish with a result should succeed: $(cat "$t/out")"
grep -qx "install_result=$t/run8/install-result.json" "$FAKE_LOG" || fail "the build did not get the saved result: $(grep install_result "$FAKE_LOG")"
grep -q '"result":"pass"' "$t/run8/install-result.json" || fail "the saved result is not the release's file"

# 9. No result to fetch (GitHub unreachable): the publish still builds, with no file, and says so.
: >"$FAKE_LOG"
CURL_FAIL=1 GITHUB_REPOSITORY=owner/repo CF_PAGES_PROJECT='' DIST_TMP="$t/run9" SITE_URL="https://example.test" "$s" >"$t/out" 2>&1 || fail "a failed fetch must not fail the publish"
grep -qx "install_result=" "$FAKE_LOG" || fail "the build should get no result file: $(grep install_result "$FAKE_LOG")"
grep -q "no install test result found" "$t/out" || fail "the missing result should be said"

echo "publish-site.test.sh: all passed"
