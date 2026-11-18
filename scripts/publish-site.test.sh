#!/usr/bin/env bash
# Checks publish-site.sh: it builds, saves the live sitemap before deploying, deploys, then sends the notice,
# and a failed notice never fails the publish. Uses a fake node and a fake wrangler; nothing is deployed.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
t="$(mktemp -d)"; trap 'rm -rf "$t"' EXIT
fail() { echo "FAIL: $*"; exit 1; }

# A tiny checkout with just what the script calls: a git HEAD and the two site scripts it runs.
repo="$t/repo"; mkdir -p "$repo/scripts" "$repo/apps/site/scripts"
cp "$here/publish-site.sh" "$repo/scripts/"
git init -q "$repo"; git -C "$repo" config user.email t@t; git -C "$repo" config user.name t
touch "$repo/x"; git -C "$repo" add -A; git -C "$repo" commit -qm one
s="$repo/scripts/publish-site.sh"

# Fake node: the build writes a sitemap into SITE_OUT; --fetch-previous writes a previous sitemap; --previous
# fails (INDEXNOW_FAIL) or succeeds. Every call is logged so the order can be checked.
mkdir -p "$t/bin"
cat >"$t/bin/node" <<'FAKE'
#!/usr/bin/env bash
echo "node $*" >>"$FAKE_LOG"
script="${1:-}"; shift || true
case "$script" in
  *build.mjs) mkdir -p "${SITE_OUT:?}"; printf '<urlset><url><loc>%s/a</loc></url></urlset>\n' "${SITE_URL}" >"$SITE_OUT/sitemap.xml" ;;
  *indexnow.mjs)
    case "${1:-}" in
      --fetch-previous) echo '<urlset><url><loc>x/old</loc></url></urlset>' >"$2" ;;
      --previous) [ -z "${INDEXNOW_FAIL:-}" ] || exit 0 ;; # indexnow.mjs always exits 0, even on failure
    esac ;;
esac
FAKE
cat >"$t/bin/wrangler" <<'FAKE'
#!/usr/bin/env bash
echo "wrangler $*" >>"$FAKE_LOG"
[ -z "${DEPLOY_FAIL:-}" ] || { echo "fake wrangler: deploy failed" >&2; exit 1; }
echo "Deployment complete"
FAKE
chmod +x "$t/bin/node" "$t/bin/wrangler"
export PATH="$t/bin:$PATH" FAKE_LOG="$t/calls.log"

run() { : >"$FAKE_LOG"; "$s" >"$t/out" 2>&1 || { cat "$t/out" >&2; return 1; }; }

# 1. The happy path: build, fetch previous, deploy, notice — in that order, with the right values.
CF_PAGES_PROJECT=site INDEXNOW_KEY=k12345678 WRANGLER=wrangler DIST_TMP="$t/run1" SITE_URL="https://example.test/" \
  run || fail "publish should succeed"
order="$(sed -e 's/ .*//' "$FAKE_LOG" | tr '\n' ' ')"
[[ "$order" == "node node wrangler node " ]] || fail "wrong call order: $order"
grep -q "build.mjs" "$FAKE_LOG" || fail "no build step"
grep -q "wrangler pages deploy .* --project-name site --branch main" "$FAKE_LOG" || fail "wrangler args wrong: $(grep wrangler "$FAKE_LOG")"
grep -q -- "--fetch-previous .*previous-sitemap.xml" "$FAKE_LOG" || fail "previous sitemap not saved"
grep -q -- "--previous .*previous-sitemap.xml" "$FAKE_LOG" || fail "notice did not use the previous sitemap"
grep -q "SITE_URL=https://example.test$\|publish-site: building https://example.test " "$t/out" || fail "trailing slash not trimmed"

# 2. A failed notice does not fail the publish: same as case 1, with the notice failing, still exits 0.
INDEXNOW_FAIL=1 CF_PAGES_PROJECT=site INDEXNOW_KEY=k12345678 WRANGLER=wrangler DIST_TMP="$t/run2" SITE_URL="https://example.test" \
  run || fail "a failed notice must not fail the publish"
grep -q "Deployment complete" "$t/out" || fail "deploy output missing on notice failure"

# 3. A failed deploy DOES fail the publish (nothing to notice after).
if DEPLOY_FAIL=1 CF_PAGES_PROJECT=site WRANGLER=wrangler DIST_TMP="$t/run3" SITE_URL="https://example.test" "$s" >"$t/out" 2>&1; then
  fail "a failed deploy must fail the publish"
fi


# 4. No project set: builds only, deploys nothing, still exits 0.
: >"$FAKE_LOG"
CF_PAGES_PROJECT= WRANGLER=wrangler DIST_TMP="$t/run4" SITE_URL="https://example.test" "$s" >"$t/out" 2>&1 || fail "dry run should succeed"
grep -q wrangler "$FAKE_LOG" && fail "must not deploy with no project set"
grep -q "built only" "$t/out" || fail "dry run should say it built only"

# 5. A non-https SITE_URL is refused before anything runs.
: >"$FAKE_LOG"
if CF_PAGES_PROJECT=site SITE_URL="http://example.test" "$s" >"$t/out" 2>&1; then fail "http SITE_URL should be refused"; fi
grep -q "must be an https address" "$t/out" || fail "refusal should name the reason"
[ -s "$FAKE_LOG" ] && fail "nothing should run on a bad SITE_URL"

echo "publish-site.test.sh: all passed"
