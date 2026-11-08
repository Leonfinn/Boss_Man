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

## When a ticket names a device

The generic phone size above is not the owner's phone. Each of the owner's browsers is recorded as a device profile (Settings → Server and runner → Your devices) and saved as `apps/web/test/device-profiles/*.json`. So the acceptance line for a UI ticket that names a device is:

> checked at that device's recorded profile (profile rendering test) as well as the plain-http phone check above

QA does this for every device-named ticket:

1. Run `pnpm --filter @boss-man/web exec vitest run test/sidebar-device-profile.test.ts`. It renders the app at each saved profile's width and height and reproduces the toolbar gap from the profile's own `100lvh − 100dvh`. It is skipped, not failed, where no browser is installed: a skip is not a pass, so say so and use agent-browser instead.
2. If the owner's real profile for that device is not in the folder yet, ask for it to be recorded in Settings and drop the JSON in (the test picks up any file there). Until then, `example-foldable.json` is only a stand-in: its numbers (840x900, 2.6 pixel ratio, a 120 px toolbar gap that closes after scroll) are plausible for an unfolded foldable but are not measured, so a pass on it does not prove the owner's device.
3. Report the profile file names the run used in the ticket.
