# Self-deploy, phase 1: the host deployer

Status: built (phase 1). Phase 0 (`scripts/deploy.sh`, run by hand) is the base. Phase 2 (drain, migration step) and phase 3 (blue/green) come later and are only touched in the compatibility section. Install steps are in `docs/06-install-truenas.md` ("Install the host deployer"). Anything marked **UNVERIFIED** was not checked against a real TrueNAS box or the vendor's current docs.

## What it does

When `main` moves on GitHub, Boss Man shows an owner decision "Deploy Boss Man abc1234 -> def5678?". Approving it makes the NAS update Boss Man itself: backup, build, restart, health check, and a result the owner sees in the UI and in notifications. The thing that does the updating is a root-owned script on the TrueNAS host, so it is not the container it replaces and no container gets `docker.sock`.

```
host script, every minute ─▶ outbox/available.json   "main is ahead of what runs"
      ▲                                │
      │                                ▼
      │                  Boss Man raises an owner decision (or: Settings > Updates > Deploy latest)
      │                                │ owner approves
      │                                ▼
      │                  server writes inbox/request.json (tmp + rename)
      └─ checks it, runs deploy.sh or update-runner.sh ─▶ outbox/status.json
                                       │
            server poller (5 s) ◀──────┘  notification + Settings "last deploy" + webhook on failure
```

## Decisions made

1. **Host script plus a one-minute TrueNAS cron job.** No container, no socket.
2. **It reuses `scripts/deploy.sh`** (backup, build, restart, health) and `scripts/update-runner.sh`, so there is one deploy path. `deploy.sh` gained `--commit SHA` so it deploys exactly the commit that was checked, not whatever main is by then.
3. **GitHub is the source of truth.** The `src` checkout pulls from `git@github.com:Leonfinn/Boss_Man.git` over a read-only deploy key set as `core.sshCommand` (`docs/06`, step 2). The host decides what "the tip of main" is with `git ls-remote origin refs/heads/main` through that same key: no API token, no second credential.
4. **Server deploys and runner updates are separate approvals** until phase 2's drain exists. Updating runners cuts off agent runs in progress.
5. **Infra files are never auto-deployed.** `docker-compose.yml`, `deploy/`, Dockerfiles, `scripts/`, `.github/` and the like only deploy when the owner runs `scripts/deploy.sh` by hand at the NAS.
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

The owner enables it once by hand (it is an infra file): add it to `COMPOSE_FILE` and set `BOSSMAN_DEPLOYER` in `.env`. Without `BOSSMAN_DEPLOYER_DIR` the server's feature is off and the Settings panel is hidden. CI renders the merged file and checks both mounts and that no socket is mounted.

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
6. **Infra paths** (`server` only): `git fetch`, require the commit to be a fast-forward of what is deployed, then refuse if `git diff --name-only HEAD..commit` matches the infra list: `docker-compose*.yml`, `deploy/`, `scripts/`, `.github/`, `.gitea/`, `.dockerignore`, `.npmrc`, `.env*` (top level), and any `Dockerfile*`. Documentation is not on the list.
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
- **Server:** raised by the poller when `available.json` shows `tip` differs from `deployed`, one per tip (`dedupeKey`); an older open one is withdrawn when main moves again, or when the owner hand-deploys. Options `Deploy` / `Not now`. The text shows the commit range, subjects, file count, migrations, and whether runner code changed. If the range touches infra files it is only an alert (`Got it`) saying to run `scripts/deploy.sh` at the NAS. Settings > Updates > **Deploy latest** raises it again for the current tip even if it was put off.
- **Runner:** after a server deploy of a range that changed runner paths succeeds, the poller raises a separate `Update runners` / `Not now` decision for the deployed commit, with the in-flight-runs warning.
- Approving checks that no deploy is running and no request is waiting, then writes the request. If the write fails the decision stays open.
- **Notifications** (from the poller, once per result; the ladder): deployed = note, refused = flag, failed / partial / rolled back = page (phone through ntfy if configured). They link to Settings. The result is also stored on the decision and in the activity feed. `notifications.decision_id` is unique and already used by the "ask" notification, so the result notification is not linked to the decision row.
- **Settings > Updates** shows the last deploy (result, commit, time, message), what is waiting, and the button.
- The poller and the request writer are marked `// leader-only` in the code (`main.ts`, `self-deploy.ts`) for phase 3.

## Security: what a merged PR could and could not do

`main` is **branch-protected on GitHub** (the owner confirmed): agents cannot push to it directly, only merge reviewed PRs. That makes "tip of main" an owner-controlled fact. If protection were ever turned off for an agent token, the whole scheme weakens.

**Could**
- Change application code in `apps/*/src` and `packages/`, which then runs as the Boss Man server (uid 1000) with its database access and master key file. That is already true for anything the owner merges and deploys by hand; the new risk is that approving is a quicker click.
- Add a database migration. It runs on the live database at start-up. The backup before every deploy is the safety net; there is no automatic restore.
- Make the app unhealthy: the health check fails, the host script stops, and the owner is paged and receives the webhook.

**Could not** (by design)
- Get a change to `docker-compose.yml`, Dockerfiles, `deploy/`, `scripts/` or CI files deployed without the owner running `scripts/deploy.sh` at the NAS. This depends on the infra list being complete (open item 1).
- Change `host-deployer.sh` or `host.conf`: root-owned, outside the checkout.
- Make the host deploy a commit that is not the current tip of main, replay an old request, or deploy more than once per 10 minutes per target.
- Get `docker.sock` or any host command execution from the server: it writes one data file in one folder and reads another read-only.
- Reach the deploy key, `host.conf` or the webhook URL: root-only, not mounted.
- Approve its own deploy: owner tier, and the request is written only after the owner's answer.

**Not covered**
- A compromised **server** can write `inbox/` freely, so it could replay requests for the current tip, limited by the rate limit and the one-time id check (it can invent new ids). Impact: a redeploy of already-merged code.
- `git hooks` in the checkout would run as root during `git fetch`/`merge`; the script exports `core.hooksPath=/dev/null` for itself and for `deploy.sh`. `.gitattributes` filters and submodules (none are used) are not covered.
- **Build steps in a Dockerfile** run agent-written commands, which is why Dockerfile changes are infra. `pnpm install` lifecycle scripts in app code do run in the build; that is the same trust as running the code. Builds must stay on the default bridge, never `--privileged`.
- The host trusts the checkout's `scripts/` at HEAD. That is safe only because every deploy that moved HEAD was either run by the owner by hand or had no `scripts/` change.

## Compatibility with phase 2 (drain) and phase 3 (blue/green)

- **Drain (phase 2):** keep the runner action behind `do_update_runner`; phase 2 changes what it calls (per-company drain, then per-runner recreate) without changing the request file. Unknown request fields are ignored, so a later `drain` field needs no migration.
- **Migration step (phase 2):** goes into `deploy.sh`, not the host script.
- **Health:** `/api/health` stays `200 {ok:true}`-compatible; `deploy.sh` waits on the container healthcheck.
- **Blue/green (phase 3):** the replacement of plain `compose up -d` lives in `deploy.sh`'s `rebuild_and_start`; `do_deploy_server` just calls it. One `flock` already serialises server and runner actions, as the phase 3 design requires. The inbox/outbox mounts must be repeated on every colour; the proxy's config belongs on the infra list. `status.json` describes results, not container names.
- **Leader-only:** the poller (`selfDeploy.sync`) and request writer (`selfDeploy.send`) are the two things phase 3 gates on the leader, so two colours never both raise decisions or write requests.
- **Single-slot rollback:** `deploy.sh --rollback` (commit based) is unchanged. Tagging `boss-man-server:previous` before each build, proposed in the first draft, is **not built**; it needs the image named in `docker-compose.yml` (an infra change) and phase 3 makes it moot.

## Open items

1. Is the infra list complete? Anything the stack reads at start-up that lives in the repo and is not in step 6 belongs on it.
2. **To verify on the NAS:** the cron job survives a TrueNAS upgrade (stored in the TrueNAS configuration database, which carries across updates; UNVERIFIED for 25.10); the bind mount ownership with the TrueNAS override; that `python3` and `flock` are on the host's PATH for root's cron (both ship with TrueNAS SCALE, UNVERIFIED); `git ls-remote` over the deploy key works from cron.
3. A webhook that nobody receives is silent. Test it (`docs/06`) after install and after any Home Assistant restore.
4. The first deploy of this phase is by hand: it adds `--commit` to `deploy.sh` and changes `scripts/` and `deploy/`.
