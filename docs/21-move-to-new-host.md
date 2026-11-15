# Move Boss Man to a new Docker host (BOS-276)

A step-by-step guide for moving a running Boss Man to another machine that runs Docker. It works for any Linux Docker host. The two marked notes at the end cover TrueNAS (the old host in the first real move) and Proxmox (the new one).

**The rule that keeps this safe:** only one host is live at a time, and the old host is never deleted or changed until you have used the new one for a while and said so. If anything goes wrong, you stop the new host and start the old one again.

Every command below comes from this repository's own scripts and docs. Anything that depends on the host's own tools (Proxmox, TrueNAS, the host's scheduler) is marked **Unconfirmed** with how to find out. Do not paste a host command into a root shell that this guide has not confirmed for your host.

Words used here: `$BOSSMAN_HOME` is the folder that holds Boss Man on a host. Inside it: `src/` (the checkout, with `.env` and `secrets/`), `data/` (`BOSSMAN_DATA`) and `deployer/` (the host deployer, `$D` in `docs/09-self-deploy.md`). Use any path you like; the old host's path and the new host's path do not need to match, but `.env` must agree with where you put things.

## 1. What moves, and how each piece is checked

| Piece | How it moves | Check on the new host |
|---|---|---|
| Database | `pg_dump` backup on the old host (a `bossman-*.sql.gz` file), loaded on the new host. Rehearsed first with `scripts/restore-test.sh` | Table counts and migration count equal the old host; `/api/ready` says `"role":"leader"` |
| `secrets/master.key`, secrets from `.env`, runner token files | Copied by hand (never through git, tickets or chat). Without `master.key` every stored credential is unreadable. The old `.env` is copied under another name and only its secrets are carried over (stage 3, step 4) | Server starts; a test run works |
| Company data (`$BOSSMAN_DATA/companies`: workspaces, repo copies, Claude config) | Copy the folder, keep owner uid 1000 | A test run sees its workspace. Repo clones can be fetched again; **unpushed work inside a workspace cannot**, so agents are stopped before the copy |
| Legacy `app-co` data (only if you still use it) | Part of the same data folder | Same |
| Runner images | Built again on the new host, never copied | Runner health in Boss Man |
| Host deployer and its scheduled job | Recreated per `docs/09-self-deploy.md` | `status.json` is refreshed; a dry run works |
| Blue/green and Caddy | Recreate `$D/proxy/active.caddy` with the same live colour | The commit shown through the proxy equals the old host's |
| Tailscale state (`$BOSSMAN_DATA/tailscale`, `deploy/tailscale.yml`; skip if you do not run Tailscale) | Copy the folder so the machine keeps its name; see `docs/20-https-tailscale.md` | Login over the `ts.net` address; certificate valid |
| ntfy data and tokens (`$NTFY_DATA`, default `$BOSSMAN_DATA/ntfy`, `deploy/ntfy.yml`; skip if you do not run ntfy) | Part of `$BOSSMAN_DATA` | The test push reaches the phone |
| Penpot (only if you use it) | `scripts/backup-penpot.sh`, restore its database and assets | Open Penpot, see the project list |
| Network-guard allow list (`BOSSMAN_NETGUARD_ALLOW` in `.env`) and tool-server entries | Carry the `.env` line over; change any address in it that moved with the host, and drop stopgap entries for tool servers or project git hosts (Boss Man opens those itself). Tool servers (Settings) and project repo addresses move with the database, but check any that point at the old host's address | An agent reaches each LAN add-on it uses, for example `penpot.sh check` connects (stage 5) |
| GitHub deploy access | The new host gets its **own new** deploy key; remove the old one at the end | `git ls-remote` works from the new host |

**Two more checks for the new host:** (1) the live commit can be behind main, so check out the commit shown by Boss Man's server status, not just the main tip; (2) runners now filter network access per container (`docs/27-netguard.md`, which relies on nftables), so confirm the new host's kernel supports what that page needs before you rely on it. The guard refuses every home-network address the runner has not been told about, so a LAN add-on such as Penpot is unreachable for agents until its host:port is in the allow list (section 1). On a Proxmox VM this is the guest kernel; how to check is on that page, and I have not verified it on your hardware.

## 2. Hard-coded host values that break on a new box

| Value | Where | What to do |
|---|---|---|
| The TrueNAS install folder in the "hand-apply" cards | `apps/server/src/services/self-deploy.ts` | Fixed by **BOS-269**: the cards now use the `src` and `deployer` folders that the host deployer reports, so they follow the new host |
| The same path in the install guides | `docs/06-install-truenas.md`, `docs/09-self-deploy.md` | Left as the TrueNAS worked example; both now point here for any other host. They are marked as TrueNAS paths |
| `BOSSMAN_DATA` (default `/srv/boss-man/data`) | `docker-compose.yml`, launcher | Host-neutral. Set it in `.env` to a folder on the new host |
| `BOSSMAN_DEPLOYER` (absolute host path, e.g. `/mnt/tank/apps/boss-man/deployer` on TrueNAS), `NTFY_DATA` if set | `.env`; required by `deploy/truenas-deployer.yml` and `deploy/truenas-bluegreen.yml` | **Must be changed** to the new host's paths. A copied `.env` keeps the old path and the stack will not start (or mounts nothing useful) |
| `deploy/truenas.yml`, `deploy/truenas-deployer.yml`, `deploy/truenas-bluegreen.yml` | `deploy/`, and `scripts/deploy.sh` and `scripts/host-deployer.sh` match on the file names | **Generic despite the names:** they bind-mount the data folder, add the deployer mounts, and add blue/green. Use them unchanged on any host. Renaming would break a live `COMPOSE_FILE`, so it is a follow-up ticket (rename with the old names kept working) |
| "TrueNAS cron job" for the deployer | `docs/09-self-deploy.md`, `scripts/host-deployer.sh` header | The script needs only bash, git, docker, flock and curl. The one-minute scheduler is whatever the new host has; [docs/30, step 7](30-in-app-updates.md#7-run-the-script-every-minute) gives a cron line. **Unconfirmed** for each host: find out with `systemctl --version` (systemd timer) or `command -v crontab` (cron) |
| The old host's LAN address | `.env` values `BOSSMAN_BIND` and `BOSSMAN_PORTAL_URL`, and the restore runbook in the private wiki | `.env` values **must be changed** to the new host's address |
| `BOSSMAN_DOCKER_GID` | `.env` | Differs per host. Find it on the new host with `stat -c %g /var/run/docker.sock` |
| `PENPOT_BIND`, `PENPOT_PUBLIC_URI` | `.env`, `deploy/penpot.yml` | Host addresses; must be changed if Penpot moves |
| `BOSSMAN_NETGUARD_ALLOW` (host:port entries, space separated, in double quotes) | `.env`, passed to the launcher | Carry it over as one line: if `.env` has it twice, compose uses only the last one, so merge the entries you still need into that line (`BOSSMAN_NETGUARD_ALLOW="host:port host:port"`). Drop entries that were only stopgaps for addresses Boss Man now opens by itself: each company's runner already reaches its tool servers and its projects' git hosts, so those never need an entry here. If a LAN add-on such as Penpot changed address, change its entry and the matching Boss Man secret (`PENPOT_URL`) to the same host:port. The launcher reads it only when it is recreated, and each runner's guard only when the runner is recreated |
| Edge network `172.30.0.0/29`, Tailscale `172.30.0.2`, server or proxy `172.30.0.3` | `deploy/tailscale.yml` (BOS-242), `deploy/tailscale-bluegreen.yml` | Fixed. Overridable with `BOSSMAN_EDGE_SUBNET`, `BOSSMAN_EDGE_IP`, `BOSSMAN_EDGE_SERVER_IP` and `BOSSMAN_EDGE_PROXY_IP`. Check the range is free on the new host (step 3 in `docs/20-https-tailscale.md`) |
| `front` network `172.30.0.16/28` (range `172.30.0.24/29`, proxy `172.30.0.18`) | `deploy/truenas-bluegreen.yml` (BOS-278) | Fixed, and used by every blue/green stack, so the most likely to give "Pool overlaps" on a new LAN or VPN. Overridable with `BOSSMAN_FRONT_SUBNET`, `BOSSMAN_FRONT_RANGE` and `BOSSMAN_FRONT_PROXY_IP`; keep the three consistent |
| ntfy on the edge network, `172.30.0.6` | `deploy/ntfy.yml` | Fixed. Overridable with `NTFY_EDGE_IP`; it must sit inside the edge subnet |
| Docker's default address pools | The host, not the repo | Can clash with a LAN or VPN range. **Unconfirmed**; find out with `docker network ls -q \| xargs docker network inspect --format "{{.Name}} {{range .IPAM.Config}}{{.Subnet}} {{end}}"` and `ip -4 route` |
| TrueNAS-only install guide | `docs/06-install-truenas.md` | This guide is the host-neutral move guide; `docs/00-first-time-install.md` is the host-neutral first install |

If you change a subnet, change every address that lives in it. `grep -rn "subnet:\|ipv4_address" deploy/` lists them all.

The grep behind this list searched the repo for the old host's pool name, `192.168.`, `truenas`, `subnet` and `ipam` (31 Oct 2026). The app's own code has no host-specific path.

## 3. The order of the move

Downtime is only steps 3 to 5, about 30 to 60 minutes, mainly the final data copy. It grows with the size of `$BOSSMAN_DATA`. On 27 Oct a 155 MB database backed up to 27 MB and restored in 5 seconds.

1. **Prepare the new host** (no downtime; the old host is not touched). Docker and the Compose plugin, git, flock, curl. A new deploy key. A checkout at the same commit as the old host. Folders owned by uid 1000. A `.env` adapted for the new host. Images built.
2. **Rehearse** (no downtime). Copy a normal backup over and run `scripts/restore-test.sh` on the new host. This proves the restore path before the real cut.
3. **Final backup and stop** (downtime starts). Pause agents and wait for runs to finish. Stop the deployer's scheduled job. Stop the server and Tailscale (the database stays up), then take the final backup and copy the data, then stop the database. Nothing writes during the backup and copy. The old host stays installed and stoppable.
4. **Restore and check** on the new host. Load the backup, copy the data, secrets and Tailscale/ntfy folders, start the stack, compare counts and the commit.
5. **Switch over.** Start Tailscale with the moved state, update the address you use (bookmarks, phone app, ntfy subscription, `BOSSMAN_PORTAL_URL`, any webhook that points at the old address). Boss Man then checks: server status, live commit, runner health, a test run, login over `ts.net`, an ntfy test push.
6. **Retire the old host** only after you sign off, after a trial period you choose.

**Rollback until step 6:** first, on the new host, stop everything, before you start anything on the old host. In this order: Tailscale (`docker compose stop tailscale`), ntfy with its own flags (the same command as below, ending `stop`; skip if you do not run it), then everything else (`docker compose stop`). Only when all of that is stopped, on the old host mirror stage 4: run `docker compose start db`; under blue/green run `docker compose start proxy server-<live colour> launcher` (plus any other service you ran, but **not** the other colour and not a plain `docker compose start`, which would start the standby colour and let an older image take the leader lock), send the leader signal if the live colour is green (same command as stage 4), and check `/api/ready`; under a single server a plain `docker compose start` is fine. Start ntfy again with its own flags (`docker compose -p boss-man-ntfy --env-file .env -f deploy/ntfy.yml --profile ntfy start`; under blue/green add `-f deploy/ntfy-bluegreen.yml` after the first `-f`, so the servers can reach it). Last, `docker compose start tailscale` (the new host's was stopped above, or the two fight for the name). If the new host has already used the Tailscale state (it may have rotated the keys), the old host's copy can be rejected and need a fresh login: follow `docs/20-https-tailscale.md` to sign in again, and remove any duplicate machine in the Tailscale admin console. Then turn the old host's deployer scheduled job back on (and the new host's off). The old host's data is exactly as it was at step 3. Anything written on the new host after the switch is lost unless you take a backup there first and load it back on the old host; the switch-over stage says so when it asks you.

## 4. The commands

Run all commands in the checkout (`$BOSSMAN_HOME/src`) unless a step says otherwise, as root or with `sudo` in front of commands that need it (the folder and ownership steps do). They are the repository's own commands; paths in angle brackets are yours.

### Stage 1: prepare the new host

**If the host already runs Docker** (for example a VM you set up earlier, possibly with other containers on it), do not install or reinstall anything yet. First see what is there, and change nothing:

```sh
docker ps --format '{{.Names}}\t{{.Ports}}'
```

Boss Man needs these host ports free (defaults; `.env` can change them): 3100 for the app and 3101 for the feedback portal, plus Penpot's and ntfy's ports if you use them. If one is taken, pick another in `.env` (`BOSSMAN_HOST_PORT`, `BOSSMAN_PORTAL_HOST_PORT`) rather than stopping the other container. Docker's default network range can also clash with your LAN; `docker network ls` shows what exists.

Then check which of the tools below are already installed, and install only the missing ones. Otherwise, install Docker with the Compose plugin and git, flock and curl using the host's own instructions. **Unconfirmed per host**; find out the supported way from Docker's install page for your distribution, then check:

```sh
docker compose version
```

```sh
git --version && flock --version | head -1 && curl --version | head -1
```

**Which commit:** check out the commit shown as live in Boss Man's server status, not the newest main. Merges may still change it before stage 3, so the stage 3 card names the final commit and stage 4 moves the checkout to it (`git -C "$BOSSMAN_HOME/src" reset --hard <commit>`) before building.

Get the code into `$BOSSMAN_HOME/src` as in [docs/00, step 2](00-first-time-install.md#2-get-the-code-onto-the-host), with `B` set to `$BOSSMAN_HOME`. For a private repository that means a new read-only deploy key for this host: never copy the old host's.

Check it reads the repository (prints commit ids, no password prompt):

```sh
git -C "$BOSSMAN_HOME/src" ls-remote origin HEAD
```

Check the Docker socket group, for `BOSSMAN_DOCKER_GID` in `.env`:

```sh
stat -c %g /var/run/docker.sock
```

Make the folders and give the data to uid 1000 (as in [docs/00, step 3](00-first-time-install.md#3-make-the-folders-the-master-key-and-the-token-file), plus the database folder for the TrueNAS overlay):

```sh
mkdir -p "$BOSSMAN_HOME/data/postgres" "$BOSSMAN_HOME/data/companies" "$BOSSMAN_HOME/src/secrets"
```

```sh
sudo chown -R 1000:1000 "$BOSSMAN_HOME/data/companies" "$BOSSMAN_HOME/src/secrets" && sudo chmod 700 "$BOSSMAN_HOME/src/secrets"
```

Write `.env` by copying the old host's and changing only: `BOSSMAN_DATA`, `BOSSMAN_DEPLOYER` (an absolute path to `$D`; every deployer and blue/green mount needs it), `NTFY_DATA` (only if set explicitly), `BOSSMAN_BIND`, `BOSSMAN_PORTAL_BIND`, `BOSSMAN_PORTAL_URL`, `BOSSMAN_DOCKER_GID`, `PENPOT_*` if used, `BOSSMAN_NETGUARD_ALLOW` (keep it on one line, with any moved address changed and stopgap entries for tool servers or project git hosts dropped) (and `BOSSMAN_HOST_PORT` / `BOSSMAN_PORTAL_HOST_PORT` only if a default port is taken). `BOSSMAN_BIND` and `BOSSMAN_PORTAL_BIND` default to `127.0.0.1`, which only answers on the host itself: set them to the new host's LAN address (the address you will use, as `docs/00` and `docs/06` say), not `0.0.0.0`, unless you are sure the host has only one network interface. Docker-published ports skip the host's own firewall rules, so `0.0.0.0` would put the login page on every interface. Keep `POSTGRES_PASSWORD` the same as the old host's. Do not start the stack yet.

Build the images now, at the commit you checked out, so the slow work is done before downtime. `BOSSMAN_COMMIT` labels the image; without it the image says `dev` and the "live commit equals the old host's" check cannot pass. With blue/green in `COMPOSE_FILE` the plain `server` service is parked, so do not build it:

```sh
BOSSMAN_COMMIT=$(git rev-parse HEAD) docker compose build server-blue server-green launcher netguard
```

Both colours come from the same Dockerfile; building both means either can be the live one. Without blue/green (single server), build `server launcher netguard` instead. Stage 4 builds again only if the final commit differs.

Set up the deployer folder `$D` for the blue/green proxy and host deployer on this host as in `docs/06` steps 9a and 9d (stage 4 fills it from the old host's copy). A scheduler for `host-deployer.sh` is also set up here but kept **off** until stage 5.

### Stage 2: rehearse the restore

Copy any recent `bossman-*.sql.gz` from the old host's backup folder to the new host's folder above `src/`. Start only the database, then rehearse:

```sh
docker compose up -d db
```

```sh
scripts/restore-test.sh ../bossman-YYYY-MM-DD-HHMM.sql.gz
```

It must end with a line starting `OK:`. The script compares the restored copy with the live database (`bossman`) in the same Postgres. On a brand-new host that database exists but is empty, so every table shows "missing in one side" and migrations show "live ?": that is expected. The pass checks look only at the restored copy. Proven on a fresh Proxmox VM on 3 Nov 2026: a 188 MB backup restored in 10 s with all data present. Details: wiki `runbooks/database-restore-and-bluegreen-rollback`, section 1.

Backups and the files copied in stage 3 are usually readable by root only, while `scp` logs in as your own user. On the old host, put a private copy where your user can read it (`sudo install -d -m 700 -o <your-user> /tmp/bossman-move`, then `sudo install -m 600 -o <your-user> <file> /tmp/bossman-move/`), copy it with `scp`, then remove it (`sudo rm -r /tmp/bossman-move`). Never loosen the permissions on the originals. The stage cards give these as separate copy-ready commands.

### Stage 3: final backup and stop (on the OLD host)

1. **Wait for the CEO's message "all runs ended, merges frozen" before stopping anything.** The CEO winds the agents down. You do not need to pause anything yourself; if you want to be sure nothing new starts meanwhile, press **Stop all work** under Settings → Server and runner (runs already going finish by themselves, and a banner with **Resume** shows on every page until you lift it). If you pressed it, the hold travels in the backup, so press Resume on the new host once the move is checked. Then stop the deployer's scheduled job in whatever scheduler the host uses (**Unconfirmed per host**).
2. **Stop everything that writes, but keep the database running.** The server writes all the time (heartbeats, events, sessions) and Tailscale rewrites its state, so a backup or copy taken while they run can miss data or be torn. Stop the server (both colours under blue/green), the proxy, the launcher and Tailscale; leave `db` up:

```sh
docker compose stop tailscale
```

List what is still running, then stop each remaining service except `db` by name (under blue/green: `server-blue server-green`, `proxy`, `launcher`):

```sh
docker compose ps --services --filter status=running
```

That list misses runner containers, which the launcher starts outside Compose. The launcher keeps one `boss-man-runner-<company>` container per company running (restart policy `unless-stopped`), and it stays up after the CEO's "all runs ended, merges frozen" message, with the company data folder mounted. Stopping the launcher does not stop it. First check that no run is in progress (the CEO's "all runs ended" message); if unsure, stop and ask the CEO. Then stop the runners (skip if the list is empty):

```sh
docker stop $(docker ps -q --filter name=boss-man-runner-)
```

Re-run the check; it must now print nothing:

```sh
docker ps --filter name=boss-man-runner- --format '{{.Names}}'
```

The launcher starts the runners again by itself on the new host, so you do not start them by hand.

ntfy runs as its own Compose project, so that list does not show it. Stop it too, so nothing writes to `$NTFY_DATA` while it is copied (skip if you do not run ntfy):

```sh
docker compose -p boss-man-ntfy --env-file .env -f deploy/ntfy.yml --profile ntfy stop
```

3. Take the backup now that nothing writes. Run this line in bash (`pipefail` is not accepted by every plain `sh`). Note the file name it prints; the later checks use that exact name, not a pattern, so an earlier try cannot hide a bad new file. It is written to a `.partial` file and renamed only if `pg_dump` succeeded; `umask 077` keeps it root-only. Write down its table counts:

```sh
bash -c 'set -o pipefail; umask 077; f=../bossman-final-$(date +%F-%H%M).sql.gz; docker compose exec -T db pg_dump -U bossman bossman | gzip > "$f.partial" && mv "$f.partial" "$f" && echo "$f"'
```

Check the file is not tiny and decompresses cleanly (`gzip -t`) before going on:

```sh
ls -l ../<the file name printed above> && gzip -t ../<the file name printed above> && echo gzip-ok
```

4. Copy the backup, `secrets/`, the old `.env` **under another name** (for example `.env.old-host`), `$BOSSMAN_DATA` (without `postgres/`, which is rebuilt from the dump, but **including** `tailscale/` and `ntfy/`) and the whole deployer folder `$D` (`inbox`, `outbox`, `state`, `proxy/active.caddy` naming the live colour, `host-deployer.sh`, and `host.conf` only if you have one: it is optional) to the new host. **Never copy the old `.env` over the new host's `.env`** from stage 1: it would bring back the old host's data and deployer paths, bind addresses, portal URL and Docker group id, and the stack would fail during downtime. On the new host, compare the two files and carry over only the secrets that differ (for example `POSTGRES_PASSWORD`, which must match the old host's); or skip the copy if stage 1 already set every secret. Use the tool you trust (`rsync -a` keeps owners and times; **Unconfirmed**: check it is installed with `command -v rsync`). Note which colour is live (`grep reverse_proxy $D/proxy/active.caddy`). Compare checksums of `master.key` and the backup on both sides:

```sh
sha256sum secrets/master.key ../<the file name printed above>
```

5. Only when the checksums match, stop the database too. Do not delete anything:

```sh
docker compose stop
```

### Stage 4: restore and check (on the NEW host)

Move the checkout to the final commit (`git -C "$BOSSMAN_HOME/src" reset --hard <commit>`). If it differs from the commit you built in stage 1, build again (the layer cache makes this quick); if it is the same, skip the build:

```sh
BOSSMAN_COMMIT=$(git rev-parse HEAD) docker compose build server-blue server-green launcher netguard
```

Put the deployer folder `$D` in place from the copy made in stage 3 (same layout as `docs/06` steps 9a and 9d: `inbox` owned by uid 1000, `proxy/active.caddy` naming the live colour, `host.conf` optional: only if you use a failure webhook, root-only 600; do not copy one over just to keep an old address) and set `BOSSMAN_DEPLOYER` in `.env` to its path on this host. Without `active.caddy` the proxy has nothing to route to.

First start the database, because the load needs it running:

```sh
docker compose up -d db
```

Then follow `runbooks/database-restore-and-bluegreen-rollback` section 2 for the load step only, using the final backup (there is no running writer to stop on a fresh host). Then start **only the live colour**; do not run a bare `docker compose up -d` (under blue/green it starts both colours, and a standby green with a leading blue breaks routing; `docs/06` step 9d.5). Migrate with the live colour's tag, then start that colour (replace `blue` with the live colour):

```sh
BOSSMAN_MIGRATE_TAG=blue docker compose run --rm migrate
```

**If migrate fails:** stop there. Do not start the server, and do not retry in a loop. Keep the old host as it is (it still has the exact data from stage 3). Read the error. If it is a clear fix on the new host (wrong tag, database not ready), fix it and run migrate once more. If you cannot tell, or the restored database looks wrong, roll back as described in section 3 and ask the CEO before trying again.

```sh
docker compose up -d --no-deps server-blue
```

If the live colour is green, green starts as a standby and needs the leader signal:

```sh
docker compose kill -s SIGUSR2 server-green
```

Then start the proxy and the other services except Tailscale (name them: for example `docker compose up -d --no-deps proxy launcher`; the service names are in your compose files). **Do not start Tailscale yet**: it starts in stage 5, after these checks.

The app answers on port 3100 (the feedback portal is 3101, and has no `/api/ready`):

```sh
curl -s http://<host-ip>:3100/api/ready
```

It must show `"role":"leader"`. Ticket and migration counts must equal the numbers you wrote down in stage 3.

### Stage 5: switch over

**The old host's Tailscale must already be stopped (stage 3, step 2) before the new one starts**: two machines with the same Tailscale identity fight for the name and break the address. Confirm with `docker compose ps` on the old host that Tailscale is not running. With Tailscale state copied, `docker compose up -d tailscale` brings the same machine name up (`docs/20-https-tailscale.md`, "Backing up and moving to a new host"). Do not name the plain `server` service: under blue/green it is parked behind a profile, and naming it would start a second server on the same database. If you run ntfy, start it on the new host with its own flags (`docker compose -p boss-man-ntfy --env-file .env -f deploy/ntfy.yml --profile ntfy up -d`; under blue/green add `-f deploy/ntfy-bluegreen.yml` after the first `-f`, so the servers can reach it); it was stopped on the old host in stage 3. Update the addresses you use. Turn on the deployer's scheduled job on the new host (the scheduler you chose in stage 1; **Unconfirmed per host**). Then the checks listed in item 5 of the order in section 3 run from Boss Man. Also check that agents can still reach LAN add-ons such as Penpot: ask an agent that holds the Penpot secrets to run `penpot.sh check`. If it fails with "No route to host" at once, the network guard is refusing the address: put Penpot's host:port in `BOSSMAN_NETGUARD_ALLOW` (check with `grep -n NETGUARD_ALLOW .env` in the folder you run compose from; it must print one line only, because a later line replaces an earlier one), recreate the launcher (`docker compose --profile launcher up -d --force-recreate launcher`; its output must say Recreated, and `docker compose ps launcher` must show it created just now: "Running" means compose saw no change and the launcher still has the old list), then recreate the runners (Settings → Server and runner → Updates → Build and update runners).

### Stage 6: retire the old host

After your sign-off: remove the old deploy key from GitHub, delete the old host's machine from the Tailscale admin console if it shows twice, and decommission the old host with the host's own tools (**Unconfirmed per host**).

## 5. Host notes

### TrueNAS (the old host)

- Paths in `docs/06-install-truenas.md` and `docs/09-self-deploy.md` are a worked TrueNAS example, `/mnt/tank/apps/boss-man`. Your old host's real folder is in its `.env` (`BOSSMAN_DATA`, `BOSSMAN_DEPLOYER`).
- Keep the old host's datasets until sign-off; a dataset snapshot taken at stage 3 is a cheap extra safety net (**Unconfirmed**: how snapshots are taken is TrueNAS's own UI; see the TrueNAS documentation).
- The deployer's scheduler on TrueNAS is a cron job in the TrueNAS UI; stop it there at stage 3.

### Proxmox (the new host)

The short version, for a fresh install too, is in [docs/32-proxmox.md](32-proxmox.md).

- **Recommendation: a VM, not an LXC container.** Boss Man mounts the Docker socket and starts runner containers that run agent code. A VM has its own kernel, so Docker uses normal overlay2 storage, nothing depends on LXC nesting or AppArmor, and agent code stays behind a hardware boundary. Tailscale needs no special device (this repository runs it in userspace mode).
- **If you choose an LXC container anyway,** each of these must be proven before the move, not assumed: nesting turned on in the container's options, a working Docker storage driver on the backing store, owner mapping so uid 1000 bind mounts work, and Tailscale in userspace mode (already the default in `deploy/tailscale.yml`; `/dev/net/tun` is then not needed). Prove it with `docker run --rm hello-world` and a Boss Man test run inside it.
- **Unconfirmed:** how to create the VM or container, which options to set, and how Proxmox backups are scheduled. Find out in the Proxmox web interface help (the **Help** button) and the Proxmox documentation. Report what you see on the ticket; no Proxmox command is given here on purpose.
- A Proxmox backup of the VM is an extra safety net. It does not replace the Postgres dump, which is what this guide restores.
- After the move, the guest is an ordinary Linux host: stages 1 to 6 above apply as written.
