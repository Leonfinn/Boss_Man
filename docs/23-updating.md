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

- Single server, by hand: run `scripts/deploy.sh`. It backs up, pulls, rebuilds, restarts and waits for the server to report healthy. Add `--dry-run` to see the steps first. Success is the line `The server is healthy.` The full description is in [docs/00, step 14](00-first-time-install.md#14-updating-later) and [docs/06, step 9](06-install-truenas.md#9-updates-and-checks).
- With the host deployer: approve the "Deploy <commit>?" card on Decisions, or use Settings → Server and runner → Updates → Deploy latest. Setting it up is in [docs/30-in-app-updates.md](30-in-app-updates.md).
- Blue/green: `scripts/deploy.sh` refuses to run. The host deployer swaps the colours for you. See [docs/06, 9d](06-install-truenas.md#9d-switch-to-bluegreen-optional).

The host deployer refuses changes to files that control how Boss Man runs or deploys: `deploy/`, the compose files, the deploy scripts and any `Dockerfile`. If an update contains one, apply it by hand. On a single server, run `scripts/deploy.sh`. On blue/green, follow "What the deployer will not do for you" in [docs/06, 9d](06-install-truenas.md#9d-switch-to-bluegreen-optional).

If the health check fails, the script changes nothing by itself and prints the commands to roll back. `scripts/deploy.sh --rollback` puts the previous commit back. It never touches the database.

## 3. The deployer script copies itself

Skip this step if you do not use the host deployer.

The host deployer runs from its own copy of `scripts/host-deployer.sh`. A good deploy (`scripts/deploy.sh`, or a blue/green swap by the deployer) now refreshes that copy by itself with `scripts/install-deployer.sh`: it writes the new file beside the old one, keeps the owner and mode, and renames it over, so the new version is used from the deployer's next run. You only need the hand copy below if the deploy output says "the deployer copy was not refreshed", or for the first update that brings this feature in. To check, set `D` to your deployer folder and compare the two copies:

```sh
cmp scripts/host-deployer.sh $D/host-deployer.sh
```

If `cmp` prints nothing, the copies are the same. If it prints a difference, read the new script, then copy it:

```sh
cp scripts/host-deployer.sh $D/host-deployer.sh && chown root:root $D/host-deployer.sh && chmod 750 $D/host-deployer.sh
```

Do not link to the checkout instead of copying. A link would let a merged change alter what root runs.

## 4. Update the runners

The runners need a new image after any change under `apps/runner/`, `apps/launcher/`, `apps/netguard/` or `packages/shared/`, or to `pnpm-lock.yaml`. They also need one roughly weekly, for new Claude Code releases. `scripts/deploy.sh` offers to do this when runner code changed.

To update the runners yourself, use Settings → Server and runner → Updates → Build and update runners, or run:

```sh
scripts/update-runner.sh
```

With the launcher, Boss Man drains first: nothing new starts and runs in progress finish. Each runner is then swapped when its company is idle. A banner shows on every page until every runner is on the new image, and then you get a notification. To undo, run `scripts/update-runner.sh --rollback`. The details are in [docs/06, step 9](06-install-truenas.md#9-updates-and-checks) and [docs/09](09-self-deploy.md).

A runner update takes no backup. Runners hold no database.

**Check workers** on other hosts are not swapped by this update. A worker built from an older commit than the runner takes no checks (the Checks panel says "update this machine"), so update each one after the runners: see [docs/26](26-check-workers.md#update-a-worker). The "Runners updated" notification lists the workers and the steps.

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

Restore the database only if an update has damaged the data itself. A restore replaces the live data and loses everything written since the backup. Follow "Restore the live database from a backup (last resort)" in [docs/06, step 9](06-install-truenas.md#9-updates-and-checks).

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

The launcher reads `.env` only when it is recreated. Recreate it, then recreate the runners. `--settings` waits for runs to finish:

```sh
docker compose up -d launcher && scripts/update-runner.sh --settings
```

Settings → Server and runner lists the entries the launcher is using. How the guard works, and how to turn it off, is in [docs/27-netguard.md](27-netguard.md).

## Where release notes are

There are no public release notes or changelog. Boss Man's own release notes are kept in a private wiki that only its maintainers can read.

To see what changed, use these 2 sources:

- the git history, as in step 1, where each merge line names one change
- the [Breaking changes](#breaking-changes) list on this page, for anything you need to do by hand

## Common problems

`scripts/deploy.sh` stops with "There are uncommitted changes in the working tree". Run `git status` to see the changed files. Commit or discard them, then run the script again.

`scripts/deploy.sh` says "Nothing new to deploy". The checkout is already at the newest commit. Add `--force` only if you want to rebuild anyway.

Deploy latest refuses an update. The update changes a file the deployer refuses. Apply it by hand, as in step 2.
