# Self-deploy: the host deployer (phase 1) and the runner drain (phase 2)

Status: built (phases 1 and 2). Phase 0 (`scripts/deploy.sh`, run by hand) is the base. Phase 2's runner drain is described in its own section below. The leader lock and the separate migrate step (phase 3, part 1) are built, and so is the opt-in blue/green swap (phase 3, part 2). Blue/green was first run on a real TrueNAS NAS on 22 and 23 Oct 2026; what that run found is in "Lessons from the first real run" below. Install steps are in `docs/06-install-truenas.md` ("Install the host deployer"). Anything marked **UNVERIFIED** was not checked against a real TrueNAS box or the vendor's current docs.

## What it does

When `main` moves on GitHub, Boss Man shows an owner decision "Deploy Boss Man abc1234 -> def5678?". Approving it makes the NAS update Boss Man itself: backup, build, restart, health check, and a result the owner sees in the UI and in notifications. The thing that does the updating is a root-owned script on the TrueNAS host, so it is not the container it replaces and no container gets `docker.sock`.

```
host script, every minute ─▶ outbox/available.json   "main is ahead of what runs"
      ▲                                │
      │                                ▼
      │                  Boss Man raises an owner decision (or: Settings > Server and runner > Updates > Deploy latest)
      │                                │ owner approves
      │                                ▼
      │                  server writes inbox/request.json (tmp + rename)
      └─ checks it, runs deploy.sh or update-runner.sh ─▶ outbox/status.json
                                       │
            server poller (30 s) ◀──────┘  notification + Settings "last deploy" + webhook on failure
```

## Decisions made

1. **Host script plus a one-minute TrueNAS cron job.** No container, no socket.
2. **It reuses `scripts/deploy.sh`** (backup, build, restart, health) and `scripts/update-runner.sh`, so there is one deploy path. `deploy.sh` gained `--commit SHA` so it deploys exactly the commit that was checked, not whatever main is by then.
3. **The git remote is the source of truth.** The `src` checkout pulls from its `origin`: https for a public repo, or an SSH remote with a read-only deploy key set as `core.sshCommand` for a private one (`docs/00`, step 2). The host decides what "the tip of main" is with `git ls-remote origin refs/heads/main` over the same remote: no API token, no extra credential. On a new host, the move guide (`docs/21-move-to-new-host.md`) sets up the same key.

   Exact clone commands (full steps in `docs/00`, step 2), with `$B` as the install folder:

   ```sh
   # public repo
   git clone <repo-https-url> $B/src
   # private repo, read-only deploy key
   git clone -c core.sshCommand="ssh -i $B/deploy_key -o IdentitiesOnly=yes -o UserKnownHostsFile=$B/known_hosts" <repo-ssh-url> $B/src
   ```
4. **Server deploys and runner updates are separate approvals.** A runner update drains first (phase 2 below), so it no longer cuts off agent runs unless the owner says so.
5. **Infra files are never auto-deployed.** `docker-compose.yml`, `deploy/`, Dockerfiles, the deploy scripts and the like (the exact list is in step 6 below) only deploy when the owner runs `scripts/deploy.sh` by hand on the host that runs Boss Man.
6. **The failure alert is a generic webhook** configured on the host only (a root-owned file), not in Boss Man's database, because it must work when Boss Man is down. The owner points it at a Home Assistant webhook automation; ntfy works too.
7. The server can write **one folder** and read **one folder**. It can never run anything on the host, and the host never executes anything from the request.
8. At most **one deploy per target every 10 minutes**; the cron job runs every minute.

## Files on TrueNAS

Base: `/mnt/NVME_Apps/Container_files/boss-man/deployer` (`$D` below).

| Path | Owner : mode | Written by | Purpose |
|---|---|---|---|
| `$D/` | root:root 755 | owner | Not writable by the server. |
| `$D/host-deployer.sh` | root:root 750 | owner, by hand | A **copy** of `scripts/host-deployer.sh`. Never a link into the checkout, so a merged PR cannot change what root runs. |
| `$D/host.conf` | root:root 600 | owner, by hand | Webhook URL and options (below). The script refuses to start if it is not private. |
| `$D/inbox/` | 1000:1000 750 | server (uid 1000) | The only place the server writes. Bind-mounted read-write into the server. |
| `$D/inbox/request.json` | 1000:1000 640 | server | One pending request. The host takes it by renaming it out of the folder. |
| `$D/inbox/check` | 1000:1000 640 | server | "Look at main now": left by **Deploy latest** when it finds nothing new. Only its existence is read; the host deletes it and refreshes `available.json` on its next tick instead of waiting for the 5-minute refresh. |
| `$D/outbox/` | root:root 755 | host | Bind-mounted **read-only** into the server. |
| `$D/outbox/status.json` | root:root 644 | host | What happened to the last request. |
| `$D/outbox/available.json` | root:root 644 | host | What main has that is not deployed yet (refreshed every 5 minutes). |
| `$D/outbox/history.jsonl` | root:root 644 | host | One line per finished request; also the replay guard. |
| `$D/state/` | root:root 700 | host | `last-server`, `last-runner` (rate limit), and the request while it is being handled. |
| `$D/lock` | root:root | host | `flock` file: one run at a time, server and runner alike. |
| `$D/deployer.log` | root:root | host | Everything the script and `deploy.sh` printed for real runs (trimmed to 2000 lines past 1 MB). |

`deploy.sh` keeps its own `deploy-status.json`, backups and `…previous-commit` in the existing `boss-man/` folder; the host copies the outcome into `outbox/status.json`. There is no Gitea token, no infra-approval token and no pinned copy of `deploy.sh` any more: the checkout's `scripts/` is safe to run because step 5 below proves it did not change since the last vetted deploy.

### Compose

`deploy/truenas-deployer.yml` is an **optional extra override**, so installs that have not set this up are unaffected:

```yaml
services:
  server:
    environment:
      BOSSMAN_DEPLOYER_DIR: /run/deployer
    volumes:
      - ${BOSSMAN_DEPLOYER}/inbox:/run/deployer/inbox
      - ${BOSSMAN_DEPLOYER}/outbox:/run/deployer/outbox:ro
```

The owner enables it once by hand (it is an infra file): add it to `COMPOSE_FILE` and set `BOSSMAN_DEPLOYER` in `.env`. Without `BOSSMAN_DEPLOYER_DIR` the server's feature is off and the Updates panel in Settings is hidden. CI renders the merged file and checks both mounts and that no socket is mounted.

## Request file

`inbox/request.json`, written to a temp name and renamed so the host never reads half a file:

```json
{ "id": "decision uuid", "target": "server", "commit": "40 hex characters", "requestedAt": "2026-10-20T12:00:00.000Z", "approvedBy": "owner id" }
```

`target` is `server` or `runner`. Anything else, a missing field, a bad format, or a file over 4 KB is refused; unknown extra fields are ignored. Every field is validated against a strict pattern before it is used, and the only action chosen from it is the `target`. `approvedBy` is only for the log.

## What the host script checks (in order; a failure writes `status.json` with the reason and posts the webhook)

1. `flock`: if a run is going, exit quietly and try next minute.
2. Take the request by renaming it into `state/` (a symlink is moved as a symlink, never followed), then require a plain file under 4 KB that matches the schema.
3. **Replay:** the `id` must not already be in `history.jsonl`.
4. **Tip of main** (target `server`): `git ls-remote origin refs/heads/main` must equal `commit`. An older commit or a side branch is refused. For target `runner` the commit must equal the commit that is deployed (runners are built from what is checked out), not the tip.
5. **Rate limit:** at most one deploy per target per `RATE_LIMIT_SECONDS` (600), measured from when the last one started, successful or not.
6. **Infra paths** (`server` only): `git fetch`, require the commit to be a fast-forward of what is deployed, then refuse if `git diff --name-only HEAD..commit` matches the infra list: `docker-compose*.yml`, `deploy/` (except `deploy/penpot.yml`, the separate Penpot add-on), the four scripts that deploy or run Boss Man (`scripts/deploy.sh`, `scripts/rebuild-live.sh`, `scripts/update-runner.sh`, `scripts/host-deployer.sh`), `.dockerignore`, `.npmrc`, `.env*` (top level), and any `Dockerfile*`. Documentation, CI files (`.github/`, `.gitea/`) and every other script are not on the list: they never run on the host, or only at build and check time (`scripts/make-app-icons.mjs`, `check-*`, `test-*`, `lint-migrations.mjs`, `ci-launcher.sh`, the backup and restore-test scripts). Migrations are not on it either: the app applies them on every deploy. The list is the `INFRA` variable in `scripts/host-deployer.sh`; the deployer's refusal and the hand-apply card (`infraPaths` in `available.json`) both use it, so they cannot disagree. When you add a script that changes how Boss Man runs or deploys, add it to `INFRA`; a build-only script needs nothing.

   **The hand-apply card (BOS-269).** It is built from what the host reports in `available.json`: `srcDir` and `deployerDir` (the real folders, never guessed), `bluegreen` and `liveColour`. The card picks `scripts/rebuild-live.sh` on blue/green and `scripts/deploy.sh --commit <sha>` on a single server from `bluegreen`. If a folder or the layout is not reported (an older host script) the card says so in plain words and shows no command. The "Rebuild the runners" step is on the card only when `runnerChanged` is true, the same flag that drives the "Runner update afterwards" line. Every command sits in its own fenced block under the sentence that explains it (`apps/server/src/services/steps.ts`): nothing but the text to paste, no `$`, no trailing punctuation, no placeholder to edit. The web app shows each block with a Copy button. Any owner step card can use `step()` from that file.
7. Run the fixed action under git settings that disable hooks: server = `scripts/deploy.sh --yes --no-runner --commit <sha>`; runner = `scripts/update-runner.sh`. Both go through one function each, so a later phase changes one place.
8. Write `status.json` and append it to `history.jsonl`; post the webhook if it was a failure (or on success when `WEBHOOK_ON_SUCCESS=1`).

`--dry-run` runs every check and prints what it would do without taking the request, running anything or writing anything.

## status.json and available.json

```json
{ "id": "decision uuid", "target": "server", "result": "deployed", "message": "Deployed abc12345 to def67890.", "from_commit": "…", "to_commit": "…", "started": "…", "ended": "…", "at": "…", "backup": "/mnt/…/bossman-2026-10-20-1200.sql.gz" }
```

`result` is `running`, `deployed`, `nothing_new`, `rejected`, `failed`, `partial` (server deployed, runner update failed) or `rolled_back`. While Boss Man restarts the file still holds `running`; when the new server starts its poller reads the final state and notifies. `available.json` carries `deployed`, `tip`, up to 30 commit subjects, up to 300 changed paths, `infraPaths`, and `runnerChanged` (same rule as `needs_runner` in `deploy.sh`; a test keeps the two copies equal). It lets the server show a range and changed areas without a GitHub token and without a git checkout of its own.

## Failure webhook

`host.conf`, a root-owned file (shell `KEY=value` lines):

```sh
WEBHOOK_URL='http://homeassistant.local:8123/api/webhook/PUT-A-LONG-RANDOM-ID-HERE'
WEBHOOK_ON_SUCCESS=0   # 1 = also post when a deploy succeeds
```

On a failure the script POSTs `Content-Type: application/json`:

```json
{ "result": "failed", "message": "…", "from_commit": "…", "to_commit": "…", "at": "2026-10-20T12:03:00Z" }
```

Failure means `failed`, `partial`, `rolled_back` or `rejected`. A webhook that cannot be reached is logged and ignored. The exact curl test and a Home Assistant automation are in `docs/06`.

## Decisions in Boss Man

- A decision of kind `approval` with context type `self_deploy` (no migration: no new enum value), tier `owner`, so only the owner's session can answer it; the CEO tool only answers `ceo`-tier decisions. Decisions belong to a company, so it is raised under the oldest one.
- **Server:** raised by the poller when `available.json` shows `tip` differs from `deployed`, one per tip (`dedupeKey`); an older open one is withdrawn when main moves again, or when the owner hand-deploys. `available.json` lags `main`: the host rewrites it at most every 5 minutes and only in a minute with no request waiting. So the poller does not offer a commit the latest `status.json` already settled (refused, deployed or nothing new) until `checkedAt` is later than that status. After a not-the-tip refusal the host also deletes `available.json`, so the next minute writes a fresh one. Without both, two merges a few minutes apart made a loop: the stale offer was approved, refused and raised again. The migrations count in the question counts `apps/server/drizzle/*.sql` only, not Drizzle's `meta/` files. Options `Deploy` / `Not now`. The text shows the commit range, subjects, file count, migrations, and whether runner code changed. If the range touches infra files it is only an alert (`Got it`) saying to run `scripts/deploy.sh` on the host. Settings > Server and runner > Updates > **Deploy latest** raises it again for the current tip even if it was put off.
- **Runner:** after a server deploy of a range that changed runner paths succeeds, the poller raises a separate `Update runners` / `Not now` decision for the deployed commit, whose text explains the drain (phase 2). **It waits for the server update trial first (BOS-368).** A blue/green server update reports `deployed` when it switches in, but the host can still switch it back during its standby window (`SOAK_SECONDS` on the host, default 900). The host writes the window it really uses into `status.json` as `soak_seconds` (0 when the install is not blue/green), and the server takes the length from there, never from its own environment. If it is missing (an older host), the server uses the `soakSeconds` the host publishes in `available.json` (BOS-384), and failing that 900 (BOS-401). So the poller holds the runner offer in the `self_deploy_runner_due` setting until the window plus 120 seconds has passed, and raises it only if the last server result is still `deployed` for that commit and `available.json` reports it running. Otherwise it drops the offer and logs why. A `rolled_back` or `failed` server result clears the held offer and withdraws every open runner card, whichever way round the host names the two commits. Every server update that ends `deployed` sets the hold, including deploy latest, a hand-apply and a rollback that have no self-deploy decision; the hold only becomes a card if a runner change is known (the decision said so, or an earlier held update did). A newer server update inside the window keeps the older held range and offer, so the one card covers from the older `fromCommit` to the newer commit. During the window, Settings > Server and runner > Updates > **Build and update runners** and answering a runner card both refuse with a message naming the trial length ("The server update is still in its 15-minute trial…", or the host's length); the wording is built from the value, never hard-coded.
- Approving checks that no deploy is running and no request is waiting, then writes the request. If the write fails the decision stays open.
- **Notifications** (from the poller, once per result; the ladder): deployed = note, refused = flag, failed / partial / rolled back = page (phone through ntfy if configured). They link to Settings. The result is also stored on the decision and in the activity feed. `notifications.decision_id` is unique and already used by the "ask" notification, so the result notification is not linked to the decision row.
- **Settings > Server and runner > Updates** shows the last deploy (result, commit, time, message), what is waiting, and the button.
- The poller and the request writer are marked `// leader-only` in the code (`main.ts`, `self-deploy.ts`) for phase 3.
- The poller runs every 30 s, and skips the pass when neither `available.json` nor `status.json` (nor a waiting request) has changed by mtime and size, and it is under a minute since the last pass that ran (BOS-414). The host replaces those files by rename, so their identity moves with their content; the minute-long forced pass covers anything that doesn't show in a file.

## Security: what a merged PR could and could not do

`main` is **branch-protected on GitHub** (the owner confirmed): agents cannot push to it directly, only merge reviewed PRs. That makes "tip of main" an owner-controlled fact. If protection were ever turned off for an agent token, the whole scheme weakens.

**Could**
- Change application code in `apps/*/src` and `packages/`, which then runs as the Boss Man server (uid 1000) with its database access and master key file. That is already true for anything the owner merges and deploys by hand; the new risk is that approving is a quicker click.
- Add a database migration. It runs on the live database at start-up. The backup before every deploy is the safety net; there is no automatic restore.
- Make the app unhealthy: the health check fails, the host script stops, and the owner is paged and receives the webhook.

**Could not** (by design)
- Get a change to `docker-compose.yml`, Dockerfiles, `deploy/`, `scripts/` or CI files deployed without the owner running `scripts/deploy.sh` on the host. This depends on the infra list being complete (open item 1).
- Change `host-deployer.sh` or `host.conf`: root-owned, outside the checkout.
- Make the host deploy a commit that is not the current tip of main, replay an old request, or deploy more than once per 10 minutes per target.
- Get `docker.sock` or any host command execution from the server: it writes one data file in one folder and reads another read-only.
- Reach the deploy key, `host.conf` or the webhook URL: root-only, not mounted.
- Approve its own deploy: owner tier, and the request is written only after the owner's answer.

**Not covered**
- A compromised **server** can leave `inbox/check` every minute; the cost is one `git ls-remote` (and a fetch when main moved) per cron tick.
- A compromised **server** can write `inbox/` freely, so it could replay requests for the current tip, limited by the rate limit and the one-time id check (it can invent new ids). Impact: a redeploy of already-merged code.
- `git hooks` in the checkout would run as root during `git fetch`/`merge`; the script exports `core.hooksPath=/dev/null` for itself and for `deploy.sh`. `.gitattributes` filters and submodules (none are used) are not covered.
- **Build steps in a Dockerfile** run agent-written commands, which is why Dockerfile changes are infra. `pnpm install` lifecycle scripts in app code do run in the build; that is the same trust as running the code. Builds must stay on the default bridge, never `--privileged`.
- The host trusts the checkout's `scripts/` at HEAD. That is safe only because every deploy that moved HEAD was either run by the owner by hand or had no `scripts/` change.

## Compatibility with phase 2 (drain) and phase 3 (blue/green)

- **Drain (phase 2):** built behind `do_update_runner`, without changing the request file (see the next section).
- **Migration step (phase 2):** goes into `deploy.sh`, not the host script.
- **Health:** `/api/health` stays `200 {ok:true}`-compatible; `deploy.sh` waits on the container healthcheck.
- **Blue/green (phase 3):** the replacement of plain `compose up -d` lives in `deploy.sh`'s `rebuild_and_start`; `do_deploy_server` just calls it. One `flock` already serialises server and runner actions, as the phase 3 design requires. The inbox/outbox mounts must be repeated on every colour; the proxy's config belongs on the infra list. `status.json` describes results, not container names.
- **Leader-only:** the poller (`selfDeploy.sync`) and request writer (`selfDeploy.send`) are the two things phase 3 gates on the leader, so two colours never both raise decisions or write requests.
- **Single-slot rollback:** `deploy.sh --rollback` (commit based) is unchanged. Tagging `boss-man-server:previous` before each build, proposed in the first draft, is **not built**; it needs the image named in `docker-compose.yml` (an infra change) and phase 3 makes it moot.

## Phase 2: drain, then swap (runner updates)

Before, a runner update recreated every runner at once and killed the agent runs in flight; crash recovery restarted them (repeated work, extra tokens). Now a runner update waits for the work to finish, across every company on this Boss Man, and swaps each company's runner as soon as that company is idle.

### The flow

```
owner approves "Update runners" (or runs scripts/update-runner.sh)
  1. update-runner.sh builds the new image, runs the canary, tags :current     (nothing running is touched)
  2. it rebuilds and recreates the launcher when one is running               (only the launcher restarts; BOS-335)
  3. it writes inbox/drain.json and returns                                    (the host lock is free again)
  4. the server turns the maintenance hold on: banner, no new runs anywhere
  5. every few seconds the drain step looks at each runner:
       its company has no active run  ->  launcher recreates that runner on :current
       its company is still busy      ->  wait
  6. deadline (30 min) with runs still going -> ONE owner decision:
       Stop the remaining runs and update now / Keep waiting another 30 min / Cancel the update
  7. every runner is on :current (and has reconnected) -> the hold lifts, the owner is notified, the queue runs
```

### Decisions made

1. **The hold is one `settings` row** (`maintenance`: `{reason, since, deadline, minutes, force?, swapped?, failed?}`), so no migration, and it survives a restart. It is separate from a company's Pause: Pause is `companies.paused`, which the drain never reads or writes, so companies the owner paused stay paused afterwards.
2. **What the hold blocks.** The scheduler, in `tickOnce`, launches no new run in any company. Held wakes stay `queued` with the reason `update pending` (the same way a paused company's wakes wait), so nothing is lost and the first pass after the hold lifts starts them. Wakes that were `deferred` with a time (quiet hours, budgets) keep their own reason and time. **Nothing is exempt, chat and owner messages included.** Exempting chat would let a conversation start a run in a company mid-drain and keep that company's runner from swapping; the cost is that a chat message sent during a drain is answered after it. Runs already going are untouched.
3. **Telling everyone.**
   - The web app polls `GET /api/maintenance` every 5 s and shows "Update pending: waiting for N runs in M companies to finish" on every page (and "swapping the runners now" once nothing runs). Settings > Server and runner > Runner update has **Update runners** (start by hand, for a manual `update-runner.sh` run) and **Cancel the update**.
   - A CEO's brief (and the owner's plain brief page) starts with an `UPDATE PENDING` line: finish what is in flight, do not delegate new work. A CEO run that was already going when the hold started has its old brief; the hold is what actually stops its delegations from launching anything.
   - The stall and missed-work sweeps: held wakes are `queued`, so a ticket with one counts as busy (not forgotten), and watchers' "tree stopped" check treats queued wakes as work. The missed-work sweep is skipped while the hold is on, so it cannot pile up wakes or raise "looks stuck" decisions for tickets that simply cannot start.
4. **Drain and the deadline.** The first wait is `BOSSMAN_DRAIN_MINUTES` (default 30). If runs are still going at the deadline the owner gets one `maintenance` decision, owner tier, key `maintenance:<since>:<deadline>`. "Keep waiting" moves the deadline by the same number of minutes and the next deadline asks again; "Stop the remaining runs" sets `force`, so the next step recreates every runner whatever is running (crash recovery restarts those runs once the hold lifts); "Cancel" lifts the hold. Runners already swapped stay on the new image.
5. **Swap per company.** The launcher gained `POST /runners/<slug>/recreate` (one runner, same token and data, new image) and `current: true|false` in `GET /runners` (the container's image id against the id `boss-man-runner:current` points at now). It is still the only container with `docker.sock`, and the server still only calls its HTTP API. Before recreating, the step waits for any scheduling pass in flight (`scheduler.settled()`) and counts the company's runs again, so a launch that started just before the hold cannot be killed.
6. **Release.** When every runner is `current` and each swapped runner is connected, the row is deleted, any open deadline question is withdrawn, the owner gets a note ("Runners updated"), and the scheduler ticks. **If a swapped runner has not reconnected after 5 minutes, or a recreate failed, the owner gets a page naming the companies and the hold lifts anyway.** One broken runner would otherwise keep every company stopped; the rest are healthy and the page says which one is not.
7. **No launcher, no drain.** Without `BOSSMAN_LAUNCHER=1` there is no per-runner recreate, so `update-runner.sh` restarts the compose runners at once (with a warning), as before. A launcher older than the server (no `current` in its list) ends the hold with a page asking for `scripts/deploy.sh --runner`.
8. **Leader-only.** Starting and cancelling the hold, the drain step, the per-company recreate and the release are marked `// leader-only` (`maintenance.ts`, `main.ts`, `app.ts`, `launcher.ts`), for phase 3 to gate. The scheduler's hold check runs on every colour; it only reads the row.

### How the script asks the server, and the host lock

`scripts/update-runner.sh` (default) builds, canaries and tags `:current`, then writes `$BOSSMAN_DEPLOYER/inbox/drain.json` (temp file and rename) and **returns**. The server's drain step (every 5 s, `BOSSMAN_DRAIN_MS`) takes the file, deletes it and starts the hold. The file's existence is the request. Its only field read is `reason`: `"setting change"` (from `--settings`) makes the drain recreate every runner once, whatever its image; anything else is an image update (BOS-594). The host deployer exports `BOSSMAN_DEPLOYER` for its "runner" action and runs it without `--now`, so the host holds its `flock` for the build and canary only, never while runs finish, and server deploys are not blocked. The host's `status.json` for a runner request therefore says "New runner image ready; Boss Man is waiting for runs to finish", and the server's notification for that says the same. **The swap's own result (done, or the problems) comes from the drain as a Boss Man notification**, not from the host script, so the failure webhook does not fire for a swap that goes wrong; the page notification (ntfy if configured) does.

- `--now`: the old behaviour for emergencies on the host: `compose up -d` and `recreate-all`, runs cut off, no drain. It combines with `--rollback`.
- `--settings`: no build. For a change to the runner settings in `.env` (`BOSSMAN_RUNNER_MEMORY`, `BOSSMAN_CHECK_SLOTS`, `BOSSMAN_RUNNER_CPUS`, ...): recreates the launcher so it reads them, then asks for a drain marked "setting change". Runs finish, each runner is recreated as its company goes idle, and the agents told to wrap up are woken afterwards. It refuses without a launcher or a deployer folder (use `--settings --now` there). Owner cards must use this, not `recreate-all`: the card lint refuses a bare recreate (R15, BOS-594).
- `--rollback` retags `:previous` as `:current` and then drains onto it.
- With no deployer folder (a manual run without self-deploy) the script prints where to start the drain: Settings > Server and runner > Runner update > **Update runners**.
- `deploy.sh --runner` calls `update-runner.sh`, so it drains too.
- **Why each runner restarted (BOS-594).** Before Boss Man recreates or restarts a runner (an update drain, a setting-change drain, the owner's Restart or Reconnect) it records why. The runner's hello says whether its last process was stopped from outside (SIGTERM) or ended without being told (crash or out of memory), and when the host booted. The server turns that into one reason (update, setting change, owner restart, host, crash or out of memory, unknown), puts it in the owner's feed (a crash is a flag) and the activity log, and shows the latest in `server_status` under `runner.lastRestart`.

### Not covered

- A forced swap or a crash kills runs; recovery restarts them as it always did.
- `compose` runners (no launcher) cannot drain.
- The hold is server-wide; there is no "drain only company X".
- A CEO already mid-run when the hold starts does not see the brief line.
- The 5-minute reconnect window and the 30-minute drain are defaults, not UNVERIFIED against real runner start-up times on the NAS.

## Phase 3, part 1: one in charge, and a separate migrate step

Built ahead of blue/green; on today's single server nothing changes. Nothing here adds a second server or touches `docker-compose.yml` (that is part 3).

**What changed**

- **Leader lock** (`apps/server/src/leader.ts`). The server holds a Postgres advisory lock (key 5141440001) on its own connection and checks it every 2 s with `select 1`. Any error or lost connection makes it step down at once (background loops stop, runner sockets close with 1013) and it keeps retrying. A server that is not the leader is a **standby**.
- **What only the leader does:** all the background loops (the scheduler tick, sweeps, notification sync, pull request sync, brief upkeep, self-deploy sync, add-on check and the drain step) (`startBackground()`/`stopBackground()` follow leadership), and the runner websocket (`/api/runner/connect` answers 503 with `Retry-After`, so runners retry). Everything marked `// leader-only` is reached only from those loops or from owner writes, which a standby refuses.
- **A standby still serves reads** (`GET`), `/api/health`, `/api/ready`, login and logout, and the static UI. Every other write under `/api/`, all of `/api/runner/*` and `/mcp` answer `503 {"error":"standby"}`.
- **Hand-over by host signals only.** `SIGUSR1` = demote (release the lock, stop background work, drop runner sockets, stay out of the contest). `SIGUSR2` = promote (contest the lock). No HTTP endpoint can change the role. Example: `docker kill --signal=USR1 <container>`.
- **Separate migrate step.** `apps/server/src/migrate.ts` is shipped in the server image as `dist/migrate.js`: `docker run --rm --env DATABASE_URL=... --entrypoint node <server image> dist/migrate.js`. It takes its own advisory lock (key 5141440002), waits at most `BOSSMAN_MIGRATE_LOCK_TIMEOUT_MS` (default 60000) for another migration, runs the Drizzle migrations and exits non-zero on failure.
- **Migrate on start stays the default.** With `BOSSMAN_MIGRATE_ON_START=0` the server skips migrating and instead refuses to start (clear error, exit 1) if the database is **older** than its own migrations. A **newer** database is accepted (expand/contract: the previous release runs on the next one's schema).

**Environment variables**

| Variable | Default | Meaning |
|---|---|---|
| `BOSSMAN_ROLE` | `auto` | `auto` contests the lock at boot. `standby` does not contest until `SIGUSR2`. |
| `BOSSMAN_LEADER_LOCK` | on | `0` is the kill switch: no lock, always the leader, exactly as before. |
| `BOSSMAN_LEADER_MISSES` | `2` | Heartbeats in a row with no reply (3 s each, counted only while the server is not frozen) before the leader steps down. A connection or query error still steps down at once. `1` is the old behaviour. Read at start, so a change needs a server restart. |
| `BOSSMAN_STALL_PROFILE` | on | The server samples its own CPU profile every 10 ms, so each `STALL:` line (and server_status `stalls`) names the functions that ran during the freeze. `0` turns the sampler off; the stall line then has CPU and cgroup figures only. Read at start. |
| `BOSSMAN_SERVER_HEALTH_MS` | `60000` | How often the leader checks its own memory and freezes for the server-health cards (below). |
| `BOSSMAN_MIGRATE_ON_START` | on | `0` skips migrating at start (only checks the database is current). |
| `BOSSMAN_MIGRATE_LOCK_TIMEOUT_MS` | `60000` | How long `migrate.js` waits for another migration. |

PGlite (no `DATABASE_URL`) has no cross-process locks, so it is always the leader, with the same result as the kill switch.

**How to check the role.** `GET /api/health` and `GET /api/ready` return `role`: `"leader"`, `"standby"`, or `"single"` (lock off or PGlite). Settings > Server and runner > Server shows it, with both colours when blue/green is on. Every change is logged as a line starting `LEADER: ***` (`docker logs <server> | grep LEADER`).

**If the only server shows `standby`:** its role should be `leader` within about 2 s of boot. If it stays `standby`, another connection still holds the lock (look in `pg_locks` for `locktype = 'advisory'`; the leader connection sets `idle_session_timeout = 30s`, so Postgres ends a dead holder within about 30 s) or someone sent `SIGUSR1` or booted it with `BOSSMAN_ROLE=standby`. Fix: send `SIGUSR2`; or set `BOSSMAN_LEADER_LOCK=0` and restart to run exactly as before.

**Server-health cards (BOS-640).** Once a minute the leader compares its own memory and freezes with two levels and raises a card when one is passed (`apps/server/src/services/server-health.ts`):

- **Memory, to the CEO:** rss above 60% of the memory the server may use, or more than 1 GiB of growth in each of the last two hours. "The memory the server may use" is the smallest of the container's cgroup limit (v2 `memory.max`, v1 `memory.limit_in_bytes`, when one is set), the total the kernel reports, and a host-reported total when one is wired in. All of them are read inside the container, so nothing is fixed per host. On an LXC without lxcfs the kernel total is the whole Proxmox host's, so the share rule then trips late; set a container memory limit, or rely on the growth rule.
- **Freezes, to the owner:** more than 10 freezes over the stall threshold (1 s) in 10 minutes, whatever the memory figure.

Each card names what to do: approve the open server update card if there is one, otherwise restart the server. There is one card per rule while it is open. A card answered while the problem goes on is not raised again until the rule has been calm for 30 minutes. Each card closes itself (DR-016, `serverCalm`) once its rule has stayed under its level for 30 minutes. The readings belong to the process that leads: after a restart or a change of leader, the 30 minutes count from that process's first reading.

## Phase 3, part 2: blue/green swap (optional)

Opt-in. An install that does not add `deploy/truenas-bluegreen.yml` to `COMPOSE_FILE` runs exactly as before, and the host deployer calls `scripts/deploy.sh` as in phase 1. Install steps: `docs/06-install-truenas.md`, section 9d.

**What is added**

- `deploy/truenas-bluegreen.yml`: a **proxy** (Caddy 2.11.7; the tag exists on Docker Hub, checked 20 Oct 2026) that owns the host ports (UI `BOSSMAN_HOST_PORT`, portal `BOSSMAN_PORTAL_HOST_PORT`) and the network name `server`, so the runners' `ws://server:3100/api/runner/connect` and the launcher's settings are unchanged. Two server services, `server-blue` and `server-green` (images `boss-man-server:blue` and `:green`, both `BOSSMAN_ROLE=auto`, healthcheck on `/api/ready`, `BOSSMAN_MIGRATE_ON_START=0`), and a one-shot `migrate` service. The base `server` service is parked behind a profile. No new service gets `docker.sock`; the launcher is unchanged.
- `deploy/caddy/Caddyfile` (in the repo, static) with two sites, `:3100` (UI, API, runner websocket) and `:3101` (portal), both importing the snippet `active` from `$BOSSMAN_DEPLOYER/proxy/active.caddy`. That file is **host-owned**: root-owned folder outside the checkout, mounted read-only into the proxy (the folder, not the file, because a rename gives the file a new inode). The snippet names the live colour and turns on Caddy's active health check (`/api/ready` for the UI, `/portal.html` for the portal, every 2 s).
- Caddy's admin API listens on `localhost:2019` inside the proxy container only and is not published. The host reloads with `docker compose exec proxy caddy reload`, which talks to it from inside. Tested with a real Caddy 2.11.7 binary: validate, reload, and the colour flip all work; a stream open during the reload is not cut.

**A swap** (`target: server`, only when opted in; the same request, approval, rate limit, one-time id and tip-of-main rules as phase 1; the same `flock`)

```
1. backup (pg_dump, checked)                                        failure: nothing changed
2. fast-forward the checkout to the vetted commit
3. build the idle colour at that commit (BOSSMAN_COMMIT build arg)  } failure in 3-7: the idle colour is
4. migrate (expand-only; the live colour keeps working)             } stopped, the checkout is put back,
5. start the idle colour (it is a standby: the live one holds the   } status failed + webhook, the live
   leader lock)                                                     } colour was never touched
6. wait for /api/ready: role standby, commit = the target
7. smoke test: login-free read (GET /api/setup) straight from it
8. SIGUSR1 the live colour (demote); wait until it reports standby  } failure from here: switch back
9. SIGUSR2 the idle colour (promote); wait until it is leader       }
10. rewrite active.caddy (tmp in the root-only state folder, rename), caddy validate, caddy reload
11. verify through the proxy: /api/ready is leader at the target commit; the portal answers
12. status deployed; the old colour stays up as a standby for 15 minutes (state/soak holds the deadline)
```

The live colour is whatever `active.caddy` names; no second record exists to disagree with it. A server swap does not touch runners. A runner update stays the phase 2 drain (`update-runner.sh`); the shared `flock` keeps the two from overlapping.

**Rollback**

- **During the swap** (step 8 onwards fails): reverse it: SIGUSR1 the new colour, SIGUSR2 the old, restore the include, reload, check through the proxy, stop the new colour, put the checkout back. Status `rolled_back`, webhook.
- **During the 15 minutes**: every cron tick re-checks through the proxy (leader, target commit, portal; it retries for 10 s first). If that fails, the same reversal runs on its own. Status `rolled_back`, webhook. After the deadline a tick stops the old colour and the soak ends. Approving a new deploy during the soak ends it (the old colour's container is about to be rebuilt).
- **"Healthy" is a checklist, not one answer (DR-020 D, BOS-488).** At the swap, on every tick of the window, at the end of the window and at the end of a rollback the deployer checks five items and records each as `pass` or `fail`: (1) **live**: the live colour's container runs, answers `/api/ready` as leader at the target commit and loads the portal, through the proxy; (2) **other**: the other colour is in its planned state, running as a standby during the window, and afterwards stopped *by plan* (exit code 0 and listed in `state/stopped-by-plan`, which the deployer writes whenever it stops a colour on purpose); a crash or a stop it did not do fails; (3) **leader**: exactly one of the two colours leads (not zero, not two); (4) **db**: the database container has the same ID and start time as before the deploy (`state/baseline`, taken before anything is touched) and `pg_postmaster_start_time()` is unchanged; a recreated or restarted database is a failure; (5) **restarts**: neither colour, the database nor the proxy restarted, was recreated or was OOM-killed since the baseline (`RestartCount`, `OOMKilled`). A colour the deploy rebuilds on purpose gets its baseline renewed. A hand-applied database step that is planned drops an empty file `state/planned-db`; the next check renews the database baseline once and removes it.
  The result is in `outbox/health.json` (`stack` = `healthy`/`degraded`, `check_<item>`, `detail_<item>`, `phase`, `commit`, `at`) and the same `stack` and `check_*` fields ride in `status.json`. What a failure does: a failed **live** item (or any item at swap time) switches back as before; a failed other item during the window leaves the live colour alone (switching could make it worse), writes status `partial` and posts the webhook once for that problem (`state/last-health-alert`), and the window still ends at its deadline: the old colour is stopped by plan, the end check records the problem and pages once (a failed item never keeps a second server running for ever). The page names the way to accept the new state: `host-deployer.sh --ack-health` as root records every container as it is now (new baseline) and re-runs the checklist. The database's start time is read with a 15-second limit, so a hung database cannot hold the deployer's lock: no answer is a failed db item. A window that began before this version has no baseline: one is taken at the first tick, with a note.
- **After the 15 minutes**: `host-deployer.sh --rollback`, run by hand as root, does the same hand-over towards the stopped colour (start it from its existing image, smoke test, USR1/USR2, flip, verify, stop the bad colour, back up first, move the checkout to the code that runs). It fails safe the same way. Not yet run on the real NAS; see the wiki page "Database restore and blue/green rollback".
- If the reversal itself fails, status `failed` and the webhook say so: the NAS needs a person.
- A colour that was demoted (SIGUSR1) does not contest the lock until promoted, so during the soak there is no automatic fail-over from a crashed new colour to the old one; the tick's check is what notices it, within a minute.
- Rollback is only safe because the previous release runs on the next one's schema (expand-only migrations, phase 3 part 1 and the migration lint). A release that contracts the schema needs a database restore to go back.

**Why both colours are `auto`, not one `standby`:** a container Docker restarts keeps its environment. A colour created as `standby` that was later promoted would come back after a restart with nobody leading. With `auto` a restarted colour contests the lock and gets it if no one has it. The idle colour is still a standby, because the live one holds the lock; step 6 checks exactly that.

**Infra files stay infra.** `deploy/caddy/Caddyfile`, `deploy/truenas-bluegreen.yml` and compose files match the existing infra rule, so a change to them is refused by the deployer and is applied by hand (docs/06, 9d). `scripts/deploy.sh` refuses to run on an opted-in install (it knows only the single server).

**What is verified**

- `scripts/host-deployer.test.sh` (fake docker, fake world, real git and webhook): opt-in detection (environment and `.env`); the happy path order (backup, build at the commit, migrate, start, probe, smoke, USR1, USR2, validate, reload, verify); the include rewritten whole, mode 644, nothing in the server-writable inbox, no stray file in the proxy folder; a world-writable proxy folder refused; a failed smoke test (no demotion, idle stopped, failure webhook); a failed migration; a stopped proxy; a failed check after the flip (full reversal, `rolled_back`, webhook); an automatic switch-back during the soak; the old colour stopped on a later tick after the deadline; the infra rule still refusing a Caddyfile change.
- CI renders `docker-compose.yml + truenas.yml + truenas-bluegreen.yml`, checks the proxy has the alias `server`, the base `server` is parked, only the launcher has `docker.sock`, the default render is unchanged, and validates the Caddyfile and a generated include with `caddy:2.11.7`.
- Locally with a real Caddy binary: the Caddyfile and the generated include validate in both colours; reload switches upstream; health URIs and upstream names come out as intended.

**Lessons from the first real run (TrueNAS SCALE, Docker Compose v2.32.3, 22 and 23 Oct 2026)**

- **The proxy would not start.** `caddy:2.11.7`'s binary carries the `cap_net_bind_service` file capability. With `cap_drop: [ALL]` that capability is not in the bounding set, so `execve` fails (`exec /usr/bin/caddy: operation not permitted`, exit 255, restart loop). Fix: `cap_add: [NET_BIND_SERVICE]` on the proxy only; `no-new-privileges` and the rest stay. CI's render and the local Caddy binary could not show this; only the real image under the real security options did.
- **The live colour never stepped down.** The server image ran `tsx src/main.ts` through the tsx CLI. The CLI runs the program as a child and relays only SIGINT and SIGTERM (checked in tsx 4.23.15's `dist/cli.mjs`). So SIGUSR1 reached the wrapper, where Node's default opened a debugger on 127.0.0.1:9229 inside the container, and never reached `leader.ts`. The swap then failed safely at step 8 and switched back. Fix: `CMD ["node", "--import", "tsx", "src/main.ts"]`, so node is PID 1. `test/dockerfile.test.ts` pins it. The deployer's tests use a fake Docker, so they could not catch this. A colour built from an older image has to be rebuilt in place once (docs/06, 9d).
- **The order of merges matters.** The deployer offers only the tip of `main`, so one unapplied infra change blocks every app change merged after it. Merge infra PRs on their own and apply them by hand before merging more app PRs.

**Verified on the NAS**
- The cutover commands and the `!override` / `!reset` tags on Docker Compose v2.32.3.
- `caddy validate` and `caddy reload`, and busybox `wget` inside the proxy (the deploy log shows "Valid configuration", and the checks through the proxy pass).
- Two real servers handing over the lock with the real signals.
- The automatic switch-back after a failed hand-over.
- A full swap blue to green with the UI up throughout.
- Runners reconnecting through the proxy by themselves: they retry every 30 s with `ENOTFOUND server` while the proxy is down, then connect.
- **Settings > Server and runner > Server** shows both colours' states, read from each colour's `/api/health` over the compose network (`GET /api/bluegreen`, owner only, shown only when `BOSSMAN_COLOUR` is set).

**Still not verified**
- The old colour being stopped when the soak ends.
- An automatic switch-back during the soak.
- The timing defaults (30 s hand-over wait, 120 s ready wait, 15 minutes) on slower hardware.
- Whether the swap should also check each company's runner reconnected: it doesn't yet. A person can see it in Settings > Server and runner > Runner, "Connected since".

## Open items

1. Is the infra list complete? Anything the stack reads at start-up that lives in the repo and is not in step 6 belongs on it.
2. **To verify on the NAS:** the cron job survives a TrueNAS upgrade (stored in the TrueNAS configuration database, which carries across updates; UNVERIFIED for 25.10). Verified on the NAS in Oct 2026:
   - the bind mount ownership with the TrueNAS override;
   - `python3` and `flock` on root's cron PATH;
   - `git ls-remote` from cron, over https or with the deploy key (whichever `origin` uses);
   - the cron schedule needs every field set to `*`, because the UI's Hourly preset runs once an hour.
3. A webhook that nobody receives is silent. Test it (`docs/06`) after install and after any Home Assistant restore.
4. The first deploy of this phase is by hand: it adds `--commit` to `deploy.sh` and changes `scripts/` and `deploy/`.

## Why a runner update can be refused, and what the status shows (BOS-364)

- Runners are rebuilt from the deployer's checkout, so a runner request is accepted only for the commit the checkout is on (the version the server runs). While a server swap runs, the deployer holds its lock and does not read the request; it is read on a later minute. If the server update was switched back in between (for example by the automatic switch-back during the standby window), the checkout is back on the old commit and the runner request is refused with a plain message. Nothing is broken; offer the runner update again once the server runs the version you want.
- Boss Man shows that refusal as a quiet note ("Runner update not started"), not an alert, and withdraws a runner offer for a commit the server never reached.
- `server_status` `deploy.liveCommit` / `liveSince` come only from a finished **server** deploy (otherwise from the host's deployed commit, then the server's own commit). A refused or failed request never counts as live.
- This is generic to any Docker host; nothing here depends on paths or names. Host-specific notes belong in the install guide for that host.
