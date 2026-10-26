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
LAN can sign up with any email): add `PENPOT_EXTRA_FLAGS=enable-registration` to `.env`, re-run
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
the `boss-man-penpot` project's containers and volumes; Boss Man is not affected. Backups: see the Penpot backup ticket (`scripts/backup-penpot.sh`, not yet built).
