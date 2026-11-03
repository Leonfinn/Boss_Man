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
