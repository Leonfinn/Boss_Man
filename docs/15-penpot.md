# Penpot add-on (optional, off by default)

Penpot is a design tool. `deploy/penpot.yml` runs it as a separate set of containers that Boss
Man does not depend on. Nothing starts unless you ask for the `penpot` profile.

## Install (one paragraph)

In `.env` set `PENPOT_BIND` (the host's LAN address, never `0.0.0.0`), `PENPOT_PUBLIC_URI`
(`http://<that address>:9001`), `PENPOT_SECRET_KEY` (`openssl rand -base64 48`) and
`PENPOT_DB_PASSWORD` (`openssl rand -hex 24`); keep them out of git. Start it from the repo
root with `docker compose -f docker-compose.yml -f deploy/penpot.yml --profile penpot up -d`
(on TrueNAS add `-f deploy/truenas.yml` before it, as usual). To create the first accounts,
start once with `PENPOT_REGISTRATION=enable`, register, then remove that line and re-run the
same command so registration is off again. Turn on access tokens per user in Penpot's profile
settings. Web page: `http://<PENPOT_BIND>:9001`. Only that port is published; mailpit (8025),
the backend and the databases are internal.

## Check it

- Off by default: `docker compose -f docker-compose.yml -f deploy/penpot.yml ps` lists the same
  containers as `docker compose ps`.
- LAN only: `ss -ltn | grep -E ':(9001|8025)\b'` shows 9001 on the LAN address only, and
  nothing on 8025.

## Roll back

`docker compose -f docker-compose.yml -f deploy/penpot.yml --profile penpot down` (keeps the
data volumes), then delete `deploy/penpot.yml` and the `PENPOT_*` lines in `.env`. To also
delete Penpot's data (irreversible): add `-v` to `down`, only after a backup. Boss Man is not
affected. Backups: see the Penpot backup ticket (`scripts/backup-penpot.sh`, not yet built).
