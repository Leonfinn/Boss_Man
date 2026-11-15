---
title: Updating and backups
description: Update the server and the runners, find your backups, check that one restores, and bring the database back if an update damaged it.
group: Set it up your way
order: 10
lead: Boss Man backs up its database before every update. This guide covers updating the server and the runners, where backups go, and how to restore one.
---

![What happens when you update: back up first, update, check it is healthy, and the way back if it is not.](/img/update-and-backup.svg =1160x820 narrow=/img/update-and-backup-narrow.svg:360x2380 "An update backs up first, then updates and checks. The way back for code and the way back for data are different.")

## Update the server

From the install folder, run:

```sh Run on the Linux machine, as root
cd $B/src && scripts/deploy.sh
```

The script backs up the database, pulls the code, rebuilds, restarts and waits for the server to report healthy. If the runners' code changed too, it asks whether to update them as well. Add `--dry-run` to see the steps without running them. A single server is down for about a minute while it restarts.

If there is nothing new, the script says "Nothing new to deploy" and stops before the backup, so no backup is made. Add `--force` to rebuild and restart anyway. It backs up first.

If the health check fails, the script prints the rollback commands and changes nothing by itself. `scripts/deploy.sh --rollback` puts the previous code back. It does not roll back the database.

## Update the runners

Update the runners about once a week, for new Claude Code releases:

```sh Run on the Linux machine, as root
cd $B/src && scripts/update-runner.sh
```

It builds a new runner image and checks it with networking off. If the check fails, the script says "The canary failed", and the runners keep the old image. If the check passes, the script also rebuilds the launcher, the part that starts each company's runner. Then the runners move to the new image:

- **With the host deployer set up** (see below), Boss Man stops starting new runs, lets the current ones finish, and swaps each company's runner when it is idle.
- **Without the host deployer**, the runners stay on the old image until you start the swap. Open **Settings > Server and runner**, find **Updates**, and choose **Update runners (finish runs first)**.
- **If no launcher is running**, the script restarts the runners at once. This cuts off any runs in progress.

Follow the swap in **Updates**, which also has **Cancel the update**. To undo, run `scripts/update-runner.sh --rollback`.

## Update from the web page (optional)

With the optional host deployer, you can update from Boss Man. The host deployer is a root script on the machine, run every minute by cron. Setting it up is in [`docs/06-install-truenas.md`](@repo/blob/main/docs/06-install-truenas.md), section 9a, and works on any Linux host.

Once it is set up:

- when the main branch moves, a card on Decisions asks whether to deploy, with **Deploy** and **Not now**
- **Settings > Server and runner > Updates** has **Deploy latest**, **Build and update runners** and **Restart the server**

**Deploy** and **Deploy latest** update the server only, never the runners. When an update changes the runners' code, the Deploy card says so, and Boss Man raises a second card later to update the runners. You can also choose **Build and update runners** yourself.

The host deployer will not apply changes to these files:

- Compose files (`docker-compose*.yml`)
- anything in `deploy/`, apart from the Penpot and ntfy files (see Guide 11)
- Dockerfiles
- `.env` files, `.npmrc` and `.dockerignore`
- the scripts `deploy.sh`, `rebuild-live.sh`, `update-runner.sh` and `host-deployer.sh`

Apply those by hand with `scripts/deploy.sh`.

## Where backups are kept

Backups go in the install folder, next to `src`, unless you set `BOSSMAN_BACKUP_DIR`. Only their owner can read them.

- `bossman-YYYY-MM-DD-HHMM.sql.gz`: made before each update, newest 14 kept
- `rebuild-YYYY-MM-DD-HHMM.sql.gz`: made by `scripts/rebuild-live.sh`
- `penpot-YYYY-MM-DD-HHMM.tar`: made by `scripts/backup-penpot.sh`

## Check a backup restores

```sh Run on the Linux machine, as root
cd $B/src && scripts/restore-test.sh --fresh-backup
```

It makes a new backup and loads it into a throwaway database. The live database is not touched. The last line must start with `OK:`. To test an older backup, give its file name instead of `--fresh-backup`.

## Restore the live database

Do this only when an update has damaged the data. A restore replaces the live data and loses everything written after the backup. If only the code is wrong, use `scripts/deploy.sh --rollback` instead, which never touches the data.

Run every command as root from `$B/src`. These steps are for a single-server install. For blue/green, follow [`docs/06-install-truenas.md`](@repo/blob/main/docs/06-install-truenas.md).

1. Test the backup you chose on the throwaway database with `scripts/restore-test.sh ../bossman-YYYY-MM-DD-HHMM.sql.gz`. The output must end with a line starting `OK:`. If it does not, choose another file.
2. Stop the server so nothing writes: `docker compose stop server`.
3. Keep a copy of the current data, in case the restore was the wrong call: `docker compose exec -T db pg_dump -U bossman bossman | gzip > ../before-restore-$(date +%F-%H%M).sql.gz`.
4. Replace the live database. First run `docker compose exec -T db psql -U bossman -d postgres -c 'DROP DATABASE bossman' -c 'CREATE DATABASE bossman OWNER bossman'`. If it says the database is "being accessed by other users", go back to step 2. Then run `gunzip -c ../bossman-YYYY-MM-DD-HHMM.sql.gz | docker compose exec -T db psql -v ON_ERROR_STOP=1 -q -U bossman -d bossman`.
5. Start Boss Man again: `docker compose up -d`.

## Keep the master key safe

`secrets/master.key` encrypts every secret Boss Man stores. Keep a copy off the machine. A database backup without the master key restores everything except your stored secrets.

## Export a company

**Settings > Import and export** downloads a company as `<company>.bossman.zip`, with its wiki and its open or all tickets if you choose. Secret values, logins, runs and costs are never exported. An import always makes a new company, with every agent paused and no secrets.
