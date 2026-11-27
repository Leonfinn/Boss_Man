#!/usr/bin/env bash
# Checks republish-site-after-install.sh (BOS-2787) with a fake publish and a fake gh; nothing is deployed or edited.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
t="$(mktemp -d)"; trap 'rm -rf "$t"' EXIT
fail() { echo "FAIL: $*"; exit 1; }
s="$here/republish-site-after-install.sh"

# shellcheck disable=SC2016 # the fakes must keep their $ for when they run
printf '#!/usr/bin/env bash\necho "publish result=$(jq -r .result "$INSTALL_RESULT_FILE")" >>"$FAKE_LOG"\n[ -z "${PUBLISH_FAIL:-}" ]\n' >"$t/publish"
# shellcheck disable=SC2016
printf '#!/usr/bin/env bash\necho "gh $*" >>"$FAKE_LOG"\n' >"$t/gh"
chmod +x "$t/publish" "$t/gh"
echo '{"version":"0.1.0-beta.3","result":"pass","minutes":4.2}' >"$t/pass.json"
echo '{"version":"0.1.0-beta.3","result":"fail","minutes":null}' >"$t/fail.json"

run() { : >"$t/log"; env -i PATH="$PATH" FAKE_LOG="$t/log" PUBLISH_SITE="$t/publish" GH="$t/gh" VERSION=0.1.0-beta.3 \
  SITE_URL=https://example.com CF_PAGES_PROJECT=demo CLOUDFLARE_API_TOKEN=x CLOUDFLARE_ACCOUNT_ID=y "$@" bash "$s" >"$t/out" 2>&1; }

run INSTALL_RESULT_FILE="$t/pass.json" || fail "pass: should succeed"
grep -q "publish result=pass" "$t/log" || fail "pass: publish should get the pass result"

run INSTALL_RESULT_FILE="$t/fail.json" || fail "fail result: the republish itself should succeed"
grep -q "publish result=fail" "$t/log" || fail "a failed result must be published as failed"

run INSTALL_RESULT_FILE="$t/pass.json" VERSION=0.1.0-beta.4 && fail "a result for another version must be refused"
[ ! -s "$t/log" ] || fail "nothing may be published for the wrong version"

run INSTALL_RESULT_FILE="$t/pass.json" CF_PAGES_PROJECT= || fail "not configured: should exit 0"
[ ! -s "$t/log" ] || fail "not configured: nothing may be published"
grep -q "not set up here" "$t/out" || fail "not configured: should say why"

run INSTALL_RESULT_FILE="$t/pass.json" PUBLISH_FAIL=1 GITHUB_REPOSITORY=o/r RUN_URL=https://example.com/run/1 && fail "a failed publish must fail the job"
grep -q "gh release edit v0.1.0-beta.3" "$t/log" || fail "a failed publish must mark the release"
echo "PASS: republish-site-after-install"
