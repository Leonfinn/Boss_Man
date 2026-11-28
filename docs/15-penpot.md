# Penpot add-on (optional, off by default)

Penpot is a design tool. `deploy/penpot.yml` runs it as a separate set of containers that Boss
Man does not depend on. Nothing starts unless you ask for the `penpot` profile.

## Install (one paragraph)

In `.env` set `PENPOT_BIND` (the host's LAN address, never `0.0.0.0`), `PENPOT_PUBLIC_URI`
(`http://<that address>:9001`), `PENPOT_SECRET_KEY` (`openssl rand -base64 48`) and
`PENPOT_DB_PASSWORD` (`openssl rand -hex 24`); keep them out of git. Start it from the repo
root as its own Compose project with
`docker compose -p boss-man-penpot --env-file .env -f deploy/penpot.yml --profile penpot up -d` (no Boss Man or
TrueNAS `-f` files). Never add `deploy/penpot.yml` to `COMPOSE_FILE`: its required variables
would make every compose command on the host, including the deployer, fail. Registration is
off by default. To create the first accounts, do it straight away (while it is on, anyone on the
LAN can sign up with any email): add `PENPOT_REGISTRATION=enable` to `.env`, re-run
the command, register, then **delete that line** (do not set it to another value) and re-run so
registration is off again. On a LAN where you trust everyone you can instead leave the line in, so people can sign themselves up. The admin console and the backend REPL are not deployed. The
air-gapped setting is on, so there is no Google Fonts picker and no templates gallery, and the
Penpot container makes no outbound calls for them. Turn on access tokens per user in Penpot's profile
settings. Web page: `http://<PENPOT_BIND>:9001`. Only that port is published; mailpit (8025),
the backend and the databases are internal.

## Check it

- Off by default: Boss Man's `docker compose ps` is unchanged, and
  `docker compose -p boss-man-penpot --env-file .env -f deploy/penpot.yml ps` (with the `PENPOT_*` values in
  `.env`) lists nothing until you start the profile.
- LAN only: `ss -ltn | grep -E ':(9001|8025)\b'` shows 9001 on the LAN address only, and
  nothing on 8025.

## Roll back

`docker compose -p boss-man-penpot --env-file .env -f deploy/penpot.yml --profile penpot down` (keeps the
data volumes), then delete the `PENPOT_*` lines in `.env`. Leave `deploy/penpot.yml` in place: it is part of the checkout, and deleting it makes `scripts/deploy.sh` refuse to run because of the uncommitted change. To also
delete Penpot's data (irreversible): add `-v` to `down`, only after a backup. This only touches
the `boss-man-penpot` project's containers and volumes; Boss Man is not affected.

## Back up and restore

`scripts/backup-penpot.sh` (run as root on the host, e.g. from cron) writes
`penpot-YYYY-MM-DD-HHMM.tar` into the same folder as Boss Man's `bossman-*.sql.gz` backups
(`BOSSMAN_BACKUP_DIR`) and keeps the newest `BOSSMAN_BACKUP_KEEP` (14) of its own; it never
deletes Boss Man's files. It holds `penpot-db.sql.gz` (Penpot's database) and
`penpot-assets.tar.gz` (uploaded images and files). If Penpot isn't running it says so and
exits 0. The archive is readable by its owner only (mode 600). A second run in the same minute
does nothing. `.env` is not in the archive: keep a private copy of
`PENPOT_SECRET_KEY` and `PENPOT_DB_PASSWORD`.

Restore to a throwaway copy first (another project name and port, so the live one is untouched).
Make a copy of `.env` called `.env.test` with `PENPOT_HOST_PORT=9101` and `PENPOT_PUBLIC_URI` changed to port 9101 (otherwise logging in to the copy sends you to the live one), then:

1. `export P=pp-test C="docker compose -p pp-test --env-file .env.test -f deploy/penpot.yml --profile penpot"`
2. Unpack: `mkdir /tmp/pp && tar -C /tmp/pp -xf <backup folder>/penpot-<date>.tar`
3. Create the volumes, then start only the database: `$C create && $C up -d penpot-postgres`
4. Load it: `gunzip -c /tmp/pp/penpot-db.sql.gz | $C exec -T penpot-postgres psql -U penpot penpot`
5. Load the files: `docker run --rm -v ${P}_penpot_assets:/assets -v /tmp/pp:/in:ro --entrypoint tar postgres:15 -C /assets -xzf /in/penpot-assets.tar.gz`
6. Start the rest: `$C up -d`. Open `http://<PENPOT_BIND>:9101`, log in with an existing account and open a file.
7. Remove the copy: `$C down -v`, then `rm -r /tmp/pp .env.test`.

To restore over the live Penpot: `down` (without `-v`), remove the `boss-man-penpot_penpot_postgres_v15`
volume (only after the backup is confirmed good), then follow steps 2 to 6 with the real project
name and `.env`.

## Image install (no source folder)

Status: **not yet confirmed on a real host** (the file passes Compose's own validation; nobody has run these steps on an image install yet, 28 Nov 2026). For an install made from ready-made images ([docs/35](35-install-from-images.md)). The same Penpot file comes with each release as `penpot.yml`, signed like the others (`penpot.yml.sigstore.json` is next to it). Run everything in the folder with `images.env`. It does not need openssl.

1. Download the file of the same release you installed (the same `$V` as in docs/35, section 1):

   ```
   V=$(curl -fsS https://api.github.com/repos/Leonfinn/Boss_Man/releases | grep -m1 '"tag_name"' | cut -d '"' -f 4) && curl -fsSLO https://github.com/Leonfinn/Boss_Man/releases/download/$V/penpot.yml
   ```

2. Make the secret key. It prints one line:

   ```
   docker run --rm busybox sh -c 'head -c 48 /dev/urandom | base64 | tr -d "\n="; echo'
   ```

3. Make the database password. It prints one line:

   ```
   docker run --rm busybox sh -c 'head -c 24 /dev/urandom | od -An -tx1 | tr -d " \n"; echo'
   ```

4. Add four lines to `images.env`: the two lines you made, and this machine's address on your network (never `0.0.0.0`; `192.168.1.20` is an example):

   ```
   PENPOT_SECRET_KEY=<line from step 2>
   PENPOT_DB_PASSWORD=<line from step 3>
   PENPOT_BIND=192.168.1.20
   PENPOT_PUBLIC_URI=http://192.168.1.20:9001
   ```

5. Start it, as its own project:

   ```
   docker compose -p boss-man-penpot --env-file images.env -f penpot.yml --profile penpot up -d
   ```

Registration and checks are as above, with `--env-file images.env -f penpot.yml` in place of `--env-file .env -f deploy/penpot.yml`.

**A week on.** Nothing to repeat: it restarts with Docker and Boss Man updates do not touch it. To update Penpot, download the new release's `penpot.yml` (step 1) and run step 5 again. Stop it with the step 5 command ending `--profile penpot down` (never add `-v`: it deletes Penpot's data).

**Backup.** `scripts/backup-penpot.sh` is not part of an image install. By hand, in the folder with `images.env`, write the database to a file (keep it somewhere other than this machine, with a private copy of `PENPOT_SECRET_KEY` and `PENPOT_DB_PASSWORD`):

```
docker compose -p boss-man-penpot --env-file images.env -f penpot.yml exec -T penpot-postgres pg_dump -U penpot penpot | gzip > penpot-db.sql.gz
```

And the uploaded files (the volume is named `boss-man-penpot_penpot_assets`):

```
docker run --rm -v boss-man-penpot_penpot_assets:/assets:ro -v "$PWD":/out busybox tar -C /assets -czf /out/penpot-assets.tar.gz .
```

Both commands are not yet confirmed on a real host and have not been restored; restore into a throwaway copy before you rely on them (the steps above use the same two file names).

## Agent access

Agents read files and attach PNG exports of boards through the `penpot` skill (`skills/penpot`), using an access token kept as a Boss Man secret. Owner setup steps: [16-penpot-agent-setup.md](16-penpot-agent-setup.md).
