# Website v2 mock-ups (BOS-779)

HTML mock-ups of the redesigned home page and the guide page template, for the build in BOS-780. The design note on the wiki (product/website/website-v2-design-note-bos-779) explains every choice; the owner reviews the same designs in Penpot ("Website v2 (BOS-779)").

These are mock-ups, not the site: the build goes into `apps/site` using its own templates.

## Files

- `home.html`, `guide.html`: the two pages.
- `mock.css`: tokens and the home page; `guide.css`: the guide template on top of it.
- `scripts/seed.mts`: fills a new, empty PGlite folder with a made-up website project (Fernleaf, Soo's sample data in BOS-778) for screenshots: tickets, decision cards, features with feedback, a roadmap and a feedback portal. Never point it at real data.
- `scripts/age.mts`: spreads the made-up times so cards don't all say "just now", and puts the contact-form question first.
- `scripts/shot.cjs`: logs in to the throwaway server and takes a screenshot (whole screen, a region or one element).
- `scripts/render.cjs`: renders a mock-up at 1440, 840 and 390 px, full page, and warns if a page scrolls sideways.
- `scripts/dehalo.cjs`: removes the white sticker halo round a cut-out drawing, so its own outline is its edge. Makes `img/hero-clean.png` from `hero.webp` and `img/boss-head-clean.png` from `boss-mark-256.png`. The build should ship these cleaned files.
- `scripts/zoom.cjs`: a close-up of one element of a mock-up at one width.

Images and fonts are not in the repo. To open the mock-ups, make `img/` and `fonts/` folders next to the HTML:

- `fonts/`: `ibm-plex-sans-latin-400-normal.woff2` and `-700-` from `apps/site/public/fonts`, and `archivo-latin-wdth-normal.woff2` from `@fontsource-variable/archivo/files` (an `apps/web` dependency).
- `img/`: `hero.webp`, `boss-setup.webp`, `boss-busy.webp`, `boss-done.webp`, `boss-mark-256.png` from `apps/site/public/img`, plus the screenshots below.

## Retaking the screenshots

With the web app built (`apps/web`: `vite build`) and from `apps/server`:

1. `DEMO_PASSWORD=<any throwaway value> node_modules/.bin/tsx ../../docs/design/bos-779-website-v2/scripts/seed.mts /tmp/<you>-site/pg`
2. `node_modules/.bin/tsx ../../docs/design/bos-779-website-v2/scripts/age.mts /tmp/<you>-site/pg`.
3. Start a throwaway server on that folder: `PORT=3779 HOST=127.0.0.1 BOSSMAN_PGLITE_DIR=/tmp/<you>-site/pg BOSSMAN_MASTER_KEY=$(openssl rand -base64 32) BOSSMAN_INSECURE_COOKIES=1 BOSSMAN_LEADER_LOCK=0 BOSSMAN_WEB_DIR=$PWD/../web/dist node_modules/.bin/tsx src/main.ts`. Dismiss the setup checklist once (PUT `/api/setup-progress` with `{"dismissed":true}`).
4. With `DEMO_PASSWORD` set as in step 1, from `scripts/`:
   - `board-wide.png`: `node shot.cjs "#/board/<project id>" board-wide.png 1920 1080 2`
   - `board-crop.png`: `CLIP=480,355,1320,560 node shot.cjs "#/board/<project id>" board-crop.png 1920 1080 2`
   - `card-phone.png`: `EL='li:has-text("How many contact form")' node shot.cjs "#/decisions" card-phone.png 390 844 3`
   - `card-wide.png`: the same with `1100 1000 2`
   - `agents-crop.png`: `CLIP=270,613,1150,430 node shot.cjs "#/agents" agents-crop.png 1440 1000 2`
   - `roadmap-crop.png`: `CLIP=272,222,1130,580 node shot.cjs "#/roadmap" roadmap-crop.png 1440 1000 2`
   - `portal-phone.png`: `node shot.cjs "portal.html#fernleafDemoPortalToken779abcdef" portal-phone.png 390 844 3` (the made-up portal link the seed sets)

   The seed prints the company and project ids.
