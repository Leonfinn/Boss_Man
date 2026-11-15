# Installing Boss Man on TrueNAS SCALE

The install itself is the same as on any Linux host: follow [docs/00-first-time-install.md](00-first-time-install.md). This page holds only what is different on TrueNAS SCALE: the dataset, the extra settings, backups and restore, and the optional extras (host deployer, blue/green, phone notifications, HTTPS and the feedback portal).

The section numbers (9, 9a, 9d, 10, 10b, 11) are kept from older versions of this page, because Boss Man's own messages link to them.

Checked against TrueNAS SCALE 25.10 "Goldeye" on 16 Oct 2026. Where TrueNAS doesn't document something, the guide says so.

## How it runs, and why not "Install via YAML"

TrueNAS has run apps on Docker since 24.10 "Electric Eel". Its own apps are Compose projects named `ix-<app>`. The supported way to add your own is Apps > Discover > Install via YAML ([docs](https://www.truenas.com/docs/scale/25.10/scaleuireference/apps/installcustomappscreens/)). That route doesn't suit the Boss Man server:
- **It turns on no profiles.** It runs `docker compose up` without `--profile`, so the launcher, which starts the runners, never starts.
- **Relative paths break.** It rewrites the file into `/mnt/.ix-apps/app_configs/...`, so relative paths such as `./secrets/master.key` stop pointing at your files.
- **Its Update button fails.** The button pulls images, and Boss Man's images are built locally, so there's nothing to pull.

Instead, this guide runs Boss Man with the `docker compose` command over SSH, as its own project, `boss-man`.
- **What TrueNAS documents.** The `docker` and `docker compose` commands are on the host; the TrueNAS middleware itself calls them. TrueNAS doesn't document running your own stack from the shell, so it is neither supported nor forbidden.
- **Why it doesn't clash.** The project name is different from TrueNAS's `ix-*` apps, so TrueNAS's app actions (which remove orphans only within their own project) leave it alone.
- **Where Docker keeps its data.** Docker's data lives on the apps pool (`/mnt/.ix-apps/docker`), so OS updates don't remove images or containers.
- **After a TrueNAS update,** check that it's all still running (step 9).

## What you need

- TrueNAS SCALE 24.10 or later, with an apps pool chosen under Apps > Configuration > Choose Pool. The Docker service only runs once a pool is chosen.
- A root shell on the NAS: TrueNAS UI > System > Shell, or `su -` over SSH. Every command in this guide is typed there, so none has `sudo` in front.
- Everything in [docs/00, "What you need first"](00-first-time-install.md#what-you-need-first): an AI provider, a git token and read access to the Boss Man repo.

The commands below are a worked example. They put Boss Man in `/mnt/tank/apps/boss-man`, where `tank` is the pool and `apps` is a dataset you already keep container apps in. Use your own pool and dataset names, and change that path everywhere it appears. The examples use `192.168.1.50` as the NAS's LAN address; replace it, and `<nas-ip>`, with yours. You can find it in the TrueNAS UI under Network.

## 1. Create a dataset

Boss Man gets its own dataset under `apps`, so you can snapshot and roll it back on its own.

First check that `apps` is a dataset and not a plain folder. In a root shell on the NAS (step 2 says how to open one):

```sh
zfs list -o name,mountpoint -r tank
```

If `tank/apps` is in the list, it's a dataset. In the TrueNAS UI, go to Datasets, select `tank/apps`, and Add Dataset:
- **Name:** `boss-man`.
- **Dataset preset:** Generic. Generic datasets use a POSIX ACL, so ordinary `chown` and `chmod` behave as expected ([TrueNAS docs](https://www.truenas.com/docs/scale/25.10/scaletutorials/datasets/permissionsscale/)). Pick Generic even if `apps` itself was made with the Apps preset, which uses an NFSv4 ACL that can override them.

If `apps` isn't in the list, it's a plain folder, and TrueNAS can't create a dataset inside it. Then just make the folder; snapshots of the dataset that holds `apps` still cover it:

```sh
mkdir -p /mnt/tank/apps/boss-man
```

Everything Boss Man keeps goes in this folder.

## 2. Install Boss Man

Follow [docs/00-first-time-install.md](00-first-time-install.md) from step 1 to the end, in a root shell on the NAS, with these differences:

- **Step 1:** use the dataset folder from step 1 above: `B=/mnt/tank/apps/boss-man`.
- **Step 2:** check `git --version` works first. This guide does not cover a NAS without git.
- **Steps 3 and 4:** do the "On TrueNAS only" parts. They make `$B/data/postgres` and add the `deploy/truenas.yml` overlay to `.env`, which keeps the database in your dataset, where snapshots cover it.
- **Step 4, the port:** check nothing on the NAS already uses 3100. This prints nothing if the port is free:

  ```sh
  ss -tlnp | grep -E ':3100\b'
  ```

  If it prints a line, set `BOSSMAN_HOST_PORT` in `.env` to a free port, such as 3101, and use that port in the browser. The TrueNAS web page keeps ports 80 and 443. The examples on this page use 3101.

You end up as docs/00 describes: Boss Man on `http://<nas-ip>:<port>`, a company with a CEO, a project and a first ticket. Moving this install to another host later: see [docs/21](21-move-to-new-host.md).

The rest of this page is for after the install.

<!-- Steps 3 to 8 used to repeat docs/00 with a hand-made runner; they are gone (BOS-1572). Keep the numbers below: Boss Man's messages link to 9a and 9d. -->

## 9. Updates and checks

Updating works as on any host: read [docs/23-updating.md](23-updating.md) first, then run `scripts/deploy.sh` from the `src` folder (or approve the update on Decisions, once the host deployer in 9a is set up). Backups go to the folder above the checkout, here `/mnt/tank/apps/boss-man`.

**See what's running:**

```sh
docker compose ps
```

**Server logs:**

```sh
docker compose logs --tail 100 server
```

**After a TrueNAS update,** check `docker compose ps`. Images and containers live on the apps pool and survive OS updates. TrueNAS doesn't document how its own app actions treat containers started from the shell. Running Boss Man as its own `boss-man` project is what keeps it out of their way.

**Backups.** Every update writes a database backup to `/mnt/tank/apps/boss-man` (see [docs/23, "Backups"](23-updating.md#backups), which also shows how to check one restores and how to restore). On TrueNAS, also snapshot the `boss-man` dataset (or the one that holds it), and keep a copy of `src/secrets/master.key` off the NAS. A snapshot taken while the database runs may not restore cleanly on its own, so keep the backup files too.

**Starting again.** To throw away an install and redo it from step 2, stop it and delete the repo and data folders. This deletes the database and every workspace. It keeps nothing git-related to redo: the repo is cloned fresh (a deploy key, if you use one, stays in place). Check what's there first:

```sh
ls -la /mnt/tank/apps/boss-man
```

```sh
cd /mnt/tank/apps/boss-man/src && docker compose down; cd /mnt/tank/apps/boss-man
```

```sh
rm -rf /mnt/tank/apps/boss-man/src /mnt/tank/apps/boss-man/data
```

## 9a. Install the host deployer (optional)

This lets you update Boss Man from its own Decisions page: when `main` moves on GitHub, Boss Man asks "Deploy abc1234?", and on your approval a root script on the NAS runs `scripts/deploy.sh`.

The steps are in [docs/30-in-app-updates.md](30-in-app-updates.md), which works on any Linux host. Its "TrueNAS SCALE" section covers the differences: set `B=/mnt/tank/apps/boss-man`, add `:deploy/truenas-deployer.yml` to the end of your existing `COMPOSE_FILE`, and make the every-minute cron job in **System > Advanced > Cron Jobs**.

With blue/green (9d), `host.conf` can also set `SOAK_SECONDS=900`. The host publishes it in `outbox/available.json` as `soakSeconds`, so Boss Man's runner-update trial uses the same length.

Later in this guide, `$D` means the deployer folder, here `/mnt/tank/apps/boss-man/deployer`.

## 9d. Switch to blue/green (optional)

With this, a server update has no "Boss Man is down for a minute" gap: the new version starts next to the old one, is checked, and takes over; the old one stays up for 15 minutes so the deployer can switch back by itself if checks fail. How it works, what it checks and what it cannot: `docs/09-self-deploy.md`, "Phase 3, part 2". It needs the host deployer (9a) already working. These steps were first run on a real TrueNAS SCALE NAS on 22 and 23 Oct 2026. Two bugs found then are fixed in the repo (see "If something goes wrong" below), so use a checkout at commit `5d983a16` or later. Do them with the stack quiet (no important agent runs), because step 6 is one planned stop of 1 to 2 minutes.

Root shell, no `sudo`. Set the variables once:

```sh
D=/mnt/tank/apps/boss-man/deployer
cd /mnt/tank/apps/boss-man/src
```

**1. Get the new files onto the NAS, by hand** (they are in `deploy/` and `scripts/`, which the deployer refuses to deploy). Boss Man keeps running as a single server:

```sh
scripts/deploy.sh
cp scripts/host-deployer.sh $D/host-deployer.sh && chown root:root $D/host-deployer.sh && chmod 750 $D/host-deployer.sh
ls deploy/truenas-bluegreen.yml deploy/caddy/Caddyfile
```

(Read the new `host-deployer.sh` first, as in [docs/30, step 3](30-in-app-updates.md#3-install-the-script-as-a-copy).) Docker Compose must be 2.24 or newer for the compose file: `docker compose version`.

**2. Back up `.env` and the database.**

```sh
cp -p .env .env.before-bluegreen
docker compose exec -T db pg_dump -U bossman bossman | gzip > /mnt/tank/apps/boss-man/before-bluegreen.sql.gz
ls -l .env.before-bluegreen /mnt/tank/apps/boss-man/before-bluegreen.sql.gz
```

**3. Create the proxy folder, owned by root, with the first include.** Nothing a container can write to may hold this file:

```sh
mkdir -p $D/proxy && chown root:root $D/proxy && chmod 755 $D/proxy
cat > $D/proxy/active.caddy <<'EOF'
# Written by host-deployer.sh. Do not edit. Live colour: blue
(active) {
	reverse_proxy server-blue:{args[0]} {
		health_uri {args[1]}
		health_interval 2s
		health_timeout 5s
		health_fails 3
		lb_try_duration 15s
	}
}
EOF
chmod 644 $D/proxy/active.caddy
```

**4. Settings in `.env`.** UI on 3101 and the portal on 3111 stay settings. This helper replaces a line or adds it; check the result:

```sh
setenv() { if grep -q "^$1=" .env; then sed -i "s#^$1=.*#$1=$2#" .env; else echo "$1=$2" >> .env; fi; }
setenv BOSSMAN_HOST_PORT 3101
setenv BOSSMAN_PORTAL_HOST_PORT 3111
setenv BOSSMAN_PORTAL_BIND 192.168.1.50
setenv BOSSMAN_PORTAL_URL http://192.168.1.50:3111
grep -q '^BOSSMAN_DEPLOYER=' .env || echo "BOSSMAN_DEPLOYER=$D" >> .env
sed -i 's#^COMPOSE_FILE=.*#&:deploy/truenas-bluegreen.yml#' .env
grep -E '^(COMPOSE_FILE|BOSSMAN_HOST_PORT|BOSSMAN_PORTAL_HOST_PORT|BOSSMAN_PORTAL_BIND|BOSSMAN_PORTAL_URL|BOSSMAN_DEPLOYER|BOSSMAN_BIND)=' .env
```

`COMPOSE_FILE` must now end in `:deploy/truenas-bluegreen.yml`. `BOSSMAN_BIND` (the address the UI listens on) is unchanged: it must be the NAS address you use for `http://192.168.1.50:3101` (the proxy uses the same variable the server did). Use the same address in the browser as today, so the login cookie keeps working. Check the compose file renders: `docker compose config -q && echo ok`.

**5. First bring-up, in this order.** The image for blue is built and the database migrated before anything starts. Do not run a bare `docker compose up -d` during this.

```sh
BOSSMAN_COMMIT=$(git rev-parse HEAD) docker compose build server-blue
BOSSMAN_MIGRATE_TAG=blue docker compose run --rm --no-deps migrate
```

**6. The cutover (the one planned stop).** The old single server and its ports go; the proxy and blue take over. The runners reconnect by themselves (their address, `ws://server:3100`, now points at the proxy):

```sh
docker ps --filter name=boss-man-server-1 --format '{{.Names}}'     # must print boss-man-server-1
docker stop boss-man-server-1 && docker rm boss-man-server-1
docker compose up -d --no-deps proxy server-blue
docker compose ps proxy server-blue
```

Wait for both to say `healthy`. Then check, using your NAS address:

```sh
curl -s http://192.168.1.50:3101/api/ready; echo
curl -s -o /dev/null -w '%{http_code}\n' http://192.168.1.50:3111/portal.html
grep 'Live colour' $D/proxy/active.caddy
docker compose logs server-blue | grep 'LEADER: \*\*\*'
```

The first line should show `"role":"leader"`, the second `200`, the third `blue`. In Boss Man, **Settings > Server and runner > Runner** should show each company's runner `Connected` within a minute: runners retry every 30 seconds, and reconnect through the proxy by themselves. **Settings > Server and runner > This server** shows "Blue/green: On" with blue Live and green Not running. If any of this is wrong: "If something goes wrong" below, or "Go back".

**7. Try a swap.** `$D/host-deployer.sh --dry-run` with a request (as in [docs/30, step 5](30-in-app-updates.md#5-test-the-script)) should say `would run: a blue/green swap to ...`. For a real one, approve a deploy as usual. Watch with `tail -f $D/deployer.log`; a good swap ends with a line like `deployed: Deployed 5d983a16 to 46822c2b: green is live; blue stays up as a standby for 15 minutes`. The UI stays up throughout. **Settings > Server and runner > This server** then shows green Live and blue Standby, and **Settings > Server and runner > Runner** shows "Connected since" the time of the swap. A good swap leaves the old colour running for 15 minutes (`SOAK_SECONDS=900`, changeable in `host.conf`); a later cron minute then stops it.

**Which colour is live?**

```sh
grep 'Live colour' $D/proxy/active.caddy
docker compose ps --format '{{.Service}} {{.Status}}' | grep server-
curl -s http://192.168.1.50:3101/api/health; echo     # "role":"leader"; the commit it was built from
```

**What the deployer will not do for you**
- It refuses any change to infra files: `deploy/` (including the Caddyfile), the compose files, the deploy scripts (`scripts/deploy.sh`, `rebuild-live.sh`, `update-runner.sh`, `host-deployer.sh`; build-only scripts do not count, see docs/09 step 6) and any `Dockerfile`. `scripts/deploy.sh` refuses to run on this install too. Apply such a change by hand, after merging it on its own:
  - **Everything starts the same way:** bring the checkout up to `main` with `git fetch origin main && git merge --ff-only origin/main`.
  - **A `Dockerfile` or other server-image change:** rebuild the live colour in place, as in "Rebuild the live colour in place" below.
  - **The Caddyfile:** `docker compose exec proxy caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile`. The Caddyfile now has `encode zstd gzip` on both sites, so the proxy compresses API JSON on the way out. The runner websocket (`/api/runner/connect`) and other streaming responses are never compressed: Caddy leaves an upgrade or streaming response alone. Confirming on staging: `curl -sI -H 'Accept-Encoding: gzip' http://<host>:3100/api/ready` should answer `content-encoding: gzip` once a response is big enough to be worth compressing (Caddy leaves very small ones alone).
  - **The proxy's compose settings:** `docker compose up -d --no-deps proxy`, which leaves the UI down for a few seconds.
  - **The launcher** (`apps/launcher/` or its compose settings): it runs its own image built from this checkout, so rebuild it first, or the old code keeps running: `docker compose build launcher && docker compose up -d --no-deps launcher`. The UI stays up. Runners keep their old limits until they are recreated: at the next runner update, or now with `scripts/update-runner.sh --settings`, which waits for runs to finish, recreates each runner and wakes the agents again.
  - **`scripts/host-deployer.sh`:** Boss Man raises a card with the copy commands when the host's copy is behind; follow it.
- **Compression is not the Caddyfile's job alone.** The web build now writes a brotli and a gzip copy next to every built asset, and the server serves those straight from disk, so **every** install (including the plain `docker-compose.yml` one with no proxy) sends compressed JavaScript, CSS and fonts with no CPU cost per page. What the proxy adds is compression of the **API JSON** (the polled dashboard data); a plain install sends that JSON uncompressed. If you want the JSON compressed without the proxy too, that is a separate change (it spends CPU on the server's event loop) and not part of this install.
- After a hand-applied change, the deployer may still show the alert about deployment files for a few minutes: press **Got it**.
- Runner updates are unchanged (the drain); they never touch the proxy.

**Rebuild the live colour in place.** This is for an image change the deployer refuses, or for a colour built from an older image. For ordinary app changes, approve the update on Decisions (or **Review and deploy** in Settings → Server and runner → Updates) instead: it swaps colours with no downtime. The UI is down for about 20 to 30 seconds.

**Before you run anything here that updates the checkout (`git merge`, `git checkout`, `git pull`), type `umask 022` in your root shell.** A root shell with `umask 077` writes every file git changes as mode 600. The server runs as user `node` in its container and the image copies file permissions as they are on disk, so it crashes at start with `EACCES: permission denied, open '/app/...'`, and a rollback with the same umask fails the same way (6 Nov outage, BOS-562). `scripts/rebuild-live.sh`, `scripts/deploy.sh` and the host deployer now check this before the backup and build: if any git-tracked file is unreadable by others, or its folder can't be read and searched, they stop, change nothing, list up to 10 paths and print the fix (`git ls-files -z | xargs -0 chmod go+r`, then `chmod go+rx` on the folders). Only tracked files are touched: `.env`, `secrets/` and the data folder stay private. If the new colour never answers, the STOPPED message ends with the last 20 lines of its container log.

`scripts/rebuild-live.sh` does all of the steps below in one go: it backs up, builds the colour the proxy points at, migrates, recreates it, sends SIGUSR2, and waits until `/api/ready` shows it leading at the new commit. It stops at the first failure and says which step. It first takes the host deployer's lock (`$BOSSMAN_DEPLOYER/lock`): if a deploy or switch-back is running it waits up to 120 s (`REBUILD_LOCK_WAIT_SECONDS`), then stops having changed nothing and says what holds the lock; run it again once the deployer is idle. It also refuses, changing nothing, while an update's trial window is running (`state/soak` exists): the deployer would switch a hand rebuild back, so wait until the window ends. The steps by hand, for reference (the examples say blue):

1. Back up the database:
```sh
docker compose exec -T db pg_dump -U bossman bossman | gzip > /mnt/tank/apps/boss-man/before-rebuild.sql.gz && ls -l /mnt/tank/apps/boss-man/before-rebuild.sql.gz
```
2. Build blue at the checkout's commit, then migrate:
```sh
BOSSMAN_COMMIT=$(git rev-parse HEAD) docker compose build server-blue && BOSSMAN_MIGRATE_TAG=blue docker compose run --rm --no-deps migrate
```
3. Restart blue on the new image (this is the 20 to 30 second gap):
```sh
docker compose up -d --no-deps --force-recreate server-blue
```
   **If the live colour is green**, also tell it to take charge. Green starts as a standby (`BOSSMAN_ROLE: standby`) and only contests the leader lock after SIGUSR2, which the deployer normally sends; without it no server is in charge, writes answer "standby" and the runner can't connect:
```sh
docker compose kill -s SIGUSR2 server-green
```
4. Check. Blue's start command should be `node --import tsx src/main.ts`, and `/api/ready` should show `"role":"leader"` with the new commit:
```sh
docker compose exec -T server-blue cat /proc/1/cmdline | tr '\0' ' '; echo; curl -s http://192.168.1.50:3101/api/ready; echo
```

**If something goes wrong**
- **The proxy keeps restarting** (`Restarting (255)`, and `docker logs boss-man-proxy-1` says `exec /usr/bin/caddy: operation not permitted`). The `caddy` program in the official image carries a file capability (bind to low ports). With every capability dropped and none added back, Linux refuses to run it at all. The compose file now gives back that one capability (`cap_add: [NET_BIND_SERVICE]`); a checkout from before 23 Oct 2026 lacks it. Bring the checkout up to `main`, then `docker compose up -d --no-deps proxy`.
- **"Update failed: … blue did not step down. Switched back to blue automatically."** The live colour was built from an image that starts the server through the `tsx` command. That command runs the server as a child process and passes on only SIGINT and SIGTERM, so the hand-over signal (SIGUSR1) never arrives. Images from `5d983a16` on start `node --import tsx` directly. Rebuild the live colour in place (above) once; swaps work after that. The automatic switch-back left the live colour untouched. Any migration the attempt ran was expand-only, so the old code keeps working with it.
- **Runner shows Offline after the cutover.** Its log (`docker logs -t --since 1h boss-man-runner-<company> 2>&1 | tail`) shows `getaddrinfo ENOTFOUND server` while the proxy is down. It reconnects by itself within 30 seconds of the proxy coming up.

**The private "front" network (an install that is already running blue/green).** The compose file now gives the proxy and the two colours a private network, `front`, where the proxy has a fixed address (172.30.0.18). The proxy reaches the live colour there as `server-<colour>-front`, and the colours believe the forwarded client address only from that one address. Nothing else can use that network: not the runners, not Tailscale. Defaults: `BOSSMAN_FRONT_SUBNET=172.30.0.16/28`, `BOSSMAN_FRONT_PROXY_IP=172.30.0.18`, `BOSSMAN_FRONT_RANGE=172.30.0.24/29`. The deployer refuses this change (it edits `deploy/` and `scripts/`), so apply it by hand, on staging first:

1. Check the subnet is free: `docker network ls -q | xargs docker network inspect --format '{{range .IPAM.Config}}{{.Subnet}} {{end}}'` must not list anything inside 172.30.0.16/28. If it does, set all three `BOSSMAN_FRONT_*` variables in `.env` to a free block (the range must sit inside the subnet and not contain the proxy address).
2. Back up (`.env` and the database, as in step 2 above), then `git fetch origin main && git merge --ff-only origin/main`.
3. Copy the new deployer: `cp scripts/host-deployer.sh $D/host-deployer.sh && chown root:root $D/host-deployer.sh && chmod 750 $D/host-deployer.sh`. It works with the old and the new compose files: it only writes the new form of the include when the proxy can reach `server-<colour>-front`.
4. Recreate the proxy and the live colour (a few seconds of downtime; the standby colour picks up the change at the next swap): `docker compose up -d --no-deps --force-recreate proxy server-blue` (use the live colour's name).
5. Check that the network lists the proxy (172.30.0.18) and the colours, and nothing else: `docker network inspect boss-man_front --format '{{range .Containers}}{{.Name}} {{.IPv4Address}} {{end}}'`. Then put the live colour's include in the new form, by running a swap or by hand:

~~~sh
cat > $D/proxy/active.caddy.new <<'INC'
# Written by host-deployer.sh. Do not edit. Live colour: blue
(active) {
	reverse_proxy server-blue-front:{args[0]} {
		header_up X-Forwarded-For {client_ip}
		health_uri {args[1]}
		health_interval 2s
		health_timeout 5s
		health_fails 3
		lb_try_duration 15s
	}
}
INC
chmod 644 $D/proxy/active.caddy.new && mv -fT $D/proxy/active.caddy.new $D/proxy/active.caddy
docker compose exec -T proxy caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile && docker compose exec -T proxy caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile
curl -s http://192.168.1.50:3101/api/ready; echo
~~~

6. What changes for people: the server now sees each device's real address (before, every device looked like the proxy), so the login attempt limit counts per device.

**Undo the front network.** Revert the commit (or check out the previous `deploy/truenas-bluegreen.yml` and `deploy/caddy/Caddyfile`), put back the previous deployer copy, rewrite the include in the old form (the snippet in step 3 above, with the live colour's name), then `docker compose up -d --no-deps --force-recreate proxy server-<live colour>`. An old deployer cannot read the new form of the include, so the rewrite is required.

**Go back to the previous release after the 15 minutes** (the old colour has been stopped, its image is still there until the next swap). As root on the NAS, from the deployer folder:

```sh
$D/host-deployer.sh --rollback --dry-run   # checks only
$D/host-deployer.sh --rollback             # backs up, starts the old colour, hands over, flips the proxy, checks
```

It reverses itself if the checks fail. It never touches the database. If the bad release changed the database in a non-expand-only way, see the wiki page "Database restore and blue/green rollback".

**Go back to a single server** (any time, also if step 6 misbehaves):

```sh
docker compose stop proxy server-blue server-green
docker compose rm -f proxy server-blue server-green
rm -f $D/state/soak
cp -p .env.before-bluegreen .env        # the COMPOSE_FILE and port lines as they were
docker compose up -d server
docker compose ps server
```

If you edited `.env` after the backup, copy those changes back by hand instead of the whole file. Keep `$D/proxy` or delete it; nothing reads it without the opt-in. The images `boss-man-server:blue` and `:green` can be removed with `docker image rm`.

**Checked on the real NAS (22 and 23 Oct 2026):**
- the bring-up and cutover commands (Docker Compose v2.32.3);
- `caddy validate` and `caddy reload`, and busybox `wget` inside the `caddy:2.11.7` container;
- runners reconnecting through the proxy without being recreated;
- the automatic switch-back during a failed swap;
- a full automatic swap from blue to green.

**Still UNVERIFIED:**
- the old colour being stopped by itself when the 15-minute soak ends;
- an automatic switch-back during the soak (only the one during the swap has been seen);
- whether the timeout defaults suit slower hardware.

## 10. Phone notifications (optional)

Boss Man pushes pages and asks to your phone through your own ntfy server, run on the same host. The steps are in [docs/31-phone-notifications.md](31-phone-notifications.md), which works on any Linux host. On TrueNAS, do section 10b first, and make the ntfy data folder under your dataset, for example `/mnt/tank/apps/boss-man/data/ntfy`.


## 10b. HTTPS through Tailscale Serve (tailnet only)

The steps are in [docs/20-https-tailscale.md](20-https-tailscale.md), which works on any Docker host. TrueNAS specifics:

- `COMPOSE_FILE` becomes `docker-compose.yml:deploy/truenas.yml:deploy/tailscale.yml`, and the state folder is `/mnt/tank/apps/boss-man/data/tailscale` (so create it there). Keep it in a dataset your snapshots cover.
- Use the sidecar, not the TrueNAS Tailscale app: the app cannot show that LAN traffic is kept apart from the trusted address.
- With blue/green (9d), follow "Blue/green installs" in [docs/20](20-https-tailscale.md#bluegreen-installs).

## 11. Feedback portal (optional)

Each company can have a public feedback portal (see `docs/07-feature-requests.md`). Turn it on under **Feedback > Feedback portal**, and tick **Show on the feedback portal** on the features people may vote on.

The server also has a port that serves only the portal. Inside the container it is 3101; on the NAS it is `BOSSMAN_PORTAL_HOST_PORT`. By default it's bound to the NAS itself (`127.0.0.1`), so nobody else can reach it. To give the portal its own port on your LAN, 3111 here, back up `.env` and set these (check the result with the `grep`):

```sh
cp -p .env .env.before-portal
setenv() { if grep -q "^$1=" .env; then sed -i "s#^$1=.*#$1=$2#" .env; else echo "$1=$2" >> .env; fi; }
setenv BOSSMAN_PORTAL_HOST_PORT 3111
setenv BOSSMAN_PORTAL_BIND <nas-ip>
setenv BOSSMAN_PORTAL_URL http://<nas-ip>:3111
grep -E '^BOSSMAN_PORTAL_' .env
```

`BOSSMAN_PORTAL_URL` is the portal's address as people reach it. The link to share under **Feedback > Feedback portal** uses it, so it points at the portal's own port rather than your owner UI.

**Behind a reverse proxy (optional).** If the portal is reached through a reverse proxy (Nginx Proxy Manager, Cloudflare, Caddy, Traefik), the portal only sees the proxy's address, so every visitor would share one limit (120 reads a minute, 40 writes an hour). `BOSSMAN_PORTAL_TRUSTED_PROXY` fixes that: a comma-separated list of the proxy's **own** addresses or CIDRs, for example `BOSSMAN_PORTAL_TRUSTED_PROXY=203.0.113.10, 10.0.0.0/8`. Only a connection from a listed address may say who the visitor is, by the right-most address in `X-Forwarded-For` that is not itself listed (most proxies add it). From any other address the headers are ignored. `BOSSMAN_PORTAL_CLIENT_HEADER` chooses the header: empty or `x-forwarded-for` (default), or `cf-connecting-ip`, which you set only when Cloudflare is the proxy that connects to the portal (Cloudflare sets it and removes any copy a visitor sent). Only the chosen header is read, because Nginx Proxy Manager, Caddy and Traefik pass a visitor-sent `CF-Connecting-IP` through unchanged and a visitor could then pick their own address and dodge the limits. A malformed header or list entry is ignored too (a `/0` entry is refused), and an empty setting (the default) means the connecting address is the visitor, as before. List only the proxy, never a range that includes the internet, and keep the portal port reachable only through the proxy. Worked example for a proxy container on the NAS's Docker network 172.16.0.0/12 in front of `192.168.1.50:3111`: `setenv BOSSMAN_PORTAL_TRUSTED_PROXY 172.16.0.0/12`, then recreate the server as below.

Then recreate the server so it picks up the new port (single-server install), and check it:

```sh
docker compose up -d server
curl -s -o /dev/null -w '%{http_code}\n' http://<nas-ip>:3111/portal.html
```

The second line should print `200`. With blue/green (9d), step 4 there sets the same lines and the proxy serves the portal on 3111.

To share it more widely, expose port 3111 only, never 3101 (your login), through a reverse proxy or Tailscale Funnel. `docs/07-feature-requests.md` explains what the portal does and doesn't let people do.
