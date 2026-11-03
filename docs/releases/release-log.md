# Release log

Newest first. One entry every time the live commit changes, however it changed.

## 3 Nov 2026, live after 12:32 UTC: d86dbe1f

- **Live commit:** d86dbe1f (was 2d5e3035).
- **How it went live:** the host deployer (server deploy).
- **Tickets shipped:**
  - BOS-336: Copy buttons on hand-apply cards copy again over plain http, and if copying fails the text is selected for you.
  - BOS-383: A second Claude Max plan can be added on the Funding page and used automatically when the first is full.
- **You had to do:** nothing for the release itself. To use a second Claude plan, add its setup-token under Settings > Secrets and set its order on the Funding page. See the notes page for the steps.
- **Known issues:** a run already going finishes on the plan it started on. Expand-only migration (0099), applied automatically on start, so no separate step.
- **Rollback point:** 2d5e3035 (the commit this replaced). Roll back with `host-deployer.sh --rollback` run by hand as root; on a blue/green install the automatic switch-back covers the window after a swap.
- **Time:** exact UTC time not confirmed (the deployer's finished record was not readable from this run). To find out, Settings > Server and runner > Updates, "last deploy".
- **Note:** this entry also covers ticket 21455465 (the copy-button fix landed in the same d86dbe1f merge as 3a7e65ec).
- **Fuller notes:** [[releases/2026-11-03-d86dbe1f]]
