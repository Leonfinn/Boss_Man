#!/usr/bin/env bash
# Publishes the website (apps/site) to Cloudflare Pages, and tells IndexNow which pages changed (BOS-1737).
# The one publish procedure: every release ends with it (docs/18-website.md), so the "What's new" page
# reaches the live site and the search engines hear about the changed pages.
#
#   scripts/publish-site.sh
#
# It builds the site from the commit checked out here, saves the live sitemap, deploys, then runs the
# IndexNow notice against the previous sitemap. The notice is best-effort: a failed one never fails a
# publish (it retries once, then runs INDEXNOW_ON_FAILURE so a CEO ticket is raised).
#
# Settings come from the environment, never from this file (it works on any host, with any Cloudflare account).
# Store them once in Boss Man's Settings → Secrets (every run gets them); a value set in the command overrides it:
#   SITE_URL            the site's https origin, e.g. https://example.com (the build refuses anything else).
#   UMAMI_SCRIPT_URL    the https address of the Umami script, and UMAMI_WEBSITE_ID the site's ID (both public; set both or
#   UMAMI_WEBSITE_ID    neither). The build then adds the script to every page and its pre-publish check fails the
#                       publish if a page lacks it. Empty: no statistics and a warning.
#   CF_PAGES_PROJECT    the Cloudflare Pages project name. When it is empty, only the build runs and nothing is deployed.
#   INDEXNOW_KEY        the key from Boss Man's Secrets screen. Empty: no key file is served and no notice is sent.
#   INDEXNOW_ON_FAILURE a shell command to run after the notice fails twice (the publish step supplies it to raise a
#                       CEO ticket; it gets a plain summary in INDEXNOW_FAILURE). Empty: the failure is only printed.
#   DIST_TMP            where the build, the previous sitemap and the deploy log are kept; a fresh temp dir by default.
#                       Must be writable and persist until the script ends (not a fixed /tmp path; mktemp is used).
#   WRANGLER            the wrangler command, default "npx --yes wrangler@4".
#   CF_PAGES_BRANCH     the production branch, default main.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

die() { echo "publish-site: $*" >&2; exit 1; }

[ -n "${SITE_URL:-}" ] || die "SITE_URL is not set. Add it in Settings → Secrets (the stored value every run gets), e.g. https://example.com; or set it in the command to override for one publish"
site_url="${SITE_URL%/}"
case "$site_url" in
  https://*) ;;
  *) die "SITE_URL must be an https address, got '$SITE_URL'" ;;
esac

run_dir="${DIST_TMP:-$(mktemp -d)}"
mkdir -p "$run_dir"
dist="$run_dir/dist"
previous="$run_dir/previous-sitemap.xml"
install -d "$dist"

# 1. Build from this checkout. SITE_OUT keeps the build out of the repo, so a publish never leaves dist/ behind.
commit="$(git rev-parse --short HEAD 2>/dev/null || echo unknown)"
echo "publish-site: building $site_url from $commit"
SITE_URL="$site_url" SITE_OUT="$dist" node apps/site/scripts/build.mjs
[ -f "$dist/sitemap.xml" ] || die "the build wrote no sitemap.xml"

# 2. Save the live sitemap first, so the notice can tell which pages changed (not sent if nothing is live yet).
node apps/site/scripts/indexnow.mjs --fetch-previous "$previous" || true

# 3. Deploy. With no project set this is a dry run: the build and the checks above still happen.
if [ -z "${CF_PAGES_PROJECT:-}" ]; then
  echo "publish-site: CF_PAGES_PROJECT is empty (add it in Settings → Secrets to deploy); built only, nothing deployed"
  exit 0
fi
# Cloudflare Pages project names are lowercase letters, digits and dashes: refuse a typo before any deploy.
case "$CF_PAGES_PROJECT" in
  *[!a-z0-9-]*|-*|*-) die "CF_PAGES_PROJECT '$CF_PAGES_PROJECT' is not a valid Cloudflare Pages project name (lowercase letters, digits and dashes)" ;;
esac
branch="${CF_PAGES_BRANCH:-main}"
wrangler="${WRANGLER:-npx --yes wrangler@4}"
echo "publish-site: deploying $dist to Cloudflare Pages project $CF_PAGES_PROJECT (branch $branch)"
# shellcheck disable=SC2086
$wrangler pages deploy "$dist" --project-name "$CF_PAGES_PROJECT" --branch "$branch" --commit-dirty=true \
  | tee "$run_dir/deploy.log"

# 4. Tell IndexNow about the changed pages. Never fails the publish: indexnow.mjs always exits 0, and the
#    "|| true" is a second guard in case node itself cannot start.
echo "publish-site: sending the IndexNow notice"
SITE_URL="$site_url" DIST="$dist" node apps/site/scripts/indexnow.mjs --previous "$previous" || true
echo "publish-site: done"
