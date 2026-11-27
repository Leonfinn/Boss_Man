#!/usr/bin/env bash
# Republishes the website once a release's install test has finished, so the install guide's "Last tested" line
# never goes stale (BOS-2787). Run by the "site" job of .github/workflows/install-test.yml, from the release's own commit.
#
#   scripts/republish-site-after-install.sh
#
# Settings come from the environment, never from this file (any host, any fork):
#   VERSION             the released version, like 0.1.0-beta.3 (no leading v). Required.
#   INSTALL_RESULT_FILE the install-result.json of that release (pass or fail). Required; its version must match VERSION.
#   SITE_URL, CF_PAGES_PROJECT, CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID
#                       what scripts/publish-site.sh needs (docs/18-website.md). When any is empty the site is not
#                       republished and the log says so (a fork that has no website is not an error).
#   GITHUB_REPOSITORY, RUN_URL, GH_TOKEN   used only to mark the release when the publish fails.
#   PUBLISH_SITE, GH    commands to run instead of scripts/publish-site.sh and gh (tests).
# A failed result is published as failed: the build reads the file and never turns a failure into a pass.
# When the publish fails, the release notes get a "Website republish FAILED" line, the job fails (so it is reported like any
# failed workflow) and the old live page stays, because wrangler deploys only after a good build.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

die() { echo "republish-site: $*" >&2; exit 1; }
gh_cmd="${GH:-gh}"
publish="${PUBLISH_SITE:-scripts/publish-site.sh}"

[ -n "${VERSION:-}" ] || die "VERSION is not set"
[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.]+)?$ ]] || die "VERSION '$VERSION' is not like 0.1.0-beta.1"
[ -s "${INSTALL_RESULT_FILE:-}" ] || die "INSTALL_RESULT_FILE is not set or empty"
command -v jq > /dev/null || die "jq is needed to read the install result"
file_version="$(jq -r '.version // empty' "$INSTALL_RESULT_FILE")"
[ "$file_version" = "$VERSION" ] || die "the install result is for '$file_version', not '$VERSION'"
result="$(jq -r '.result // empty' "$INSTALL_RESULT_FILE")"
case "$result" in pass | fail) ;; *) die "the install result '$result' is not pass or fail" ;; esac

missing=""
for name in SITE_URL CF_PAGES_PROJECT CLOUDFLARE_API_TOKEN CLOUDFLARE_ACCOUNT_ID; do
  [ -n "${!name:-}" ] || missing="$missing $name"
done
if [ -n "$missing" ]; then
  echo "::warning::Site not republished after the install test of v$VERSION: not set up here (missing:$missing). Add them as described in docs/18-website.md (Where the publish settings come from)."
  exit 0
fi

export INSTALL_RESULT_FILE
echo "republish-site: republishing the site with the v$VERSION install test result ($result)"
if "$publish"; then
  echo "republish-site: done"
  exit 0
fi

echo "::error::Republishing the site after the install test of v$VERSION failed; the old page is still live."
line="Website republish FAILED after the install test (${RUN_URL:-no run link}). The install guide may still show the previous result."
if [ -n "${GITHUB_REPOSITORY:-}" ]; then
  body="$("$gh_cmd" release view "v$VERSION" --repo "$GITHUB_REPOSITORY" --json body --jq .body 2> /dev/null | grep -v '^Website republish FAILED' || true)"
  "$gh_cmd" release edit "v$VERSION" --repo "$GITHUB_REPOSITORY" --notes "$body"$'\n\n'"$line" || echo "republish-site: could not mark the release"
fi
exit 1
