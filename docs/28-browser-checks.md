# Browser checks for UI work

Browsers allow things on `http://localhost` that they block on the plain-http LAN or Tailscale address the owner actually uses. The clipboard API is undefined off localhost, so a Copy button can "pass" on localhost and not work for the owner (BOS-336). So a UI check is done:

> checked over plain http on a non-localhost address, desktop and phone, by using the control (click, type, copy), not only by seeing it

`scripts/browser-check.sh` does the loading part, on any Docker host and any address:

```sh
scripts/browser-check.sh --port 3100 --path / --out /tmp/shots   # screenshots + rendered DOM, desktop and phone
scripts/browser-check.sh --print-url                             # only the URL, for your browser tool
```

- The runner's own non-loopback address is found at run time (`hostname -I`, then the default route's source address). `BOSSMAN_CHECK_HOST` overrides it; a loopback host is refused.
- Desktop is 1280x800; the phone profile is 390x844 with touch and a mobile user agent.
- Seeing a screenshot is not a check. Open the printed URL with your browser tool (agent-browser, which uses the same Chromium), at both sizes, and click, type and copy.
- The app must listen on all interfaces (not only 127.0.0.1) for the address to work.

## Screenshots of the web build: `scripts/screenshot.mjs`

For a picture of one screen at one width (a layout ticket, a QA proof), use the script, not hand-run Chromium (BOS-1060):

```sh
pnpm --filter @boss-man/web build        # once; the script serves apps/web/dist
node scripts/screenshot.mjs --route "#board/p1" --width 1667 --wait ".board-scroll" --out "$BOSSMAN_SCRATCH/board.png"
node scripts/screenshot.mjs --route "#settings/c1/funding" --width 1667 --wait "#funding-h" --out "$BOSSMAN_SCRATCH/funding.png"
node scripts/screenshot.mjs --route "#board/p1" --width 380 --touch --api my-api.json --wait ".board-scroll" --out shot.png
```

Pick a `--wait` selector that only the finished screen has (a section id, not `h1`: the app's error card has headings too). If the wait fails the script still saves what the page showed as `OUT.failed.png`, and it prints each `/api` path it had no fixture for and any page error: a screen that reads `.length` of an unmocked list shows "This page hit an error", and the fix is a line in the `--api` file.

- It serves the build on 127.0.0.1 and answers `/api/*` from a built-in fixture (signed-in owner, one company, one project, an empty board). `--api FILE` is a JSON map of `"/api/path": body` that adds or replaces paths; an unknown path gets `{}`. Find which paths a screen asks for in the page's `api(...)` calls.
- `--wait SELECTOR` is required: it waits for that element to be visible, never a fixed time, and exits non-zero with one line if it does not appear. Other options: `--height`, `--ratio`, `--touch`, `--full-page`, `--timeout`, `--dist`, `--url` (a running app instead of the local server).
- It needs no permission cards beyond running it. Its temp files live in one folder it creates and removes (also on Ctrl-C); the browser runs with `ulimit -c 0`, so a crash leaves no core dump.

Why hand-run Chromium failed on the runner (BOS-1053): (1) the run's temp path is long and Chromium's socket path limit is 107 characters ("Socket path too long", the crash on its temp folder); the script points `TMPDIR` at a short link. (2) `/dev/shm` on the runner is 64 MB and can be nearly full, so pointing Chromium at it, or letting it use it for renderer memory, gives a blank page; the script passes `--disable-dev-shm-usage` and never writes there except the link.

## Claims about a video or image

Any claim about a video in owner-facing text (a README line, a ticket reply, a release note) quotes the output of `node scripts/media-facts.mjs FILE`: duration, size, resolution, frame rate, and `audio: yes` or `audio: no (silent)` with the track list. Never copy such a claim from another reply: the README once said "with sound" about a video that had no audio track (BOS-1569). The script reads MP4/WebM files in plain Node and uses `ffprobe` when it is installed, so it works on the runner. For an image, quote the pixel size from a measured source (the screenshot script's output, or `file`), not from memory.

## When a ticket names a device

The generic phone size above is not the owner's phone. Each of the owner's browsers is recorded as a device profile (Settings → Server and runner → Devices and privacy, in the "Your devices" section) and saved as `apps/web/test/device-profiles/*.json`. So the acceptance line for a UI ticket that names a device is:

> checked at that device's recorded profile (profile rendering test) as well as the plain-http phone check above

QA does this for every device-named ticket:

1. Run `pnpm --filter @boss-man/web exec vitest run test/sidebar-device-profile.test.ts`. It renders the app at each saved profile's width and height and reproduces the toolbar gap from the profile's own `100lvh − 100dvh`. It is skipped, not failed, where no browser is installed: a skip is not a pass, so say so and use agent-browser instead.
2. If the owner's real profile for that device is not in the folder yet, ask for it to be recorded in Settings and drop the JSON in (the test picks up any file there). Until then, `example-foldable.json` is only a stand-in: its numbers (840x900, 2.6 pixel ratio, a 120 px toolbar gap that closes after scroll) are plausible for an unfolded foldable but are not measured, so a pass on it does not prove the owner's device.
3. Report the profile file names the run used in the ticket.
