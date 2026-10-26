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
always off. To create the first accounts, do it straight away (while it is on, anyone on the
LAN can sign up with any email): add `PENPOT_REGISTRATION=enable` to `.env`, re-run
the command, register, then **delete that line** (do not set it to another value) and re-run so
registration is off again. The admin console and the backend REPL are not deployed. The
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
data volumes), then delete `deploy/penpot.yml` and the `PENPOT_*` lines in `.env`. To also
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
Make a copy of `.env` called `.env.test` with `PENPOT_HOST_PORT=9101`, then:

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

## Agent access

Agents read files and attach PNG exports of boards through the `penpot` skill (`skills/penpot`), using an access token kept as a Boss Man secret. Owner setup steps: [16-penpot-agent-setup.md](16-penpot-agent-setup.md).
