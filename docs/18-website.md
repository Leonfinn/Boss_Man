# The website (apps/site)

The public site is plain HTML, one CSS file and a small build script in `apps/site`. It has no framework and no client JavaScript except a 20-line phone-menu script (`menu.js`); the nav is a plain list of links without it.

## Build and check

```
pnpm build:site                         # same as: pnpm --filter @boss-man/site build -> apps/site/dist
pnpm --filter @boss-man/site check      # links, images, titles, descriptions, one h1, lang, alt text
pnpm --filter @boss-man/site test
```

`SITE_URL` (for example `https://example.com`, no trailing slash) turns on canonical links, absolute `og:` image URLs and `sitemap.xml`. Without it those are left out. Set it in the Cloudflare Pages build settings once the domain is chosen.

## Cloudflare Pages settings

Root directory `/`, build command `pnpm --filter @boss-man/site build`, output directory `apps/site/dist`, Node 22, environment variable `SITE_URL`. Pages serves `features.html` at `/features` and `404.html` for unknown paths. `src/_headers` sets security and cache headers; its Content-Security-Policy allows only the site's own files, so no inline styles or scripts.

## Where things are

- `src/pages/*.html`: one file per page. Each starts with `---` front matter (`title`, `description`, `path`, `nav`), then the page body. `{{repo}}`, `{{guide}}`, `{{licence}}` and `{{issues}}` are filled from `src/site.json`, the one place to change the GitHub address. An unknown `{{name}}` stops the build.
- `src/styles.css`: all styles. Colours match the app's dark theme; sizes follow the Penpot boards (BOS-80).
- `public/`: copied as is. `img/` holds the hero, the OG image (`og.png`), the eight feature icons (96 px WebP, navy) and the existing Boss Man art copied from `assets/brand/`. The icons are shown in the link colour with a CSS mask, because navy is invisible on the dark cards. Fonts are IBM Plex Sans (SIL Open Font License, copied from `@fontsource/ibm-plex-sans`, licence next to them).
- `scripts/build.mjs`, `scripts/check.mjs`, `test/site.test.ts`.

The copy comes from the wiki page "Website: brief, sitemap and page copy (BOS-79)". Launching is separate (BOS-83): the repo must be public first, or every GitHub link shows GitHub's 404.
