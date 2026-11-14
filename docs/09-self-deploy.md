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
6. **The failure alert is a generic webhook** configured on the host only (a root-owned file), not in Boss Man's database, because it must work when Boss Man is down. The owner points it at any service that takes a JSON POST (ntfy needs a small relay, see `docs/06`).
7. The server can write **one folder** and read **one folder**. It can never run anything on the host, and the host never executes anything from the request.
8. At most **one deploy per target every 10 minutes**; the cron job runs every minute.

## Files on TrueNAS

Base: `/mnt/tank/apps/boss-man/deployer` in the worked example of [docs/06](06-install-truenas.md) (`$D` below). Use your own install folder.

| Path | Owner : mode | Written by | Purpose |
|---|---|---|---|
| `$D/` | root:root 755 | owner | Not writable by the server. |
| `$D/host-deployer.sh` | root:root 750 | owner, by hand | A **copy** of `scripts/host-deployer.sh`. Never a link into the checkout, so a merged PR cannot change what root runs. |
| `$D/host.conf` | root:root 600 | owner, by hand | Optional. Webhook URL and options (below); without the file nothing is posted and the defaults apply. If the file exists, the script refuses to start unless it is private. |
| `$D/inbox/` | 1000:1000 750 | server (uid 1000) | The only place the server writes. Bind-mounted read-write into the server. |
| `$D/inbox/request.json` | 1000:1000 640 | server | One pending request. The host takes it by renaming it out of the folder. |
| `$D/inbox/checked` | 1000:1000 640 | server | The merge commits Boss Man's merge gate checked, newest merges first, one 40-character hash per line (BOS-753). Written beside every server request and refreshed while one waits. The host reads it only when main has moved past the approved commit (step 4). Untrusted like the request: a plain file under 256 KB, and only hash lines are kept. |
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

`target` is `server`, `runner` or `restart`. Anything else, a missing field, a bad format, or a file over 4 KB is refused; unknown extra fields are ignored. Every field is validated against a strict pattern before it is used, and the only action chosen from it is the `target`. `approvedBy` is only for the log.

### Phone login (BOS-1004)

The Notifications page's **Create phone login** and **Reset password** buttons use a second request file, `inbox/phone-login.json`, so they never compete with a deploy. The deployer reads it on every tick (before any deploy request), whatever else is going on.

```json
{ "id": "uuid", "action": "create", "user": "phone-read", "topic": "your-topic", "pubkey": "base64 of an RSA public key (DER, SPKI)" }
```

What the deployer does, and nothing else:

1. Rejects the file unless it is a plain file under 2 KB with exactly those five fields. `action` is `create` or `reset`; `user` matches `^[a-z][a-z0-9_-]{2,31}$` and is not `admin`, `bossman-publish`, `bossman`, `root` or `everyone`; `topic` matches `^[A-Za-z0-9_-]{1,64}$`; `pubkey` must parse as an RSA key of 2048 bits or more. A used id is never run twice, and there is one phone login per 30 seconds.
2. Finds the ntfy container by its Compose service label (`com.docker.compose.service=ntfy`), never by name, and refuses if there is not exactly one running.
3. Makes a 24-character password from `/dev/urandom`, seals it to the public key (RSA-OAEP, SHA-256) **before** changing anything, then runs only these fixed commands in the container: `ntfy user list`, `ntfy user add --role=user <user>` (create) or `ntfy user change-pass <user>` (reset), and `ntfy access <user> <topic> read-only`. The password reaches ntfy as the `NTFY_PASSWORD` environment variable, never on a command line.
4. Writes `outbox/phone-login.json`: the id, the result (`created`, `reset`, `exists`, `missing`, `rejected`, `unavailable` or `failed`), a message, and the **sealed** password. `state/phone-login.log` gets one line per request (time, id, result, user): no password.

`create` for a user that already exists answers `exists` and changes nothing (the page then offers **Reset password**). `reset` for a user that does not exist answers `missing`. The read-only access is re-applied on every run, so running it again repairs a drifted rule. Remove the user by hand with `docker exec <ntfy container> ntfy user del phone-read`.

The server makes a new RSA key pair for each click and keeps the private half in memory only (10 minutes, one use). Nothing but the sealed password is ever on disk, so a backup, the outbox or a log never holds it. The browser gets it once, in a response marked `no-store`. If the server restarts before the owner picks it up, press the button again: that makes a new password. The host needs `openssl` (it reports `phoneLogin.openssl` in `host.json`; the page says so when it is missing) and needs no other tool.

### Restart (BOS-647)

Settings → Server and runner → Updates → **Restart the server** (owner session only; `POST /api/self-deploy/restart`, no MCP tool) writes a request with `target: "restart"`, a fresh random `id` (there is no decision card: the owner's click is the approval) and `commit` = the `deployed` commit from `available.json`. The server refuses it when self-deploy is off, the host has not reported, a deploy is running or a request is already waiting. It is for the server-health cards (memory high, freezes piling up) when no update is waiting.

The host checks, after the usual format and replay checks:

- `commit` must equal the checked-out HEAD, the code that runs. Otherwise it is refused ("the version running changed since you asked"). A restart never fetches, merges or moves the checkout, so it can't bring new code in, and the infra-path rule does not apply to it.
- It shares the server's rate limit (`state/last-server`): no restart within 10 minutes of an update or another restart, and no update within 10 minutes of a restart.
- Blue/green: refused while `state/soak` exists (an update or restart is still in its trial window), because a restart rebuilds the stopped colour that the window switches back to.

What it runs:

- **Blue/green:** the same swap as an update, at the same commit: backup, build the idle colour (mostly cached), migrate (nothing to do), start it as a standby, smoke test, hand over, flip the proxy, the whole-stack check, then the trial window with the old copy as a standby and the automatic switch-back. Pages keep working. `state/previous` is **removed** on success: the colour just rebuilt held the release before, so no stopped colour holds it any more, and `host-deployer.sh --rollback` then refuses with its usual message instead of "going back" to the code that runs now. **Trade-off:** after a restart the one-step hand rollback to the release before is gone (the confirm box says so). `state/hold` is kept. A switch-back in the window is reported with `target: "restart"`.
- **Single server:** `scripts/deploy.sh --yes --no-runner --force --commit <HEAD>`: backup, rebuild what is checked out, **recreate** the server container (`--force` with nothing new adds `up -d --force-recreate server`; a plain `up -d` leaves a container with an unchanged image running), health check. The launcher is left alone. About a minute of downtime. `deploy-status.previous-commit` is left as it was, so `deploy.sh --rollback` still goes back to the release before.

`status.json` carries `target: "restart"`; Boss Man notifies "Boss Man restarted (abc12345)", "Restart refused", "Restart failed" or "Restart switched back" at the usual levels. A restart does not start the runner update trial and does not change the last server update record. An older host script refuses `target: restart` as a bad format (the owner sees "Restart refused"), so nothing breaks while the new deployer is not yet copied into place.

## What the host script checks (in order; a failure writes `status.json` with the reason and posts the webhook)

1. `flock`: if a run is going, exit quietly and try next minute.
2. Take the request by renaming it into `state/` (a symlink is moved as a symlink, never followed), then require a plain file under 4 KB that matches the schema.
3. **Replay:** the `id` must not already be in `history.jsonl`.
4. **On main, newest checked** (target `server`, BOS-753): the tip is read with `git ls-remote origin refs/heads/main`. If `commit` is the tip, it is used as before. If main has moved on since the offer was written (a merge between the card and the press, or before this tick), the approval is not refused, because it means "deploy the newest checked version". After `git fetch`, `commit` must still be on main (an ancestor of the tip); a side branch or a rewritten main is refused. The host then walks main's first-parent history from the tip back to `commit` (never into what already runs). It takes the newest commit that is listed in `inbox/checked` and whose range from what runs touches no infra path. If none qualifies, `commit` itself goes out: it is still on main and it is what the owner approved. With no `inbox/checked` (an older server) that is always the case. The status message says what was approved, what goes out and why. `status.json` then also carries `requested_commit` and `runner_changed` (whether the range that really goes out changes runner paths), so the runner offer follows what was deployed, not the card. For target `runner` the commit must equal the commit that is deployed (runners are built from what is checked out), not the tip.
5. **Rate limit:** at most one deploy per target per `RATE_LIMIT_SECONDS` (600), measured from when the last one started, successful or not.
6. **Infra paths** (`server` only): `git fetch`, require the commit to be a fast-forward of what is deployed, then refuse if `git diff --name-only HEAD..commit` matches the infra list: `docker-compose*.yml`, `deploy/` (except `deploy/penpot.yml`, the separate Penpot add-on), the four scripts that deploy or run Boss Man (`scripts/deploy.sh`, `scripts/rebuild-live.sh`, `scripts/update-runner.sh`, `scripts/host-deployer.sh`), `.dockerignore`, `.npmrc`, `.env*` (top level), and any `Dockerfile*`. Documentation, CI files (`.github/`, `.gitea/`) and every other script are not on the list: they never run on the host, or only at build and check time (`scripts/make-app-icons.mjs`, `check-*`, `test-*`, `lint-migrations.mjs`, `ci-launcher.sh`, the backup and restore-test scripts). Migrations are not on it either: the app applies them on every deploy. The list is the `INFRA` variable in `scripts/host-deployer.sh`; the deployer's refusal and the hand-apply card (`infraPaths` in `available.json`) both use it, so they cannot disagree. When you add a script that changes how Boss Man runs or deploys, add it to `INFRA`; a build-only script needs nothing.

   **The hand-apply card (BOS-269).** It is built from what the host reports in `available.json`: `srcDir` and `deployerDir` (the real folders, never guessed), `bluegreen` and `liveColour`. The card picks `scripts/rebuild-live.sh` on blue/green and `scripts/deploy.sh --commit <sha>` on a single server from `bluegreen`. If a folder or the layout is not reported (an older host script) the card says so in plain words and shows no command. The "Rebuild the runners" step is on the card only when `runnerChanged` is true, the same flag that drives the "Runner update afterwards" line. Every command sits in its own fenced block under the sentence that explains it (`apps/server/src/services/steps.ts`): nothing but the text to paste, no `$`, no trailing punctuation, no placeholder to edit. The web app shows each block with a Copy button. Any owner step card can use `step()` from that file.
7. Run the fixed action under git settings that disable hooks: server = `scripts/deploy.sh --yes --no-runner --commit <sha>`; runner = `scripts/update-runner.sh`; restart = `scripts/deploy.sh --yes --no-runner --force --commit <HEAD>` (single server) or the blue/green swap at HEAD (see Restart above). Each goes through one function, so a later phase changes one place.
8. Write `status.json` and append it to `history.jsonl`; post the webhook if it was a failure (or on success when `WEBHOOK_ON_SUCCESS=1`).

`--dry-run` runs every check and prints what it would do without taking the request, running anything or writing anything.

## status.json and available.json

```json
{ "id": "decision uuid", "target": "server", "result": "deployed", "message": "Deployed abc12345 to def67890.", "from_commit": "…", "to_commit": "…", "started": "…", "ended": "…", "at": "…", "backup": "/mnt/…/bossman-2026-10-20-1200.sql.gz" }
```

`result` is `running`, `deployed`, `nothing_new`, `rejected`, `failed`, `partial` (server deployed, runner update failed) or `rolled_back`. While Boss Man restarts the file still holds `running`; when the new server starts its poller reads the final state and notifies. `available.json` carries `deployed`, `tip`, up to 30 commit subjects, up to 300 changed paths, `infraPaths`, and `runnerChanged` (same rule as `needs_runner` in `deploy.sh`; a test keeps the two copies equal). It lets the server show a range and changed areas without a GitHub token and without a git checkout of its own.

### Which services an update changes, and the database/proxy card (BOS-487, DR-020 B and C)

A server update rolls only the server copies. It never starts, stops or recreates the database or the proxy (`--no-deps` on every compose call; a test in `scripts/host-deployer.test.sh` scans the three deploy scripts for it). Boss Man therefore works out for itself whether those two changed, instead of asking the owner to judge it:

- **The host compares settings, not file paths.** When main is ahead, `host-deployer.sh` unpacks the live commit and the new one into one fixed folder under `state/` (the same path both times, so relative mounts render the same), copies in the checkout's `.env`, and runs `docker compose --project-name <the live stack's project> config --hash '*'` with the deployer's own `COMPOSE_FILE` and a pinned `BOSSMAN_COMMIT`. A Compose without `--hash` gets the same answer from a checksum of each service's block of `docker compose config`. It needs nothing beyond Docker, `git`, `tar` and coreutils. The compose project and files come from the deployer's own settings; nothing is host-specific.
- **`available.json` gains** `changedServices` (names whose settings differ, including added and removed services), `servicesChecked` (false when it could not render: logged, never blocks an update), `pendingServices` (db/proxy still running with older settings than the live checkout asks for), `dbStartedAt` and `dbContainerId`. All are optional for the server, so an older host script just gets no mention of the database. `SERVICE_COMPARE=0` in `host.conf` turns the compare off (the card then says it could not compare).
- **Pending** means: the live checkout's settings for the service differ from what it last ran with, and its container has not been recreated since. The host keeps `state/applied-services` (service, settings hash, container id at the last apply); a recreate gives a new container id and clears it, a restart or reboot keeps the id and does not. The first look records the present state as applied.
- **The hand-apply card** says "This update changes the database's settings" (or the proxy's) when `changedServices` lists it, and says nothing about them otherwise. If the host could not compare and a compose file changed, it says so in one line.
- **The separate card** ("`self-deploy:services:<service>:<commit>`", owner tier) is raised by the poller when a service is pending, the last server result is `deployed` for the live commit, the standby window is over, and the host is quiet (no agent run in flight and no merge landing). If it is not quiet, nothing is raised and the next pass tries again. It tells the owner Boss Man is unreachable for a few seconds, takes a database backup first (`pg_dump | gzip`, `gzip -t`, `ls -l`), gives the one restart command (`docker compose up -d --no-deps db` or `proxy`) with the recorded host name and install folder, then two checks (the service's uptime, and the live server's `/api/ready`). It clears itself when the host reports the service no longer pending.
- **Not built:** DR-008's memory-headroom check. "Quiet" here is the part that exists today.

## Failure webhook

`host.conf`, an optional root-owned file (shell `KEY=value` lines; skip it if you want no webhook):

```sh
WEBHOOK_URL='https://PUT-YOUR-WEBHOOK-ADDRESS-HERE'
WEBHOOK_ON_SUCCESS=0   # 1 = also post when a deploy succeeds
```

On a failure the script POSTs `Content-Type: application/json`:

```json
{ "result": "failed", "message": "…", "from_commit": "…", "to_commit": "…", "at": "2026-10-20T12:03:00Z" }
```

Failure means `failed`, `partial`, `rolled_back` or `rejected`. A webhook that cannot be reached is logged and ignored. The exact curl test is in `docs/06`.

## Decisions in Boss Man

- A decision of kind `approval` with context type `self_deploy` (no migration: no new enum value), tier `owner`, so only the owner's session can answer it; the CEO tool only answers `ceo`-tier decisions. Decisions belong to a company, so it is raised under the oldest one.
- **Server:** raised by the poller when `available.json` shows `tip` differs from `deployed`, one per tip (`dedupeKey`); an older open one is withdrawn when main moves again, or when the owner hand-deploys. `available.json` lags `main`: the host rewrites it at most every 5 minutes and only in a minute with no request waiting. So the poller does not offer a commit the latest `status.json` already settled (refused, deployed or nothing new) until `checkedAt` is later than that status. After a deploy past the approved commit, or an off-main refusal, the host also deletes `available.json`, so the next minute writes a fresh one. Since BOS-753 a card approved after main moved on deploys the newest checked commit (step 4) instead of being refused, so a stale card is never a dead press. The card says so in one line. The migrations count in the question counts `apps/server/drizzle/*.sql` only, not Drizzle's `meta/` files. Options `Deploy` / `Not now`. The text shows the commit range, subjects, file count, migrations, and whether runner code changed. If the range touches infra files it is only an alert (`Got it`) saying to run `scripts/deploy.sh` on the host. Settings > Server and runner > Updates > **Deploy latest** raises it again for the current tip even if it was put off.
- **Runner:** after a server deploy of a range that changed runner paths succeeds, the poller raises a separate `Update runners` / `Not now` decision for the deployed commit, whose text explains the drain (phase 2). **It waits for the server update trial first (BOS-368).** A blue/green server update reports `deployed` when it switches in, but the host can still switch it back during its standby window (`SOAK_SECONDS` on the host, default 900). The host writes the window it really uses into `status.json` as `soak_seconds` (0 when the install is not blue/green), and the server takes the length from there, never from its own environment. If it is missing (an older host), the server uses the `soakSeconds` the host publishes in `available.json` (BOS-384), and failing that 900 (BOS-401). So the poller holds the runner offer in the `self_deploy_runner_due` setting until the trial is over. The trial (BOS-953) is over as soon as **either** the host's window from the deploy's own `ended` time has passed, **or** the deployer reports the standby colour stopped (the live colour is up and the other colour is down in the same `/api/bluegreen` probe Settings shows), whichever comes first; the 120-second margin after the window was removed. It is worked out from the deploy's own time and the colour rows, never from a later deployer poll or a page reload, so a refused deploy that overwrote `status.json` cannot keep an older trial open. While the trial really runs, Settings shows when it ends ("Runners can be updated from 15:33, in about 6 minutes") and refreshes by itself at that time. The offer is raised once the trial is over if `available.json` still reports the deploy's commit running; a `rolled_back` or `failed` server result clears the held offer and withdraws every open runner card, whichever way round the host names the two commits. Every server update that ends `deployed` sets the hold, including deploy latest, a hand-apply and a rollback that has no self-deploy decision; the hold only becomes a card if a runner change is known (the decision said so, or an earlier held update did). A newer server update inside the window keeps the older held range and offer, so the one card covers from the older `fromCommit` to the newer commit. During the trial, Settings > Server and runner > Updates > **Build and update runners** and answering a runner card both refuse with a plain message naming the time ("Runners can be updated from 15:33, in about 6 minutes"), and the button press is remembered so the offer is raised by itself then; the wording is built from the values, never hard-coded.

The same panel counts a rate-limit refusal from the host ("Rejected: only one server deploy every 10 minutes. Try again in N minute(s).") from when it was refused: the wait ends N minutes after the status's `ended`, the line counts down, and once the wait is over it says "You can deploy now." A later deploy result replaces the line.
- Approving checks that no deploy is running and no request is waiting, then writes the request. If the write fails the decision stays open.
- **Notifications** (from the poller, once per result; the ladder): deployed = note, refused = flag, failed / partial / rolled back = page (phone through ntfy if configured). They link to Settings. The result is also stored on the decision and in the activity feed. `notifications.decision_id` is unique and already used by the "ask" notification, so the result notification is not linked to the decision row.
- **Settings > Server and runner > Updates** shows the last deploy (result, commit, time, message), what is waiting, and the button. When there is no offer to show, it says when the host deployer last reported: the newest of `host.json`'s `writtenAt` (rewritten every tick), `available.json`'s `checkedAt` and the last status (BOS-753). It says "has not reported yet … check its cron job" only when it never reported, or nothing came for 10 minutes while no deploy is running. A deploy holds the deployer's lock, so its ticks stop until the deploy ends. A missing `available.json` alone is normal after a deploy. **Deploy latest** and **Build and update runners** then ask the host to look at main again rather than blaming cron.
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
- Make the host deploy a commit that is not on main, or one older than the owner approved, or (in place of the approved one) a newer one the server does not list as checked. It also can't replay an old request, or deploy more than once per 10 minutes per target.
- Get `docker.sock` or any host command execution from the server: it writes two data files in one folder and reads another read-only. The one command path the deployer offers it is the phone login (see "Phone login"): four fixed `ntfy` commands, with a validated topic, a user name the deployer pins to `phone-read` (it refuses any other, so an existing admin login can never be reset through it), and a read-only access rule. A compromised server can ask for a new password for `phone-read` (which locks the phone out until the owner resets it again), and can read that password because it holds the key. It cannot make or reset any other user, grant write access, or run any other command.
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
   - The web app polls `GET /api/maintenance` every 5 s and shows "Update pending: waiting for N runs in M companies to finish" on every page (and "swapping the runners now" once nothing runs). Settings > Server and runner > Updates > Runner update has **Update runners** (start by hand, for a manual `update-runner.sh` run) and **Cancel the update**.
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
- `--settings`: no build. For a change to the runner settings in `.env` (`BOSSMAN_RUNNER_CPUS`, ...; not the check slots or runner memory, which follow "Checks at once" in Settings and need no host step): recreates the launcher so it reads them, then asks for a drain marked "setting change". Runs finish, each runner is recreated as its company goes idle, and the agents told to wrap up are woken afterwards. It refuses without a launcher or a deployer folder (use `--settings --now` there). Owner cards must use this, not `recreate-all`: the card lint refuses a bare recreate (R15, BOS-594).
- `--rollback` retags `:previous` as `:current` and then drains onto it.
- With no deployer folder (a manual run without self-deploy) the script prints where to start the drain: Settings > Server and runner > Updates > Runner update > **Update runners**.
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
- **Merges in flight when a server takes charge (BOS-1371).** An approved merge whose check job is still queued or running on the runner keeps waiting on that job and lands with that job's own commit and tree; nothing is prepared or queued again. A merge with no live job restarts once. At most `BOSSMAN_RESUME_MERGES_MAX` (default 4) merges restart from scratch at the same time; the rest wait and start as slots free. The 30-minute missed-merge sweep leaves those held-back merges alone.
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
- **"Healthy" is a checklist, not one answer (DR-020 D, BOS-488).** At the swap, on every tick of the window, at the end of the window and at the end of a rollback the deployer checks five items and records each as `pass` or `fail`: (1) **live**: the live colour's container runs, answers `/api/ready` as leader at the target commit and loads the portal, through the proxy; (2) **other**: the other colour is in its planned state, running as a standby during the window, and afterwards stopped *by plan* (listed in `state/stopped-by-plan`, which the deployer writes whenever it stops a colour on purpose, not OOM-killed, and exit code 0, 143 or 137); a crash or a stop it did not do fails. A planned stop gives the server `BG_STOP_SECONDS` (default 60) to shut down (`compose stop -t`; the colours also carry `stop_grace_period: 60s`) and logs how long it took; one that still needed SIGKILL (exit 137) passes, with "needed SIGKILL after Ns" in the detail (BOS-794: Docker's default 10 s used to kill a draining server and the stack showed degraded for nothing); (3) **leader**: exactly one of the two colours leads (not zero, not two); (4) **db**: the database container has the same ID and start time as before the deploy (`state/baseline`, taken before anything is touched) and `pg_postmaster_start_time()` is unchanged; a recreated or restarted database is a failure; (5) **restarts**: neither colour, the database nor the proxy restarted, was recreated or was OOM-killed since the baseline (`RestartCount`, `OOMKilled`). A colour the deploy rebuilds on purpose gets its baseline renewed. A hand-applied database step that is planned drops an empty file `state/planned-db`; the next check renews the database baseline once and removes it.
  The result is in `outbox/health.json` (`stack` = `healthy`/`degraded`, `check_<item>`, `detail_<item>`, `phase`, `commit`, `at`) and the same `stack` and `check_*` fields ride in `status.json`. What a failure does: a failed **live** item (or any item at swap time) switches back as before; a failed other item during the window leaves the live colour alone (switching could make it worse), writes status `partial` and posts the webhook once for that problem (`state/last-health-alert`), and the window still ends at its deadline: the old colour is stopped by plan, the end check records the problem and pages once (a failed item never keeps a second server running for ever). The page names the way to accept the new state: `host-deployer.sh --ack-health` as root records every container as it is now (new baseline) and re-runs the checklist; when it passes and `status.json` still holds that `partial` page, it replaces it with `nothing_new` ("Health accepted…", same commit), so the server stops showing degraded. It writes `nothing_new`, not `deployed`, because `deployed` would start a new standby window and runner hold on the server. The database's start time is read with a 15-second limit, so a hung database cannot hold the deployer's lock: no answer is a failed db item. A window that began before this version has no baseline: one is taken at the first tick, with a note.
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

## Server updates wait for a quiet machine (BOS-420, DR-008 Q3)

On 3 Nov 12:47 an approved update started on a host that was already full: it built an image, ran a second server beside the live one, ran out of memory and was switched back. Since BOS-420 an approved **server** update waits for a quiet machine before Boss Man sends it. Runner updates are unchanged (they have their own drain, phase 2).

### Quiet means

- the host deployer reported in the last 3 minutes, and its `outbox/headroom.json` says `availableMb ≥ needMb`;
- no merge check is running (the in-memory merge gate and the server-owned check queue both count);
- at most `DEPLOY_QUIET_RUNS` runs are going (server environment, default 3).

A quiet machine never waits: the request is written at once, as before. A host with an older deployer (no `headroom.json`) skips only the memory test. A report older than 3 minutes counts as **not quiet** ("the machine hasn't reported for N min"): the deployer's cron job has stopped, or the host is too loaded to tick.

### While it waits: the soft hold

The wait is one `settings` row, `deploy_wait` (no migration; not the maintenance hold, which is a full stop). While the row exists:

- the scheduler starts at most `DEPLOY_QUIET_RUNS` runs at once (urgent wakes first); runs already going finish normally;
- no new merge check starts on either path; checks already running finish. The merge queue screen shows "waiting for the server update";
- Settings → Server and runner → Updates shows what it waits for, with **Cancel the update** (before the host has taken it) or **Lift the hold now** (once it is live).

Phases: **waiting** (not sent) → **sent** (in the inbox or running) → **window** (deployed; until the standby window ends; a single-server host has none and the hold lifts on `deployed`) → **handover** (only when a runner update card is open: the hold stays until the runner drain's full hold starts, the card is put off, or 30 minutes pass). A switch-back, failure or refusal ends it.

### The owner's card

If it is still not quiet 30 minutes after approval (or the host holds a sent request for memory for 30 minutes), the owner gets one card: **Keep waiting another 30 min**, **Update now anyway** (sent with `"quiet":"override"`, which also skips the host's floor), or **Cancel the update**. Nothing ever sends by itself without room.

### Restarts, main moving, stale reports

- A restart or leader change keeps the wait: the row is in the database, the deadline is an absolute time and the card's dedupe key names the deadline, so no second card.
- If main moves on while it waits, the approval lapses (the host deploys only the tip, BOS-124); the owner is told and approves the new offer.
- Safety cap: a soft hold older than 3 hours, in any phase, lifts itself and pages the owner.
- Last resort, if the hold ever sticks: delete the `deploy_wait` row from `settings`. Nothing else holds state.

### The host's memory floor (`scripts/host-deployer.sh`)

Every tick the deployer writes `outbox/headroom.json`: `totalMb`, `availableMb`, `swapTotalMb`, `swapUsedMb`, `needMb` and `needFrom`, plus `holding` while it holds a request and `lastUpdate` (the lowest free memory and swap peak of the last update). Every field is optional.

- **Free memory** is `MemAvailable` from `/proc/meminfo`. When the cgroup has a memory limit that `/proc` doesn't show (cgroup v2 `memory.max`, or v1 `memory.limit_in_bytes`; for example a Proxmox LXC without lxcfs), it uses the smaller of that and the limit minus the working set.
- **Need** is `DEPLOY_MIN_FREE_MB` from `host.conf` when set; otherwise `DEPLOY_BUILD_MEMORY_MB` (default 3072) + 1024, plus on blue/green room for a second, freshly started server: `DEPLOY_NEW_SERVER_MB` (default 4096), or `BOSSMAN_SERVER_MEMORY` when that cap is smaller. It is never what the live server uses now: a leaking live server (17.5 GB on 7 Nov) would otherwise hold back the very update that replaces it. On blue/green, `headroom.json` also carries `newServerMb` (that room) and `liveServerMb` (the live colour's use from `docker stats`).
- **When the live server is the shortage:** if memory is short but the live server's use above a fresh one's would cover it, the wait's reason and the 30-minute card say so (waiting won't free it; the update replaces it), and the card recommends **Update now anyway** (for a hand-applied update: stop waiting and apply it). It still never sends by itself.
- **Floor:** a request that arrives while `availableMb < needMb` stays in `inbox/`, the hold is logged once, and it is tried again next minute. A request with `"quiet":"override"` is taken anyway. A host that can't read its memory never holds.
- **Measuring:** it samples memory and swap at each swap step and through the standby window, and logs one line after the window: the lowest free memory, where, and the swap peak. Use it to set `DEPLOY_BUILD_MEMORY_MB` from real numbers.

To check the numbers on a host, compare `cat outbox/headroom.json` with `free -m`. In a Proxmox LXC, also compare with the container's memory limit in the Proxmox UI: if `free -m` shows the whole host's memory, lxcfs is off and the deployer uses the cgroup limit instead.

### Hand-applied (infra) updates

The owner's to-do for a hand-applied server update starts with **Quiet the machine first**. Pressing it starts the same wait with origin "hand": the same soft hold and quiet test, but nothing is sent. The to-do shows how quiet the machine is and says **Ready** when it is; the owner gets a "Ready" note too. The hold then follows the hand-applied update through its standby window as above.

### Mixed versions and rollback

- New server, old deployer: memory isn't tested; runs and checks still gate.
- Old server, new deployer: the floor still holds a request until memory is free.
- Rollback: revert the merge through the normal deploy. Old code ignores a leftover `deploy_wait` row; an unsent approval is lost and is approved again. For the deployer, copy the previous `scripts/host-deployer.sh` back (the same hand-apply step).

## Open items

1. Is the infra list complete? Anything the stack reads at start-up that lives in the repo and is not in step 6 belongs on it.
2. **To verify on the NAS:** the cron job survives a TrueNAS upgrade (stored in the TrueNAS configuration database, which carries across updates; UNVERIFIED for 25.10). Verified on the NAS in Oct 2026:
   - the bind mount ownership with the TrueNAS override;
   - `python3` and `flock` on root's cron PATH;
   - `git ls-remote` from cron, over https or with the deploy key (whichever `origin` uses);
   - the cron schedule needs every field set to `*`, because the UI's Hourly preset runs once an hour.
3. A webhook that nobody receives is silent. Test it (`docs/06`) after install and after any restore of the service it points at.
4. The first deploy of this phase is by hand: it adds `--commit` to `deploy.sh` and changes `scripts/` and `deploy/`.

## Why a runner update can be refused, and what the status shows (BOS-364)

- Runners are rebuilt from the deployer's checkout, so a runner request is accepted only for the commit the checkout is on (the version the server runs). While a server swap runs, the deployer holds its lock and does not read the request; it is read on a later minute. If the server update was switched back in between (for example by the automatic switch-back during the standby window), the checkout is back on the old commit and the runner request is refused with a plain message. Nothing is broken; offer the runner update again once the server runs the version you want.
- Boss Man shows that refusal as a quiet note ("Runner update not started"), not an alert, and withdraws a runner offer for a commit the server never reached.
- **One runner card, only when it can be used (BOS-1010).** Every path that raises the runner card (the trial end, the BOS-947 replacement, the Settings button and a retry) goes through one function. It raises the card only when it can be acted on now: no server deploy approved or waiting for the host, running, in its trial, or in the host's "try again in N minutes" wait; until then it is held and raised by itself on the next pass once those clear. Raising a card withdraws every earlier open runner card in the same step, with the plain audit reason "Replaced by a newer runner update for <version>", and a pass clears any leftover duplicate already open when this shipped. When a server update is approved or starts while a runner card is open, that card is closed at once with a plain reason and a fresh one for the new live version follows after its trial. A press while it can't run (a race) gets the same plain reason and time as the panel, never a silent refusal. The runner card is routine: it is shown in the feed and the browser and is never pushed to the phone. (The owner's own Settings-button card is not folded away by another card.) All of this reads the host's own files, so it works on any Docker host, blue/green or single-colour, with no paths or names.
- `server_status` `deploy.liveCommit` / `liveSince` come only from a finished **server** deploy (otherwise from the host's deployed commit, then the server's own commit). A refused or failed request never counts as live.
- This is generic to any Docker host; nothing here depends on paths or names. Host-specific notes belong in the install guide for that host.
