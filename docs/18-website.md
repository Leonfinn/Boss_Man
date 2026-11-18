# The website (apps/site)

The public site is plain HTML, one CSS file and a small build script in `apps/site`. It has no framework and one small script (`menu.js`: the phone menu, the Copy buttons on code blocks and the "On this page" marker). Without it every page still works: the nav is a plain list of links and the guide list is open.

## Build and check

```
pnpm build:site                         # same as: pnpm --filter @boss-man/site build -> apps/site/dist
pnpm --filter @boss-man/site check      # links, images, titles, descriptions, one h1, heading order, lang, alt text, no inline styles or scripts
pnpm --filter @boss-man/site test
```

`SITE_URL` (an https address such as `https://example.com`, no path; the build stops on anything else) turns on canonical links, absolute `og:` image URLs and `sitemap.xml`. Without it those are left out. Set it in the Cloudflare Pages build settings once the domain is chosen.

`PORTAL_URL` (or `portalUrl` in `src/site.json`) is the public https address of Boss Man's own feedback portal. While it is empty, every roadmap link (menu, footer, home page box) is left out, so the site never carries a home-network address. The build refuses anything that is not a public https address with a domain name (no IP address, `.local`, `.lan`, `.ts.net`, `localhost` or login in the address). The links open the portal in the same tab. Never put the portal's secret link in the repo.

`SITE_OUT` builds somewhere other than `apps/site/dist`.

`INDEXNOW_KEY` (8 to 128 letters, digits or dashes; kept in Boss Man's Secrets, never in the repo) makes the build write `/<key>.txt` holding just the key, as IndexNow requires. Sitemap dates (`<lastmod>`) come from each source file's git history; with no history (a shallow clone) the date is left out rather than guessed.

After a successful deploy, the publish step runs `node apps/site/scripts/indexnow.mjs --previous <old sitemap>` (before the deploy, `--fetch-previous <file>` saves the live sitemap). It sends only changed pages to IndexNow, retries once, runs the shell command in `INDEXNOW_ON_FAILURE` (which raises a CEO ticket) after a second failure, and always exits 0 so a publish never fails because of it. Google reads changes from the sitemap.

## Cloudflare Pages settings

Root directory `/`, build command `pnpm --filter @boss-man/site build`, output directory `apps/site/dist`, Node 22, environment variables `SITE_URL` and `PORTAL_URL`. Pages serves `guides/install-boss-man.html` at `/guides/install-boss-man` and `404.html` for unknown paths. `src/_headers` sets security and cache headers; its Content-Security-Policy allows only the site's own files, so no inline styles or scripts (the check fails on either). `src/_redirects` sends the old `/features`, `/how-it-works` and `/get-started` addresses to the home page and the new guides.

## Where things are

- `src/pages/*.html`: the home page and the 404 page. Each starts with `---` front matter (`title`, `description`, `path`, `nav`), then the page body. `{{repo}}`, `{{guide}}`, `{{licence}}`, `{{issues}}` and `{{portal}}` are filled from `src/site.json`, the one place to change the GitHub address. An unknown `{{name}}` stops the build. A block between `<!--portal-->` and `<!--/portal-->` is dropped while there is no portal address.
- `src/guides/*.md`: one file per guide, and `faq.md`. Front matter: `title`, `description`, `group` (Start here, Everyday use, Set it up your way, Questions), `order`, `lead`, optional `time` and `path`. The build turns them into the guide template (guide list, the page's own headings list, previous and next links). The Markdown subset is documented at the top of `scripts/markdown.mjs`, and the build stops on anything outside it, including a link that is not `/path`, `#id`, `https://` or `@repo/...` (the GitHub address).
- `CHANGELOG.md` at the repo root: the "What's new" page (`/whats-new`, linked from the main menu and the footer). One `## 16 November 2026` entry per day, newest first, listing only what a user would notice, in plain words. The build stops on a heading that is not a date, dates out of order or repeated, or a ticket number. Everything above the first entry, including the release-step comment, stays off the page. Adding the day's entry is part of the release step (see the comment at the top of the file).
- `src/styles.css`: all styles, with the design tokens at the top of `:root`.
- `public/`: copied as is. `img/` holds the screenshots (WebP, taken from a throwaway server with made-up data, never live data), the step drawings, the diagrams (SVG with a narrow phone version and a PNG fallback), and the share image. Fonts are IBM Plex Sans and Archivo (SIL Open Font License, licences next to them).
- `scripts/build.mjs`, `scripts/markdown.mjs`, `scripts/check.mjs`, `test/`.

The designs and the mock-ups are in `docs/design/bos-779-website-v2/` (on the BOS-779 branch) and the design note on the wiki. The copy comes from the wiki page "Website v2: content plan, home copy and guides (BOS-778)". Launching is separate (BOS-83): the repo must be public first, or every GitHub link shows GitHub's 404.
