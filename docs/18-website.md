# The website (apps/site)

The public site is plain HTML, one CSS file and a small build script in `apps/site`. It has no framework and one small script (`menu.js`: the phone menu, the Copy buttons on code blocks and the "On this page" marker). Without it every page still works: the nav is a plain list of links and the guide list is open.

## Build and check

```
pnpm build:site                         # same as: pnpm --filter @boss-man/site build -> apps/site/dist
pnpm --filter @boss-man/site check      # links, images, titles, descriptions, one h1, heading order, lang, alt text, no inline styles or scripts
pnpm --filter @boss-man/site test
```

`SITE_URL` (an https address such as `https://example.com`, no path; the build stops on anything else) turns on canonical links, absolute `og:` image URLs and `sitemap.xml`. Without it those are left out. For a publish it comes from Settings → Secrets (see "Publishing").

`PORTAL_URL` (or `portalUrl` in `src/site.json`) is the public https address of Boss Man's own feedback portal. While it is empty, every roadmap link (menu, footer, home page box) is left out, so the site never carries a home-network address. The build refuses anything that is not a public https address with a domain name (no IP address, `.local`, `.lan`, `.ts.net`, `localhost` or login in the address). The links open the portal in the same tab. Never put the portal's secret link in the repo.

`SITE_OUT` builds somewhere other than `apps/site/dist`.

`INDEXNOW_KEY` (8 to 128 letters, digits or dashes; kept in Boss Man's Secrets, never in the repo) makes the build write `/<key>.txt` holding just the key, as IndexNow requires. Sitemap dates (`<lastmod>`) come from each source file's git history; with no history (a shallow clone) the date is left out rather than guessed.

After a successful deploy, the publish step runs `node apps/site/scripts/indexnow.mjs --previous <old sitemap>` (before the deploy, `--fetch-previous <file>` saves the live sitemap). It sends only changed pages to IndexNow, retries once, runs the shell command in `INDEXNOW_ON_FAILURE` after a second failure, and always exits 0 so a publish never fails because of it. That command (the publish step supplies it) prints one `RAISE-CEO-TICKET:` line; the publishing agent, whose run the publish happens in, reads it and reports the failure with `create_ticket`. Google reads changes from the sitemap.

## Publishing

`scripts/publish-site.sh` is the one publish step (every release ends with it, see the comment at the top of `CHANGELOG.md`). It builds the site from the commit checked out, saves the live sitemap, deploys to Cloudflare Pages, then sends the IndexNow notice — in that order. The notice is best-effort: it never fails the publish. Settings come from the environment, so it works on any host and any Cloudflare account:

- `SITE_URL` (required): the site's https origin. Stored in Settings → Secrets; set it in the command only to override.
- `CF_PAGES_PROJECT`: the Cloudflare Pages project (stored in Settings → Secrets the same way). Empty: the script builds and checks only, and deploys nothing (a safe dry run).
- `INDEXNOW_KEY`: the key from Boss Man's Secrets. Empty: no key file is served and no notice is sent.
- `UMAMI_SCRIPT_URL` and `UMAMI_WEBSITE_ID` (set both or neither): the https address of the Umami script (for example `https://stats.example.com/script.js`) and the site ID Umami shows for bossman.website. Both are public (they sit in every page), so they are settings, not secrets; an Umami login or API key never goes in the site. With them set, the build adds the script to every page, adds a `data-umami-event` to the Install (`install-click`), GitHub (`github-click`) and Roadmap (`roadmap-click`) links, and lets that one address into the Content-Security-Policy (`script-src` and `connect-src`). Umami sets no cookies, so there is no banner; the script is told to honour Do Not Track and to leave the query string out of recorded addresses. Without them the build prints a warning and the site has no statistics.
- `INDEXNOW_ON_FAILURE`: a shell command to run after the notice fails twice (gets a summary in `INDEXNOW_FAILURE`). The publish step sets it to `scripts/request-ceo-ticket.sh` by default (BOS-2070); set it in the command to replace that, or to empty to only print the failure. The hook prints a single `RAISE-CEO-TICKET:` line naming the failure and exits non-zero; because a publish runs in an agent's run, the publishing agent reads that line and reports it with `create_ticket` in its next steps. It never calls Boss Man's `/mcp` endpoint by hand, so it needs no token and no address.
- `WRANGLER` (default `npx --yes wrangler@4`), `CF_PAGES_BRANCH` (default `main`), `DIST_TMP` (a fresh temp dir by default).

Publish from a full clone, not a shallow one: with no git history the sitemap has no dates, every page counts as changed, and all of them are sent each time (IndexNow tolerates it, but it isn't "only changed pages"). Rollback: re-run the script from the older commit.

The build ends with the pre-publish check (`scripts/check.mjs`): a page without its head tags, or without the Umami script when it is configured, exits 1 and `publish-site.sh` stops before deploying.

### Where the publish settings come from

This is for anyone who has to change a setting the website build or publish reads.

Every release ends with a site publish: the Release Manager runs `scripts/publish-site.sh` from the released commit, on the "Release log: record" wake (see the comment at the top of `CHANGELOG.md`). If its output has a line starting `RAISE-CEO-TICKET:`, the IndexNow notice failed twice: raise a ticket for the CEO with `create_ticket` (project Development, risk low, size 1, `noCode` true), quoting that line. The script builds on the runner and uploads with wrangler, so the Cloudflare Pages build settings below are not used by it. It and the build read plain environment variables. A run gets most of them from Boss Man's Secrets (one entry per name, no value in the repo); the rest are typed in for each publish or come from a file in the repo. On a new install the owner adds `SITE_URL`, `CF_PAGES_PROJECT` and `INDEXNOW_KEY` there once, next to the Umami and Cloudflare entries.

| Setting | Read by | Where it is set | Who can change it | Republish after a change? |
|---|---|---|---|---|
| `UMAMI_SCRIPT_URL`, `UMAMI_WEBSITE_ID` | `build.mjs` (script tag, click markers, CSP), `check.mjs` | Settings → Secrets, one entry each. Every Boss Man run gets them. | The owner | Yes: pages keep the old values until the next publish. |
| `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID` | wrangler (the deploy step) | Settings → Secrets | The owner | No: the next publish uses the new values. |
| `INSTALL_RESULT_FILE` | `build.mjs` (the install guide's "Last tested on (date) with (version), took (n) minutes" and its time line, BOS-1488) | `publish-site.sh` saves the newest release's `install-result.json` (attached by the Install test workflow) from the public GitHub API and sets this itself; set it first to use your own file. No file, an unreadable one or a failed test: the guide says "Not yet tested" or that the test failed, never a pass. | Nobody | Yes: the guide shows the result as of the last publish, so publish again after a release's install test finishes. The Release Manager does this on the "Release log: record" wake (step 6 in the `CHANGELOG.md` comment: wait for the release's `install-result.json`, republish, and raise a CEO ticket if the release title ends "(install test FAILED)"). |
| `SITE_URL` | `publish-site.sh` (required), `build.mjs` (canonical links, sitemap, `og:` URLs), `check.mjs`, `indexnow.mjs` | Settings → Secrets (not a secret, but stored there so every run gets it and anyone can look it up). A value set in the publish command overrides it for that publish only. Not set anywhere: the script stops and says where to add it. | The owner | Yes |
| `CF_PAGES_PROJECT` | `publish-site.sh` | Settings → Secrets, same as `SITE_URL`; a value set in the command overrides it. A name that is not lowercase letters, digits and dashes is refused before the deploy. Empty: build and check only, nothing is deployed. | The owner | Yes: the next publish goes to the new project. |
| `CF_PAGES_BRANCH` | `publish-site.sh` | Typed in for each publish. Default `main`. | Release Manager | Yes |
| `INDEXNOW_KEY` | `build.mjs` (key file), `indexnow.mjs` | Settings → Secrets. Not there: no key file and no IndexNow notice. | The owner | Yes: the key file has to be on the live site. |
| `INDEXNOW_ON_FAILURE` | `indexnow.mjs` | Supplied by the publish step: `scripts/request-ceo-ticket.sh`, which prints a `RAISE-CEO-TICKET:` line the publishing agent reports with `create_ticket`. Set to empty to only print a failure. | Release Manager | No |
| `portalUrl` (portal address) | `build.mjs` (Roadmap links) | `apps/site/src/site.json` in the repo. A `PORTAL_URL` environment variable overrides it. | Anyone, through a reviewed and merged change | Yes |
| `WRANGLER`, `DIST_TMP`, `SITE_OUT`, `INDEXNOW_ENDPOINT`, `INDEXNOW_RETRY_DELAY_MS` | `publish-site.sh`, `build.mjs`, `indexnow.mjs` | Not normally set: the defaults apply. | Release Manager | No |

To change a Secrets value, the owner edits the entry in Settings → Secrets. The Release Manager then republishes from the live commit and checks the live page source for the change.

Most common failure: the build stops with "UMAMI_SCRIPT_URL and UMAMI_WEBSITE_ID must be set together (or both left empty)". One of the pair is missing from Secrets: set both, or clear both.

## Search engines and statistics: one-time setup

This is for the owner of a new Boss Man website who wants Google and Bing to find it and wants visit figures. You do this once, top to bottom, in about 45 minutes. After that, every publish, notice and monthly report happens without you.

The examples use `example.com`, with Cloudflare as the DNS host. Any domain and any DNS host work: where a step says Cloudflare, do the same thing on your DNS host's records page.

Screens marked *(not checked)* have not been seen by anyone at Boss Man; the names may differ in your version.

### Before you start

- The site has been published at least once at its own https address. For that, `SITE_URL`, `CF_PAGES_PROJECT`, `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` must be in Settings → Secrets (see "Where the publish settings come from").
- You can sign in to your DNS host (for example Cloudflare), to a Google account that can use Google Cloud, to Bing Webmaster Tools (with a Microsoft, Google or Facebook account), and to your Umami as an admin.
- You do not need to change or redeploy anything in Cloudflare. Boss Man builds the site itself and uploads it, so Cloudflare's own build settings and variables are not used.

### What Boss Man does (you do nothing)

- **Builds the sitemap** (`/sitemap.xml`) and `robots.txt` on every publish.
- **Serves the IndexNow key file** at `https://example.com/<key>.txt` once the key is in Secrets.
- **Tells IndexNow (Bing and others) about changed pages** after every publish. If the notice fails twice, the CEO gets a ticket. You do not.
- **Submits the sitemap to Google and Bing** once, after your steps 4 to 6. Google and Bing then re-read it by themselves.
- **Adds the Umami script and click events** (Install, GitHub, Roadmap) to every page, and stops a publish if a page is missing the script.
- **Writes the monthly website report** from Google, Bing and Umami.

### Step 1. IndexNow key

1. In Boss Man, open Settings → Secrets and add an entry.
2. Name: `INDEXNOW_KEY`. Value: 32 letters and digits you make up (8 to 128 letters, digits or dashes are accepted). You do not need to keep a copy.
3. Save.

**You should see:** the entry listed under Secrets. After the next publish, `https://example.com/<your key>.txt` shows the key. Boss Man checks this for you.

**Undo:** delete the entry. The next publish removes the key file and sends no more notices.

### Step 2. Umami: add the site

1. Sign in to your Umami and open Settings → Websites → Add website. *(Not checked.)*
2. Name: your site's name. Domain: `example.com`. Save.
3. Open the new website's settings and copy its **Website ID** (a UUID such as `20c32c42-…`) and, from the tracking code, the **script address** (the `src` value, for example `https://stats.example.com/script.js`). *(Not checked.)*
4. In Boss Man, open Settings → Secrets and add two entries: `UMAMI_WEBSITE_ID` with the Website ID, and `UMAMI_SCRIPT_URL` with the script address. Set both or neither.

**You should see:** after the next publish, a visit to any page shows in Umami within a few seconds.

**Most common failure:** the publish stops with "UMAMI_SCRIPT_URL and UMAMI_WEBSITE_ID must be set together (or both left empty)". One of the two is missing: add it. "UMAMI_WEBSITE_ID must be the site ID Umami shows (a UUID)" means something other than the Website ID was pasted.

**Undo:** delete both entries. The next publish has no statistics script. Delete the website in Umami to remove its figures.

### Step 3. Umami: read-only login for the monthly report

1. In Umami, add a new user with a username and a long password you make up. Give it the view-only role, with access to this website only. *(Not checked.)*
2. In Boss Man, open Settings → Secrets and add an entry. Name: `UMAMI_READER_LOGIN`. Value: the username and password joined by a colon, for example `report-reader:YourLongPassword`.
3. Save.

**You should see:** the entry listed under Secrets. The next monthly report has visit figures.

**Undo:** delete the Secrets entry and the Umami user. The monthly report then has no visit figures.

### Step 4. Google Cloud: a service account key for Boss Man

Boss Man reads Search Console and submits the sitemap as a Google service account: a Google login for a program, not a person. You make it once.

1. Open https://console.cloud.google.com and pick or create a project. *(Not checked.)*
2. Turn on the **Google Search Console API** for that project: APIs & Services → Library, search for it, Enable. *(Not checked.)*
3. Go to IAM & Admin → **Service accounts** and create a service account. Any name works, for example `boss-man-search`. It needs no project roles. *(Not checked.)*
4. Click the new account's email address, open the **Keys** tab, click **Add key** → **Create new key**, choose **JSON**, then **Create**. A key file downloads. Google lets you download it only once.
5. In Boss Man, open Settings → Secrets and add an entry. Name: `GOOGLE_SEARCH_CONSOLE_KEY`. Value: the whole contents of the key file. Save.
6. Keep the key file open: you need its `client_email` value (it ends in `.iam.gserviceaccount.com`) in step 5. Then delete the file from your computer.

**You should see:** a key listed on the Keys tab, and the entry under Secrets.

**Most common failure:** "Create new key" is refused because your organisation blocks service account keys (`iam.disableServiceAccountKeyCreation`). Use a project outside that organisation, or ask its admin to allow keys for this project.

**Undo:** delete the Secrets entry, then on the Keys tab click Delete for the key. A deleted key cannot be brought back.

### Step 5. Google Search Console

1. Open https://search.google.com/search-console and add a property. Choose **Domain** and type `example.com` (no `https://`).
2. Google shows a TXT record starting `google-site-verification=`. Copy it.
3. On your DNS host, add a record. Cloudflare: open the domain, DNS → Records → Add record. Type `TXT`, Name `@`, Content the value you copied. Save.
4. Back in Search Console, click **Verify**.
5. Open Settings → Users and permissions → Add user. Email: the `client_email` from the key file in step 4. Permission: **Full**. Full is needed so Boss Man can submit the sitemap; Restricted only lets it read.

**You should see:** "Ownership verified", and the service account listed with Full permission. A new TXT record can take minutes, sometimes a day or two, to be seen. If Verify fails, wait and try again.

**Undo:** remove the user in Users and permissions, remove the property, then delete the TXT record. Keep the TXT record for as long as you want the property: Google re-checks it.

### Step 6. Bing Webmaster Tools

1. Open https://www.bing.com/webmasters, sign in, and choose to import your site from Google Search Console. Allow access. Bing copies the verified site, so you add no file or record. *(Not checked.)*
2. Click Settings (top right) → API Access. Accept the terms the first time, then click **Generate API Key**.
3. In Boss Man, open Settings → Secrets and add an entry. Name: `BING_WEBMASTER_API_KEY`. Value: the key. Save.

**You should see:** your site listed in Bing Webmaster Tools as verified. Bing makes one API key per user, and it works for all your sites; Boss Man reads only this site.

**Undo:** delete the Secrets entry, delete the key on Bing's API Access page, and remove the site in Bing Webmaster Tools.

### After setup

Nothing more for you. Search engines take days to weeks to show pages; the monthly report says how many are indexed. You can see the IndexNow list yourself under Bing Webmaster Tools → IndexNow; Boss Man cannot read that screen.

## Cloudflare Pages settings

These are used only by a build that Cloudflare runs itself (a Git-connected project). `scripts/publish-site.sh` builds on the runner and uploads the result, so it ignores them. Root directory `/`, build command `pnpm --filter @boss-man/site build`, output directory `apps/site/dist`, Node 22, environment variables `SITE_URL` and `PORTAL_URL`. Pages serves `guides/install-boss-man.html` at `/guides/install-boss-man` and `404.html` for unknown paths. `src/_headers` sets security and cache headers; its Content-Security-Policy allows only the site's own files, so no inline styles or scripts (the check fails on either). `src/_redirects` sends the old `/features`, `/how-it-works` and `/get-started` addresses to the home page and the new guides.

## Where things are

- `src/pages/*.html`: the home page and the 404 page. Each starts with `---` front matter (`title`, `description`, `path`, `nav`), then the page body. `{{repo}}`, `{{guide}}`, `{{licence}}`, `{{issues}}` and `{{portal}}` are filled from `src/site.json`, the one place to change the GitHub address. An unknown `{{name}}` stops the build. A block between `<!--portal-->` and `<!--/portal-->` is dropped while there is no portal address.
- `src/guides/*.md`: one file per guide, and `faq.md`. Front matter: `title`, `description`, `group` (Start here, Everyday use, Set it up your way, Questions), `order`, `lead`, optional `time` and `path`. The build turns them into the guide template (guide list, the page's own headings list, previous and next links). The Markdown subset is documented at the top of `scripts/markdown.mjs`, and the build stops on anything outside it, including a link that is not `/path`, `#id`, `https://` or `@repo/...` (the GitHub address).
- `CHANGELOG.md` at the repo root: the "What's new" page (`/whats-new`, linked from the main menu and the footer). One `## 16 November 2026` entry per day, newest first, listing only what a user would notice, in plain words. The build stops on a heading that is not a date, dates out of order or repeated, or a ticket number. Everything above the first entry, including the release-step comment, stays off the page. When `SITE_URL` is set the same entries (newest 20) also go out as an Atom feed, `/whats-new.xml`, written by `build.mjs` and checked by `check.mjs`; every page's head links to it. Adding the day's entry is part of the release step (see the comment at the top of the file).
- `src/styles.css`: all styles, with the design tokens at the top of `:root`.
- `public/`: copied as is. `img/` holds the screenshots (WebP, taken from a throwaway server with made-up data, never live data), the step drawings, the diagrams (SVG with a narrow phone version and a PNG fallback), and the share image. Fonts are IBM Plex Sans and Archivo (SIL Open Font License, licences next to them).
- `scripts/build.mjs`, `scripts/markdown.mjs`, `scripts/check.mjs`, `test/`.

The designs and the mock-ups are in `docs/design/bos-779-website-v2/` (on the BOS-779 branch) and the design note on the wiki. The copy comes from the wiki page "Website v2: content plan, home copy and guides (BOS-778)". Launching is separate (BOS-83): the repo must be public first, or every GitHub link shows GitHub's 404.
