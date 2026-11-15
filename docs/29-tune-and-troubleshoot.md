# 29 — Tune and troubleshoot

This page is for owners whose Boss Man is already installed ([docs/00-first-time-install.md](00-first-time-install.md)). It covers what to change once it runs, and what to do when something goes wrong. Nothing here is needed for a first install.

The commands use `$B`, the install folder from step 1 of the install guide (for example `B=/opt/boss-man`). If you opened a new shell, set it again first. Run `docker compose` commands from `$B/src`.

## Troubleshooting

### The runner stays Offline, or never says Connected

Check the runner's container and log:

```sh
docker ps -a --filter name=boss-man-runner
```

```sh
docker logs --tail 50 boss-man-runner-<slug>
```

`<slug>` is shown in **Settings > Server and runner** under **Runner**. Fixes:
- If the runner image was never built, or the canary failed in step 5 of the install, run `scripts/update-runner.sh` again, then choose **Start runner**.
- If **Settings** shows an error under the runner (the launcher couldn't start it), check `BOSSMAN_DOCKER_GID` in `.env` matches `stat -c %g /var/run/docker.sock`, then `docker compose up -d`.
- Choose **Reconnect runner** to give it a fresh token and container.
- A log line `getaddrinfo ENOTFOUND server` means the server wasn't reachable. The runner keeps retrying by itself, waiting longer each time, up to 30 seconds between tries.
- Running without the launcher? An empty token file makes the runner stop with "Set BOSSMAN_RUNNER_TOKEN_FILE...". Follow [docs/06, step 7](06-install-truenas.md#7-the-runner-token).

### The port is already in use

Check:

```sh
ss -tlnp | grep -E ':3100\b'
```

Nothing printed means it's free. If something is listed, change `BOSSMAN_HOST_PORT` in `$B/src/.env` to a free port, then:

```sh
cd $B/src && docker compose up -d
```

Use the new port in the browser.

### I can't log in, or the login page just reloads

Session cookies are Secure by default and need HTTPS. For plain `http://` on a trusted home network, `.env` needs `BOSSMAN_INSECURE_COOKIES=1`. Check:

```sh
grep BOSSMAN_INSECURE_COOKIES $B/src/.env
```

After changing it, run `docker compose up -d` from `$B/src`. Open the page with the same address each time, so the cookie keeps working.

### `docker compose` says something is not set or a file is missing

A message like "Set POSTGRES_PASSWORD in .env" means `.env` is missing, or you're not in `$B/src`. (A missing `BOSSMAN_DATA` gives no message: Compose quietly uses `/srv/boss-man/data`, so check it is set.) A missing secret file means step 3 of the install wasn't finished. Check:

```sh
cd $B/src && ls -a . secrets
```

You need `.env`, `secrets/master.key` and `secrets/runner-app-co.token`.

### The git token is refused

**Check the token against <project>** says what the host answered:
- "The host refused the token (HTTP 401 or 403)": the token is wrong, expired or lacks permission. Make a new one.
- "The token can't see the repo": check the repo's owner and name in **Git repo**, and that the token has access to it.
- "can read the repo but not push to it": give the token write permission (Contents, Pull requests and Workflows on GitHub, `write:repository` on Gitea).
- For a Gitea on your network, check the address is reachable from the host.

### The Claude token is refused

Boss Man rejects a token with stray spaces or quotes. Paste only the token. Then choose **Check with Claude** in the credentials table. A setup-token can only be fully proved by Claude Code on the runner, so the runner must be **Connected** first.

### The server doesn't start, or the page says offline (migrations)

Database changes apply by themselves when the server starts. Check:

```sh
cd $B/src && docker compose logs --tail 100 server
```

If a migration failed, don't edit the database by hand. Keep the log. Restore from a backup if you have one (`scripts/deploy.sh` keeps them in `$B`). Also check Postgres is healthy with `docker compose ps`.

### The disk is filling up

Check the host and Docker:

```sh
df -h $B
```

```sh
docker system df
```

**Settings > Server and runner** shows the runner's **Workspaces** size. Each company has a disk cap (20 GB by default); Boss Man tells you once a day when a company is over it, and it releases the workspaces of tickets that were finished a while ago (7 days by default). Builds of the runner image also use space. Check `docker system df` before removing anything.

### Parallel test runs fail with `spawn EAGAIN`

The runner hit its limit of processes and threads. Raise `BOSSMAN_RUNNER_PIDS` (see the table below).

## Backups: where they are saved

Every script that makes a backup writes it straight into your backup folder, which is `<install-dir>` (`$B`), next to `src`. The file names tell you which script made them:
- `bossman-YYYY-MM-DD-HHMM.sql.gz`: made before each update (`scripts/deploy.sh`) and by the host deployer.
- `rebuild-YYYY-MM-DD-HHMM.sql.gz`: made by `scripts/rebuild-live.sh`.
- `restore-test-*.sql.gz`: made by `scripts/restore-test.sh --fresh-backup`.
- `penpot-YYYY-MM-DD-HHMM.tar`: made by `scripts/backup-penpot.sh`, if you use Penpot.

If you set `BOSSMAN_BACKUP_DIR`, they go there instead. Backups made by current scripts are readable by their owner only (mode 600). How to check that a backup restores: [docs/23-updating.md](23-updating.md#check-that-a-backup-restores).

### Older installs: lock down old backups

Only for an install that made backups with older scripts. Those backups may be readable by every user on the host and hold password hashes and sessions. To list the ones that are not owner-only, run:

```sh
find $B -maxdepth 1 -type f \( -name 'bossman-*.sql.gz' -o -name 'rebuild-*.sql.gz' -o -name 'restore-test-*.sql.gz' -o -name 'penpot-*.tar' \) -perm /077 -print
```

To lock them all down, run this once. It is safe to run again, and it only changes files in that folder (not folders below it). If you set `BOSSMAN_BACKUP_DIR`, put that folder in place of `$B`:

```sh
find $B -maxdepth 1 -type f \( -name 'bossman-*.sql.gz' -o -name 'rebuild-*.sql.gz' -o -name 'restore-test-*.sql.gz' -o -name 'penpot-*.tar' \) -exec chmod 600 {} +
```

Run the first command again: it should print nothing.

## Memory limits

Every container Boss Man starts has a memory limit and a kill priority, so one runaway container (a headless browser, say) can't use up the whole host's memory. They are set in `.env`. All of these are optional; the defaults are below.

| Setting in `.env` | What it limits | Default |
| --- | --- | --- |
| `BOSSMAN_RUNNER_MEMORY` | optional upper bound on each runner's memory (no swap on top). Leave it empty: Settings → Server and runner → Checks → "Checks at once" sizes the runner (13 GB for the agents plus 3 GB per check slot, so 16 GB for one, 19 GB for two) and keeps it within the host's memory less 2 GB for the server. Each company has its own runner and each is sized from the whole host's memory, not a share, so with several companies on one host the runners together can be promised more than the host has: keep "Checks at once" low there (the Checks panel warns). A line here only lowers the limit. The Checks panel shows the limit in force and says if this line is what holds it down. (The compose-run `runner` service, used without the launcher, still uses `4g` when this is empty) | empty (no cap) |
| `BOSSMAN_RUNNER_PIDS` | processes and threads per runner | `4096` |
| `BOSSMAN_RUNNER_CPU_SHARES` | CPU priority of each runner against the server, database and proxy (1024 each, proxy 2048). Not a cap: only matters when the host is busy, and an idle host still lets runners use every core | `512` |
| `BOSSMAN_RUNNER_CPUS` | optional hard CPU cap per runner (e.g. `4`). Leave empty unless the host is shared with other workloads: one runner hosts all of a company's agents and the merge check, so a low cap slows them all even when the host is idle | none |
| `BOSSMAN_RESERVED_THREADS` | threads kept back for the server, database and proxy: runners are confined to all the other threads. Off unless you turn it on (see "Reserved threads" below). `auto` reserves 2 (one core, hyperthread siblings together) when the host has 6 or more threads, and stays off below that; `off` or `0` switches it off; a number keeps that many back (refused if it would leave the runners fewer than 2). The launcher works the threads out at start from what the host lets containers use. Server status (`cpuReserve`) shows whether it is on and which threads | `off` |
| `BOSSMAN_CHECK_SLOTS` | optional upper bound on how many full checks a runner may run at once. Leave it empty: set "Checks at once" in Settings → Server and runner → Checks instead. Saving a new number recreates the runners with that many slots and the memory to match, each as its company goes idle; no `.env` edit and no host step | empty (no cap) |
| `BOSSMAN_OPENCODE_SESSION_DAYS` | disk, not memory: how many days an OpenCode session may sit untouched before the runner's hourly clean-up deletes it from OpenCode's session database. OpenCode never deletes sessions itself, and its database grows by about 1 GB a day on a busy runner. `0` turns the clean-up off. Before its first delete in each database the runner makes and checks a backup copy in its data folder (kept 7 days), and it needs that file's size plus 1 GB free. Once per database it then compacts the file while no OpenCode run is live; new OpenCode runs wait meanwhile, at most 30 minutes. Read at runner start | `14` |
| `PNPM_STORE_DIR` | where agents' package installs share one pnpm store. Must be a folder under `/home/node/workspaces` (the runner's only writable volume), not its root; anything else is refused at start-up | `/home/node/workspaces/.pnpm-store` |
| `BOSSMAN_SERVER_MEMORY` / `BOSSMAN_SERVER_MEMORY_RESERVED` | the server (single, or each blue/green colour): limit / amount kept for it. No cap by default (`0`); measure your server's use before you set one | `0` / `512m` |
| `BOSSMAN_SERVER_HEAP_MB` | the server's JavaScript heap, in MiB (`--max-old-space-size`). The memory log's `heapUsed` shows your use. If you set `BOSSMAN_SERVER_MEMORY`, keep this well below it | `1536` |
| `BOSSMAN_DB_MEMORY` / `BOSSMAN_DB_MEMORY_RESERVED` | Postgres: limit / amount kept for it | `0` (no cap) / `256m` |
| `BOSSMAN_TOOLSERVER_MEMORY`, `BOSSMAN_TOOLSERVER_PIDS`, `BOSSMAN_TOOLSERVER_SHM` | tool servers that run a browser (crawl4ai, scrapling), see below | `2g`, `512`, `512m` |

- **Priority.** If the host runs out anyway, Linux stops runners and tool servers first (`oom_score_adj` 500) and the database, server and proxy last (-500, -500 and -900). A runaway browser hits its own limit first and only that container is stopped and restarted.
- **CPU.** On a VM or a container host, the guest's own CPU limit applies on top of these settings. The weights only decide who wins when the CPUs are all busy.
- **Choose numbers for your host.** Add up the limits of everything that can run at once (every runner plus tool servers); keep that below the host's RAM with room for the server, database and proxy. Limits are ceilings, not reservations, so they can add up to more than the RAM, but then one busy moment can still run the host out.
- **Tool servers are yours.** Boss Man does not start crawl4ai, scrapling or other tool servers you register in Settings, so it cannot limit them for you. Put them in compose with limits: [deploy/tool-servers.yml](../deploy/tool-servers.yml) is a commented example. One already running by hand: `docker update --memory 2g --memory-swap 2g --pids-limit 512 <container>` (lost if the container is recreated).
- **Check it took effect.** `docker stats --no-stream` should show a number after the slash for each Boss Man container, not your whole RAM. `docker inspect -f '{{.HostConfig.Memory}} {{.HostConfig.OomScoreAdj}}' <container>` prints the limit in bytes and the priority (0 bytes = no limit).
- **Applying a change.** `docker compose up -d` recreates the containers whose limits changed (the server and database restart for a few seconds). Runners started by the launcher pick up a new `BOSSMAN_RUNNER_MEMORY` when the launcher is recreated and the runner is next restarted.
- **A test keeps this in place:** `apps/server/test/compose-memory-limits.test.ts` fails if a service loses its `mem_limit`.

Per host:
- **Plain Linux or a VM:** nothing extra. If `docker info` warns "No swap limit support", the swap setting is ignored but the memory limit still works; to enable it, add `cgroup_enable=memory swapaccount=1` to the kernel command line and reboot.
- **Proxmox:** see [docs/32-proxmox.md](32-proxmox.md).
- **TrueNAS SCALE:** nothing extra; the same settings go in the `.env` from docs/06 step 4.

### Reserved threads

This keeps a core free of agent work so the server, database and proxy never wait for a thread. It only helps if the web page is slow *because the CPU is full*. A slow page on an idle host has another cause, and a reserved core would only take threads away from the agents.

Turn it on only if you measure this: the page is fine when the host is idle and slow only when every thread is busy (`top` shows little idle time and a load average above the thread count). Nothing else is pinned: the server, database and proxy may use any thread, runners just never use the reserved ones. Tool servers are not confined either.

1. Set `BOSSMAN_RESERVED_THREADS=auto` (or a number) in `.env`.
2. Run `docker compose up -d launcher` (only the launcher restarts).
3. Choose **Settings → Server and runner → Updates → Build and update runners**. Runs in progress finish first; each runner is swapped when it is idle.

Check it: ask for server status and read `cpuReserve`, or run `docker inspect --format '{{.HostConfig.CpusetCpus}}' boss-man-runner-<company>`.

Undo: set `BOSSMAN_RESERVED_THREADS=off` in `.env`, recreate the launcher and the runners.

A host with fewer than 6 threads stays off with `auto`. On a VM, give the guest more threads rather than lowering the limit.

## Synthetic (OpenCode)

Synthetic (synthetic.new) is an OpenCode provider.

1. Add its key under **Settings > Secrets > Add** as **Synthetic API key**. It reaches agents as `SYNTHETIC_API_KEY`, and OpenCode lists the models as `synthetic/<model>` (for example `synthetic/hf:deepseek-ai/DeepSeek-V4.1-Flash-1017`).
2. Under **Settings > Funding**, add a source with kind **Subscription (setup-token)** and provider **Synthetic** for a standard plan.

The Funding page then shows requests used of the plan's limit, the percentage, when it renews, and how use has moved within the current period.

- Boss Man checks the plan at most every 5 minutes, and again right after a run on an agent paid from Synthetic ends. The page shows the stored reading. If Synthetic can't be reached, the card keeps the last good reading and says how old it is; it never stops a run. Readings are kept for 30 days.
- You get one notification when use passes 80% of the limit, and another at 100%, each once per period. Each names when the plan renews and which agents are paid from Synthetic.
- Boss Man does not pause or slow any runs when the plan runs out: move less urgent work or wait for the renewal.
- The CEO can read the same numbers from its server status. It sees only its own company's agents named.

## Compression

The web build writes brotli and gzip copies next to every built asset, and the server sends those, so the page's JavaScript, CSS and fonts arrive compressed on every kind of install. A plain install has no proxy, so the API's JSON is sent uncompressed; the blue/green setup ([docs/06, 9d](06-install-truenas.md#9d-switch-to-bluegreen-optional)) compresses it at the Caddy front door.

## The infra rebuild script

`scripts/rebuild-live.sh` is only for the optional blue/green setup, which needs Docker Compose 2.24 or newer. It rebuilds the live copy in place after a change the host deployer refuses, and the page is down for about 20 to 30 seconds. On a plain install, use `scripts/deploy.sh` instead. How it all fits together: [docs/09-self-deploy.md](09-self-deploy.md).

## Related pages

- [docs/00-first-time-install.md](00-first-time-install.md): the install steps.
- [docs/23-updating.md](23-updating.md): read before you update.
- [docs/30-in-app-updates.md](30-in-app-updates.md): update from the web page (the host deployer).
- [docs/31-phone-notifications.md](31-phone-notifications.md): pages and asks on your phone.
- [docs/32-proxmox.md](32-proxmox.md): running Boss Man on Proxmox.
