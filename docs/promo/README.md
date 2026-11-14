# Boss Man promo video: how to remake it

Every frame is the real Boss Man web app running on a throwaway server filled with made-up data about a
team building a website ("Fernleaf"). Nothing is drawn or generated: a script clicks through the app in a
hidden Chromium and records it; ffmpeg adds title cards, one caption per scene and short fades.
No live server, no real host names, IPs, emails or keys are involved. The raw frames and the finished MP4
are never committed (they live in the ticket's scratch folder; the video itself is hosted by GitHub).

## Remake it

All commands from the repo root. Use a short `TMPDIR` or Chromium will not start ("Socket path too long").

1. Build the web app: `pnpm --filter @boss-man/web build`
2. Seed a fresh, empty database (made-up data only), from `apps/server`:
   `DEMO_PASSWORD=<throwaway> node_modules/.bin/tsx <seed.mts> <new empty folder>`
   (`docs/promo/seed.mts` if present, otherwise `docs/design/bos-779-website-v2/scripts/seed.mts`).
3. Start the real server on it, on localhost only, with no runner and no API keys (so no agent ever starts):
   `BOSSMAN_MASTER_KEY=<random> BOSSMAN_PGLITE_DIR=<that folder> BOSSMAN_WEB_DIR=apps/web/dist BOSSMAN_INSECURE_COOKIES=1 HOST=127.0.0.1 PORT=3411 node_modules/.bin/tsx src/main.ts` (from `apps/server`)
4. Record: `DEMO_PASSWORD=<throwaway> OUT=<scratch folder> node docs/promo/capture.mjs [sceneId ...]`.
   Some scenes change data (approving a decision), so a retake needs a freshly seeded database.
   `capture.mjs` refuses any server that is not on localhost, and fails a scene if its page text holds an IP
   address, an email address, a key-shaped string or a host name other than example.com or github.com.
5. Assemble: `FFMPEG=<ffmpeg with libx264> OUT=<same folder> node docs/promo/build.mjs`
   Writes `boss-man-promo.mp4` (1920x1080, 30 fps, H.264, under GitHub's 10 MB limit) in `OUT`.

6. Poster (`poster.jpg`, shown in the main README): one frame from the board scene, e.g.
   `ffmpeg -ss 9 -i boss-man-promo.mp4 -frames:v 1 docs/promo/poster.jpg`.
   The MP4 itself is uploaded by the owner through GitHub's README editor (see the research page BOS-1432).

## Files

- `scenes.mjs`: the storyboard; one entry per scene with its caption and the clicks.
- `cards.mjs`: title and end cards, and the playing order.
- `lib.mjs`: browser, pointer dot, frame recording, the text scan.
- `capture.mjs`, `build.mjs`: the two steps above.

Desktop scenes are recorded at 1920x1080 CSS pixels with a DevTools screencast (sharp, 1:1). Phone scenes
use a 390 px wide window at ratio 3 and real screenshots in a loop. The page clock is fixed, so "2 min ago"
labels do not drift between takes.
