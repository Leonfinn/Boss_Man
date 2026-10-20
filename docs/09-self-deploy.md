# Self-deploy, phase 1: the host deployer (design, not built)

Status: spec. Phase 0 (`scripts/deploy.sh`, run by hand) is built. This document is phase 1 of the plan the owner approved; phase 2 (drain, migration step) and phase 3 (blue/green) come later and are only touched in the compatibility section. Anything marked **UNVERIFIED** was not checked against a real TrueNAS box.

## What it does

After the owner approves a "Deploy" decision in Boss Man's Decisions queue, the NAS updates Boss Man itself: backup, build, restart, health check, and a result the owner sees in the UI. The thing that does the updating is a root-owned script on the TrueNAS host, so it is not the container it replaces and no container gets `docker.sock`.

```
Owner approves decision ─▶ server writes inbox/request.json ─▶ host timer (every minute)
        ▲                                                         │ checks, then runs deploy.sh
        └── UI reads outbox/status.json  ◀────────────────────────┘ writes status.json
```

## Decisions made

1. The deployer is a **host script plus a one-minute timer**, as recommended in the research note (option F/4). No container, no socket.
2. It **reuses `scripts/deploy.sh`** for the actual backup, build, restart and health work, so there is one deploy path to keep correct. The host script adds the trust checks around it.
3. The server can write **one folder** and read **one folder**. It can never run anything on the host.
4. Only code that passed the host's own checks is deployed. The server's word is never enough.

## Files and permissions on TrueNAS

Base: `/mnt/NVME_Apps/Container_files/boss-man/deployer` (called `$D` below). All paths below are **proposed**.

| Path | Owner : mode | Who writes it | Purpose |
|---|---|---|---|
| `$D/` | root:root 755 | root | Folder, not writable by the server. |
| `$D/deploy-host.sh` | root:root 750 | owner, by hand | The host script. A **copy** of `scripts/deploy-host.sh` that the owner installs. Never read from the git checkout, so a merged PR cannot change what root runs. |
| `$D/deploy.sh` | root:root 750 | owner, by hand | The pinned copy of `scripts/deploy.sh` that `deploy-host.sh` runs (see "Infra paths" for why). |
| `$D/inbox/` | 1000:1000 750 | server (uid 1000) | The only place the server writes. Bind-mounted read-write into the server container. |
| `$D/inbox/request.json` | 1000:1000 640 | server | One pending request. The host deletes it once it has read it. |
| `$D/outbox/` | root:root 755 | root | Bind-mounted **read-only** into the server. |
| `$D/outbox/status.json` | root:root 644 | host script | What the UI shows. Written by temp file and rename. |
| `$D/outbox/history.jsonl` | root:root 644 | host script | One line per deploy, for the UI list. |
| `$D/state/last-deploy` | root:root 600 | host script | Time of the last deploy, for the rate limit. |
| `$D/state/infra-approval` | root:root 600 | owner, by hand | One-shot token that allows an infra change (below). Deleted after use. |
| `$D/gitea.token` | root:root 600 | owner, by hand | Read-only Gitea token the host uses to ask "what is the tip of main?". |
| `$D/lock` | root:root 600 | host script | `flock` file so two runs cannot overlap. |

Phase 0's `deploy-status.json`, backups and `…previous-commit` stay in the existing `boss-man/` folder and are written by the same `deploy.sh`. The host script copies the finished result into `outbox/status.json`.

## How the server writes a request without `docker.sock`

Compose check: `docker-compose.yml` already mounts `launcher-key:/run/launcher:ro` into `server`, so a bind mount is a normal pattern here. Add to the `server` service (TrueNAS override file, `deploy/truenas.yml`, since the path is host-specific):

```yaml
    volumes:
      - ${BOSSMAN_DEPLOYER}/inbox:/run/deployer/inbox          # server writes here
      - ${BOSSMAN_DEPLOYER}/outbox:/run/deployer/outbox:ro     # server reads here
```

Both are plain folders, not the socket. The server runs as uid 1000, so `inbox` must be owned by 1000 (table above). Nothing in the server can make the host run a file: the host script only ever reads `request.json` as data. If `BOSSMAN_DEPLOYER` is unset the feature is off and the decision type is hidden.

## Request file format

`inbox/request.json`, written to a temp name and renamed so the host never reads half a file:

```json
{
  "version": 1,
  "commit": "full 40-character sha",
  "decisionId": "uuid of the approved decision",
  "requestedAt": "2026-10-20T12:00:00Z",
  "approvedBy": "owner user id",
  "runner": "auto"
}
```

`runner` is `auto`, `yes` or `no`, mapped to `--runner` / `--no-runner`. Anything else, extra fields, a commit that is not 40 hex characters, or a file over 4 KB is rejected. The host never trusts `approvedBy`; it is only for the status line.

## What the host script checks (in order, any failure = reject with a reason in `status.json`)

1. Take the `flock`. If another run holds it, exit quietly.
2. Request exists, parses, matches the schema. Delete it either way so a bad file is not retried forever.
3. **Tip of main:** ask Gitea directly (`GET /api/v1/repos/{owner}/{repo}/branches/main` with `gitea.token`) and require `commit` to equal the tip. Then `git fetch` in the checkout and require the commit to be present and a fast-forward of what is deployed. **A request for an older or side-branch commit is refused.** (Endpoint path is Gitea's documented API; **UNVERIFIED** against the owner's Gitea version.)
4. **Rate limit:** at most one deploy per 10 minutes (configurable in the script header), measured from `state/last-deploy`. A rejected request says when it can run.
5. **Infra paths:** `git diff --name-only deployed..commit`. If any path matches the infra list, refuse unless `state/infra-approval` exists and contains this exact commit sha. Infra list: `docker-compose.yml`, `deploy/`, `scripts/`, any `Dockerfile`, `.env*`, `.github/`, `.gitea/`, `docs/09-self-deploy.md`. This is what stops "agents write what root runs".
6. Run `$D/deploy.sh --yes --no-runner` by default (see below), after checking out that exact commit. If the request asks for runners, see "Runners".
7. Copy the result to `outbox/status.json`, append to `history.jsonl`, touch `state/last-deploy`.

### Why a pinned `deploy.sh`

`scripts/deploy.sh` lives in the repo, so an agent could edit it. The host therefore runs its **own installed copy** (`$D/deploy.sh`), and `scripts/` is on the infra list so a change to the repo copy is flagged. After the owner reads such a change, they copy the new file over by hand. Phase 0's script works from the checkout unchanged; the host copy is the same file.

**Compose file caveat:** `deploy.sh` runs `docker compose build` using the checkout's `docker-compose.yml` and Dockerfiles. Step 5 already refuses any change to them without the host token, so an unapproved commit can only change application source. That source is still built and run (an agent's code runs as the Boss Man server, see Security).

### Runners

Updating runners kills agent runs in progress (see phase 2). So by default the host deploys **server and launcher only** and passes `--no-runner`; `runner: yes` is allowed only when the owner picks it on the decision, and until phase 2 the decision card shows the same warning `deploy.sh` prints. When the diff touches runner code and the request said `no`, the status says "runner update pending" and the UI offers a separate approval.

## Keeping `:previous` images

The server and launcher images are `boss-man-server` (the Compose default, since `server` has no `image:` line) and `boss-man-launcher:current`; runners already keep `:previous` through `update-runner.sh`. Phase 1 adds a step to the host script before building: `docker tag boss-man-server:latest boss-man-server:previous` and the same for the launcher. Rollback is then `docker tag … :previous :latest && docker compose up -d --no-build server launcher`, which is faster and works even if the build is broken. (The `boss-man-server` default name is **UNVERIFIED**; confirm with `docker compose images`. Naming it in `docker-compose.yml` is a one-line change that removes the doubt, and falls under the infra list, so the owner does it.) Phase 0's commit-based rollback remains the fallback.

## status.json (what the UI reads)

```json
{
  "version": 1,
  "state": "idle | queued | running | deployed | failed | rejected | rolled_back",
  "requestId": "decision uuid",
  "commit": "sha", "fromCommit": "sha",
  "startedAt": "...", "endedAt": "...",
  "backup": "/mnt/.../bossman-2026-10-20-1200.sql.gz",
  "message": "plain-language one line, e.g. 'Rejected: docker-compose.yml changed; needs host approval'",
  "logTail": ["last 40 lines of the run"]
}
```

Same shape idea as phase 0's `deploy-status.json`, with `requestId`, `state` and `logTail` added. The UI shows it on a Deploy panel (Settings) and on the decision card. While the server is restarting the file still holds the last state, so when the UI comes back it can say "deploy finished while you were away".

## TrueNAS: how the host runs it

Two ways, and I could **not verify** either on a real box.

| Option | How | Survives a TrueNAS upgrade? |
|---|---|---|
| **TrueNAS cron job** (UI: System > Advanced > Cron Jobs; or API `cronjob.create`) | Command `/mnt/NVME_Apps/Container_files/boss-man/deployer/deploy-host.sh`, user root, every minute. | **Likely yes**: cron jobs are stored in TrueNAS's own configuration database, which carries across updates. UNVERIFIED for 25.10. Also covered by saving the TrueNAS config file. |
| **systemd timer** | Unit files in `/etc/systemd/system`. | **Probably not**: SCALE's root filesystem is rebuilt on each update, so hand-made files there are normally lost. UNVERIFIED; do not rely on it. |

Recommendation: **use the TrueNAS cron job.** A one-minute cron is polling, but the request is rare, so the cost is one file-exists check per minute. Alternative if a minute of delay bothers anyone: a long-running `inotifywait` loop started by an **Init/Shutdown Script** (a TrueNAS UI feature, UNVERIFIED), but that is more moving parts for a few seconds.

## Decision type in Boss Man

- New value `deploy` in the `decision_kind` enum (`apps/server/src/db/schema.ts`, needs a Drizzle migration), tier `owner`, so only the owner can answer and the CEO cannot auto-approve it. (Decision kinds today: question, approval, permission, stale_blocker, stalled_run, engagement, budget. Production deploy targets already require the owner, R15.)
- Created by the server when a PR to the default branch is merged (a "Deploy abc1234?" card), not by agents, so an agent cannot create or approve one. Card content: commit list, files changed grouped as "app / database migration / infra", a red banner when infra paths are included ("needs host approval, will be refused unless you approve at the NAS"), runner choice, the warning about in-flight runs, and a link to the latest backup.
- Approve writes `inbox/request.json`. The server refuses to write it if the status is `running`, or if the decision was already answered (idempotent on `decisionId`).
- Reject or withdraw does nothing on the host.

## Notification on completion

The server watches `outbox/status.json` (poll every 5 s while a request is open; also on start-up). When `state` changes to `deployed`, `failed`, `rejected` or `rolled_back` for the request's `decisionId`, it creates an owner notification linked to the decision (the notifications table already takes a `decisionId`). Levels: deployed = note, rejected = flag, failed or rolled back = page (goes to the phone through ntfy when configured). If the server itself never comes back, nothing in Boss Man can tell the owner; the host script can run an optional `BOSSMAN_NOTIFY_CMD` (for example a `curl` to ntfy) on failure. **Owner must pick a channel** (open question).

## Security: what a merged PR could and could not do

**Could**
- Change application code in `apps/*/src` and `packages/`, which then runs as the Boss Man server (uid 1000) with its database access and its master key file. That is already true today for anything the owner merges and runs by hand; the new risk is only that approving a deploy is a quicker click.
- Add a database migration. It runs on the live database at start-up. The backup before every deploy is the safety net; there is no automatic restore.
- Make the app deploy-able but broken: the health check fails and the host script stops, and the owner gets a page.

**Could not** (by design)
- Change `docker-compose.yml`, Dockerfiles, `deploy/`, `scripts/` or the CI files and have them deployed, without the owner creating `state/infra-approval` at the host shell. This is the main protection, and it depends on the infra list being complete (see open questions).
- Change `deploy-host.sh` or the pinned `deploy.sh`: they are root-owned and outside the checkout.
- Make the host deploy a commit that is not the current tip of main on Gitea, or deploy more than once per 10 minutes.
- Get `docker.sock`, or any host command execution from the server: the server writes a data file in one folder and reads one folder read-only.
- Read the Gitea token or the infra-approval token: they are root-only and not mounted.
- Approve its own deploy: decision tier is owner, and the server creates the request only after the owner's answer.

**Not covered**
- A compromised **server** (not just a merged PR) can write `inbox/` freely, so it could replay valid requests for the current tip up to the rate limit. Impact is a redeploy of already-approved code; that is accepted.
- Whoever can push to main on Gitea decides what "tip of main" is. The owner's merge approval is the control there. If an agent token can push directly to main (bypassing PRs), the whole scheme weakens; check branch protection. UNVERIFIED for the owner's Gitea.
- Dockerfile **build steps** run agent-written commands in a build container if a Dockerfile changed; step 5 blocks that unless approved. Builds must stay on the default bridge, never `--privileged` or host network.
- `git` hooks or `.gitattributes` filters in the checkout run as root during `git pull`/`checkout`. Mitigation: the host runs git with `-c core.hooksPath=/dev/null` and no filters. (Planned; UNVERIFIED that this covers every case, e.g. submodules, which the repo does not use.)

## Work breakdown

| # | Task | Who | Effort |
|---|---|---|---|
| 1 | `deploy-host.sh`: lock, schema check, Gitea tip check, rate limit, infra check, call `deploy.sh`, status/history, `:previous` tagging. Shell test with a fake docker and a local git remote (as used for phase 0). | agent, owner reviews | 1.5 d |
| 2 | Compose/`truenas.yml` bind mounts, folder creation and permission steps in `docs/06`. | agent | 0.5 d |
| 3 | Server: `deploy` decision kind + migration, creation on merge, approve writes `request.json`, idempotency, tests. | agent | 1 d |
| 4 | Server: status watcher, notifications, `/api/deploy/status` for the UI, tests. | agent | 0.75 d |
| 5 | UI: decision card (files grouped, infra banner), Deploy panel showing status and history. | agent | 1 d |
| 6 | Install on the NAS: copy scripts, tokens, cron job; test a deploy, a rejected infra change, a rate-limited repeat, and a rollback; verify that cron survives a TrueNAS update. | owner + agent | 0.5 d |
| | **Total** | | **about 5 days** |

## Compatibility with phase 2 (drain) and phase 3 (blue/green)

Keep in mind while building phase 1:

- **Drain (phase 2):** the request already carries `runner`. Phase 2 changes what `runner: yes` does (server asks per-company drain then per-runner recreate) without changing the file format; keep `version` and ignore unknown fields on the host side so this needs no migration. Do not hard-code "runners are recreated by `update-runner.sh`" into the host script; call it through one function.
- **Migration step (phase 2):** `deploy.sh` currently lets the server run migrations on start. When phase 2 splits that into a separate step, it goes into `deploy.sh`, not the host script, so the host stays unaware.
- **Health (phase 2):** `/api/health` today returns `{ok:true}` and the container healthcheck uses it. A richer health (database ping, migration version) must keep the same endpoint and 200-when-healthy contract, because both `deploy.sh` and the host rely on it.
- **Blue/green (phase 3):** do not assume one `server` container or one host port. Keep the "start new, wait healthy, then switch" part behind one function in `deploy.sh` so phase 3 can replace the plain `compose up -d` with a switch. `status.json` should therefore describe stages, not container names. The rate limit and infra check apply unchanged, but a proxy in front of port 3101 is new infrastructure, so its config belongs on the infra list. The server bind mounts above are per container and must be repeated on both colours.
- **Rollback state:** phase 0's `previous-commit` and phase 1's `:previous` images are both single-slot. Blue/green makes the previous colour itself the rollback; do not build a deeper history now.

## Open questions for the owner

1. Does the install's `src` checkout pull from Gitea or from GitHub today? `docs/06` clones from GitHub; the host's tip check assumes the checkout and the check point at the same repo. Which is the source of truth for the Boss Man repo itself?
2. Is branch protection on for `main` in Gitea, and can an agent's token push to it directly?
3. Which channel should tell the owner if Boss Man does not come back (ntfy, email)?
4. Is 10 minutes the right rate limit, and is a one-minute cron delay acceptable?
5. Are the infra paths listed complete? Anything the stack reads at start-up that lives in the repo (for example `.env.example`, `deploy/truenas.yml`) belongs there.
6. Should "runner update" be a separate decision from "server deploy" (recommended until phase 2's drain exists)?
7. **To verify on the NAS:** the cron job survives a TrueNAS upgrade; whether `boss-man-server` is the real image name; Gitea's branch endpoint on the owner's version; bind mount ownership with the TrueNAS override file.
