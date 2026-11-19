# 23 — Read before you update

This page is for you if you installed Boss Man from this repository and want to move to newer code safely. Read [Breaking changes](#breaking-changes) first, then follow the steps for your install.

Boss Man has no numbered releases. An update moves your install to the newest commit on `main`.

## What you need first

You need:

- a root shell on the host, in the checkout folder (`<install-dir>/src` in [docs/00](00-first-time-install.md))
- a clean checkout on the default branch, because `scripts/deploy.sh` stops if there are uncommitted changes
- enough free disk for one more database backup

## 1. Check what has changed

1. Show the commit you are on and its date:

   ```sh
   git log -1 --date=short --format='%h %ad'
   ```

2. Fetch `main` and list every change since then. Each line is one merged change:

   ```sh
   git fetch origin main && git log --first-parent --oneline HEAD..origin/main
   ```

3. Read [Breaking changes](#breaking-changes) from the top down to the date from step 1. Do any hand step listed there when the entry says to.

## 2. Update the server

Every way of updating the server takes a database backup first. Database changes apply by themselves during the update. Each one is written so the previous code still runs against the new schema, which is why a code rollback works. The rules are in [docs/10-migrations.md](10-migrations.md).

- With the host deployer: approve the "Deploy <commit>?" card on Decisions. Settings → Server and runner → Updates shows the same offer under **Review and deploy**, or **Check for updates now** when there is none yet. Setting it up is in [docs/30-in-app-updates.md](30-in-app-updates.md).
- Single server, by hand: run `scripts/deploy.sh` from the checkout. It backs up, pulls, rebuilds, restarts, waits for the server to report healthy, and offers to update the runners if their code changed. Success is the line `The server is healthy.` Useful options:
  - `--dry-run` shows the steps without running anything.
  - `--force` rebuilds even when there is nothing new.
  - `--runner` or `--no-runner` forces or skips the runner update. `--yes` skips its question.
  - `--rollback` puts the previous commit back and rebuilds. It never touches the database.
- Blue/green: `scripts/deploy.sh` refuses to run. The host deployer swaps the colours for you. See [docs/06, 9d](06-install-truenas.md#9d-switch-to-bluegreen-optional).

The host deployer refuses changes to files that control how Boss Man runs or deploys: `deploy/`, the compose files, the deploy scripts and any `Dockerfile`. If an update contains one, apply it by hand. On a single server, run `scripts/deploy.sh`. On blue/green, follow "What the deployer will not do for you" in [docs/06, 9d](06-install-truenas.md#9d-switch-to-bluegreen-optional).

If the health check fails, the script changes nothing by itself and prints the commands to roll back. `scripts/deploy.sh --rollback` puts the previous commit back. It never touches the database.

## 3. The deployer script copies itself

Skip this step if you do not use the host deployer.

The host deployer runs from its own copy of `scripts/host-deployer.sh`. A change to that script is never deployed from the panel (it is what root runs), so you apply it by hand with `scripts/deploy.sh` as the card says. That deploy refreshes the copy by itself with `scripts/install-deployer.sh`: it writes the new file beside the old one, keeps the owner and mode, and renames it over, so the new version is used from the deployer's next run. You do not need to copy anything.

If the deploy output says "the deployer copy was not refreshed", or this is the first update that brings this feature in, the host's copy stays behind. Boss Man then puts a card on Decisions with the copy command for your folders, a check and an undo, and Settings → Server and runner → This server says "Deployer script: behind". Read the new script, then run the card's commands. The card closes by itself once the host runs the new copy.

Do not link to the checkout instead of copying. A link would let a merged change alter what root runs.

## 4. Update the runners

The runners need a new image after any change under `apps/runner/`, `apps/launcher/`, `apps/netguard/` or `packages/shared/`, or to `pnpm-lock.yaml`. They also need one roughly weekly, for new Claude Code releases. `scripts/deploy.sh` offers to do this when runner code changed.

To update the runners yourself, use Settings → Server and runner → Updates → Build and update runners, or run:

```sh
scripts/update-runner.sh
```

With the launcher, Boss Man drains first: nothing new starts and runs in progress finish. Each runner is then swapped when its company is idle. A banner shows on every page until every runner is on the new image, and then you get a notification. If runs are still going after 30 minutes (`BOSSMAN_DRAIN_MINUTES` in `.env`), you get one decision: stop them and update now, keep waiting, or cancel. Follow it in the status box at the top of Settings → Server and runner → Updates, which also has **Cancel the runner update**.

Without the host deployer, the script cannot ask Boss Man to drain, and says so. Start the swap yourself with **Update runners (finish runs first)** on the same Updates page.

- Undo a runner update: `scripts/update-runner.sh --rollback`.
- Emergency, restart every runner now and cut off runs in progress: `scripts/update-runner.sh --now`.

How the drain works is in [docs/09](09-self-deploy.md).

A runner update takes no backup. Runners hold no database.

**Check workers** on other hosts are not swapped by this update. A worker built from an older commit than the runner takes no checks (the Checks panel says "update this machine"), so update each one after the runners: see [docs/34](34-check-workers.md#update-a-worker). The "Runners updated" notification lists the workers and the steps.

## Backups

A server update always takes a backup first. `scripts/deploy.sh`, the host deployer and `scripts/rebuild-live.sh` each write one to the install folder, the folder above the checkout. The file is named `bossman-YYYY-MM-DD-HHMM.sql.gz`. `scripts/deploy.sh` keeps the newest 14. `BOSSMAN_BACKUP_DIR` and `BOSSMAN_BACKUP_KEEP` change the folder and the number.

Keep a copy of `secrets/master.key` on another machine. Boss Man encrypts stored secrets with this key, so a backup is no use without it.

### Check that a backup restores

Run this as root from the checkout. It loads the newest backup into a throwaway database beside the live one, counts accounts, projects and tickets, and then drops the throwaway. The live database is never written to.

```sh
scripts/restore-test.sh
```

Success is a line that starts with `OK: the backup restores`. Add `--fresh-backup` to take a new backup and test that one. Give a file name to test an older backup.

The script refuses to start unless the database volume has at least twice the live database's size free. It also competes with the live app for disk, so run it at a quiet time.

### If an update goes wrong

If the code is the problem, roll back the code with `scripts/deploy.sh --rollback`. Your data stays as it is.

### Restore the live database from a backup (last resort)

Restore the database only if an update has damaged the data itself. If the code is the problem, use `scripts/deploy.sh --rollback` (or `host-deployer.sh --rollback` on blue/green) instead: they never touch the data. A restore **replaces the live data** and loses everything written after the backup was taken. Do it at a quiet time, and ask for help if anything below does not look as described. Run every command as root from the checkout. The backups are in the folder above it.

1. Pick the backup and rehearse it on the throwaway database first (the live database is not written to). It must end with a line starting `OK:`. If it does not, stop and choose another file:
```sh
ls -lt ../bossman-*.sql.gz | head -5
```
```sh
scripts/restore-test.sh ../bossman-YYYY-MM-DD-HHMM.sql.gz
```
2. Note the data you will lose: the "live minus restored" column of that output, and the age on its `Backup:` line.
3. Stop the app so nothing writes. With a single server:
```sh
docker compose stop server
```
   With blue/green ([docs/06, 9d](06-install-truenas.md#9d-switch-to-bluegreen-optional)), stop both colours:
```sh
docker compose stop server-blue server-green
```
4. Keep a copy of the current, damaged data in case the restore was the wrong call (this file is a full copy of your data; delete it when you are sure):
```sh
docker compose exec -T db pg_dump -U bossman bossman | gzip > ../before-restore-$(date +%F-%H%M).sql.gz && ls -l ../before-restore-*.sql.gz
```
5. Replace the live database. The first command fails with "being accessed by other users" if something is still connected: go back to step 3 and do not continue.
```sh
docker compose exec -T db psql -U bossman -d postgres -c 'DROP DATABASE bossman' -c 'CREATE DATABASE bossman OWNER bossman'
```
```sh
gunzip -c ../bossman-YYYY-MM-DD-HHMM.sql.gz | docker compose exec -T db psql -v ON_ERROR_STOP=1 -q -U bossman -d bossman
```
6. Start the app. Single server:
```sh
docker compose up -d
```
   Blue/green: first bring the schema up to what the running code expects (a restored older backup may be behind), using the live colour (`blue` below; find it with `grep 'Live colour' <deployer-folder>/proxy/active.caddy`, where `<deployer-folder>` is the `BOSSMAN_DEPLOYER` value in `.env`), then start only that colour:
```sh
BOSSMAN_MIGRATE_TAG=blue docker compose run --rm --no-deps migrate
```
```sh
docker compose up -d --no-deps server-blue
```
   If the live colour is green, also run `docker compose kill -s SIGUSR2 server-green`; green starts as a standby and nothing is in charge until it gets that signal.
7. Check: `curl -s http://<host-ip>:<port>/api/ready` shows `"role":"leader"`; sign in and open Tickets; and compare the counts with the rehearsal output:
```sh
docker compose exec -T db psql -U bossman -d bossman -tA -c 'SELECT count(*) FROM tickets' -c 'SELECT count(*) FROM drizzle.__drizzle_migrations'
```
8. To undo the restore (step 4's copy holds the damaged state): repeat steps 3, 5 and 6 with `../before-restore-….sql.gz`.

If step 5's second command stops with an error, the new empty database is half filled: do not start the app. Repeat step 5 (it drops and recreates) with the same or an older backup.

## Breaking changes

Any change on `main` that needs a hand step when you update is listed here, newest first. The change that needs the step adds its entry in the same merge. Each entry gives the date it reached `main`, its merge commit, who it affects and what to do.

Steps 3 and 4 above are not repeated here, because they apply to many updates.

### 6 November 2026: the blue/green proxy compresses API responses (`6692f3e8`)

Affects: blue/green installs only.

The proxy's Caddyfile now compresses API responses. The host deployer refuses Caddyfile changes, so reload the proxy by hand after the update:

```sh
docker compose exec proxy caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile
```

If you skip it, nothing breaks. API responses stay uncompressed.

### 5 November 2026: blue/green gets a private "front" network (`de7c517e`)

Affects: blue/green installs set up before this date.

The proxy and the two server colours now share a private network, so the server sees each device's real address. Until you apply it, every device looks like the proxy, so the login attempt limit counts all devices together. The host deployer refuses this change. Apply it by hand, using the 6 steps in "The private front network" in [docs/06, 9d](06-install-truenas.md#9d-switch-to-bluegreen-optional). Those steps include copying the new deployer script.

### 3 November 2026: runners can no longer reach your home network (`86c5752e`)

Affects: installs that run their runners through the launcher.

Each runner now has a network guard. It refuses private network addresses, such as `192.168.x.x` and tailnet addresses, except for:

- the Boss Man server
- the DNS servers the host uses
- each company's registered tool servers
- each project's git host (since 6 November)

If agents need any other service on your home network or tailnet, list it in `.env`:

```sh
BOSSMAN_NETGUARD_ALLOW="host:port host:port"
```

Then apply it. This recreates the launcher so it reads `.env`, then recreates each runner once its company is idle:

```sh
scripts/update-runner.sh --settings
```

It needs the host deployer to ask Boss Man to wait for runs. Without one it says so and changes nothing; `scripts/update-runner.sh --settings --now` then applies it at once, cutting off runs in progress.

Settings → Server and runner lists the entries the launcher is using. How the guard works, and how to turn it off, is in [docs/27-netguard.md](27-netguard.md).

## Where release notes are

To see what changed, use these 3 sources:

- [CHANGELOG.md](../CHANGELOG.md), also on the website as "What's new": one dated entry per day, listing the changes a user would notice, in plain words
- the git history, as in step 1, where each merge line names one change
- the [Breaking changes](#breaking-changes) list on this page, for anything you need to do by hand

Boss Man's fuller release notes (what went live on its own server and when) are kept in a private wiki that only its maintainers can read.

## Common problems

`scripts/deploy.sh` stops with "There are uncommitted changes in the working tree". Run `git status` to see the changed files. Commit or discard them, then run the script again.

`scripts/deploy.sh` says "Nothing new to deploy". The checkout is already at the newest commit. Add `--force` only if you want to rebuild anyway.

The update card says "Main has moved to …" and does not deploy. The update changes a file the deployer refuses. Once you approve it, it leaves a to-do with the hand-apply steps. Apply it by hand, as in step 2, then answer the to-do **Done, it's applied**.
