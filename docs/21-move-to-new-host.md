# Move Boss Man to a new Docker host (BOS-276)

A step-by-step guide for moving a running Boss Man to another machine that runs Docker. It works for any Linux Docker host. The two marked notes at the end cover TrueNAS (the old host in the first real move) and Proxmox (the new one).

**The rule that keeps this safe:** only one host is live at a time, and the old host is never deleted or changed until you have used the new one for a while and said so. If anything goes wrong, you stop the new host and start the old one again.

Every command below comes from this repository's own scripts and docs. Anything that depends on the host's own tools (Proxmox, TrueNAS, the host's scheduler) is marked **Unconfirmed** with how to find out. Do not paste a host command into a root shell that this guide has not confirmed for your host.

Words used here: `$BOSSMAN_HOME` is the folder that holds Boss Man on a host. Inside it: `src/` (the checkout, with `.env` and `secrets/`), `data/` (`BOSSMAN_DATA`) and `deployer/` (the host deployer, `$D` in `docs/09-self-deploy.md`). Use any path you like; the old host's path and the new host's path do not need to match, but `.env` must agree with where you put things.

## 1. What moves, and how each piece is checked

| Piece | How it moves | Check on the new host |
|---|---|---|
| Database | `pg_dump` backup on the old host (a `bossman-*.sql.gz` file), loaded on the new host. Rehearsed first with `scripts/restore-test.sh` | Table counts and migration count equal the old host; `/api/ready` says `"role":"leader"` |
| `secrets/master.key`, `.env`, runner token files | Copied by hand (never through git, tickets or chat). Without `master.key` every stored credential is unreadable | Server starts; a test run works |
| Company data (`$BOSSMAN_DATA/companies`: workspaces, repo copies, Claude config) | Copy the folder, keep owner uid 1000 | A test run sees its workspace. Repo clones can be fetched again; **unpushed work inside a workspace cannot**, so agents are stopped before the copy |
| Legacy `app-co` data (only if you still use it) | Part of the same data folder | Same |
| Runner images | Built again on the new host, never copied | Runner health in Boss Man |
| Host deployer and its scheduled job | Recreated per `docs/09-self-deploy.md` | `status.json` is refreshed; a dry run works |
| Blue/green and Caddy | Recreate `$D/proxy/active.caddy` with the same live colour | The commit shown through the proxy equals the old host's |
| Tailscale state (BOS-242, `$BOSSMAN_DATA/tailscale`) | Copy the folder so the machine keeps its name; see `docs/20-https-tailscale.md` | Login over the `ts.net` address; certificate valid |
| ntfy data and tokens (BOS-241, `$BOSSMAN_DATA/ntfy` by default) | Part of `$BOSSMAN_DATA` | The test push reaches the phone |
| Penpot (only if you use it) | `scripts/backup-penpot.sh`, restore its database and assets | Open Penpot, see the project list |
| GitHub deploy access | The new host gets its **own new** deploy key; remove the old one at the end | `git ls-remote` works from the new host |

**Update (3 Nov 2026):** BOS-241 (ntfy) and BOS-242 (Tailscale) have both merged. The folders are confirmed on main: `$BOSSMAN_DATA/tailscale` (`deploy/tailscale.yml`) and `$NTFY_DATA`, default `$BOSSMAN_DATA/ntfy` (`deploy/ntfy.yml`). If you do not run Tailscale or ntfy, skip those rows.

**Two more checks for the new host:** (1) the live commit can be behind main, so check out the commit shown by Boss Man's server status, not just the main tip; (2) runners now filter network access per container (`docs/20-netguard.md`, which relies on Landlock), so confirm the new host's kernel supports what that page needs before you rely on it. On a Proxmox VM this is the guest kernel; how to check is on that page, and I have not verified it on your hardware.

## 2. Hard-coded host values that break on a new box

| Value | Where | What to do |
|---|---|---|
| `/mnt/NVME_Apps/Container_files/boss-man/{src,deployer}` in the "hand-apply" cards | `apps/server/src/services/self-deploy.ts` | **BOS-269** fixes the cards. Until it merges, a card that shows this path must be read as `$BOSSMAN_HOME/...` |
| The same path in the install guides | `docs/06-install-truenas.md`, `docs/09-self-deploy.md` | Left as the TrueNAS worked example; both now point here for any other host. They are marked as TrueNAS paths |
| `BOSSMAN_DATA` (default `/srv/boss-man/data`) | `docker-compose.yml`, launcher | Host-neutral. Set it in `.env` to a folder on the new host |
| `deploy/truenas.yml`, `deploy/truenas-deployer.yml`, `deploy/truenas-bluegreen.yml` | `deploy/`, and `scripts/deploy.sh` and `scripts/host-deployer.sh` match on the file names | **Generic despite the names:** they bind-mount the data folder, add the deployer mounts, and add blue/green. Use them unchanged on any host. Renaming would break a live `COMPOSE_FILE`, so it is a follow-up ticket (rename with the old names kept working) |
| "TrueNAS cron job" for the deployer | `docs/09-self-deploy.md`, `scripts/host-deployer.sh` header | The script needs only bash, git, docker, flock and curl. The one-minute scheduler is whatever the new host has. **Unconfirmed** for each host: find out with `systemctl --version` (systemd timer) or `command -v crontab` (cron) |
| `192.168.68.67` | A comment in `docker-compose.yml` (now `<host-ip>`), the wiki restore runbook and `.env` values `BOSSMAN_BIND` and `BOSSMAN_PORTAL_URL` | `.env` values **must be changed** to the new host's address. Other hits are test data and examples (`packages/shared/test`, `git-host.ts` comment) and need no change |
| `BOSSMAN_DOCKER_GID` | `.env` | Differs per host. Find it on the new host with `stat -c %g /var/run/docker.sock` |
| `PENPOT_BIND`, `PENPOT_PUBLIC_URI` | `.env`, `deploy/penpot.yml` | Host addresses; must be changed if Penpot moves |
| Edge network `172.30.0.0/29` and `172.30.0.2` | `deploy/tailscale.yml` (BOS-242) | The only fixed subnet in the repo. Overridable with `BOSSMAN_EDGE_SUBNET` / `BOSSMAN_EDGE_IP`. Check it is free on the new host (step 3 in `docs/20-https-tailscale.md`). No other compose file sets a fixed subnet or address |
| Docker's default address pools | The host, not the repo | Can clash with a LAN or VPN range. **Unconfirmed**; find out with `docker network ls -q \| xargs docker network inspect --format "{{.Name}} {{range .IPAM.Config}}{{.Subnet}} {{end}}"` and `ip -4 route` |
| TrueNAS-only install guide | `docs/06-install-truenas.md` | This guide is the host-neutral move guide; `docs/00-first-time-install.md` is the host-neutral first install |

The grep behind this list searched the repo for `NVME_Apps`, `192.168.`, `truenas`, `subnet` and `ipam` (31 Oct 2026). The app's own code has no host-specific path other than the BOS-269 cards.

## 3. The order of the move

Downtime is only steps 3 to 5, about 30 to 60 minutes, mainly the final data copy. It grows with the size of `$BOSSMAN_DATA`. On 27 Oct a 155 MB database backed up to 27 MB and restored in 5 seconds.

1. **Prepare the new host** (no downtime; the old host is not touched). Docker and the Compose plugin, git, flock, curl. A new deploy key. A checkout at the same commit as the old host. Folders owned by uid 1000. A `.env` adapted for the new host. Images built.
2. **Rehearse** (no downtime). Copy a normal backup over and run `scripts/restore-test.sh` on the new host. This proves the restore path before the real cut.
3. **Final backup and stop** (downtime starts). Pause agents and wait for runs to finish. Stop the deployer's scheduled job. Take the final backup and copy the data. Stop Boss Man and Tailscale on the old host. They stay installed and stoppable.
4. **Restore and check** on the new host. Load the backup, copy the data, secrets and Tailscale/ntfy folders, start the stack, compare counts and the commit.
5. **Switch over.** Start Tailscale with the moved state, update the address you use (bookmarks, phone app, ntfy subscription, `BOSSMAN_PORTAL_URL`, any webhook that points at the old address). Boss Man then checks: server status, live commit, runner health, a test run, login over `ts.net`, an ntfy test push.
6. **Retire the old host** only after you sign off, after a trial period you choose.

**Rollback until step 6:** stop Boss Man and Tailscale on the new host, start them on the old host. The old host's data is exactly as it was at step 3. Anything written on the new host after the switch is lost unless you take a backup there first and load it back on the old host; the switch-over stage says so when it asks you.

## 4. The commands

Run all commands as root in the checkout (`$BOSSMAN_HOME/src`) unless a step says otherwise. They are the repository's own commands; paths in angle brackets are yours.

### Stage 1: prepare the new host

Install Docker with the Compose plugin and git, flock and curl using the host's own instructions. **Unconfirmed per host**; find out the supported way from Docker's install page for your distribution, then check:

```sh
docker compose version
```

```sh
git --version && flock --version | head -1 && curl --version | head -1
```

Make a deploy key for this host (separate from the old host's), add it as a read-only deploy key in the GitHub repository settings, then clone. The key steps are `docs/06-install-truenas.md` step 2; use `$BOSSMAN_HOME` for the folder.

Check the Docker socket group, for `BOSSMAN_DOCKER_GID` in `.env`:

```sh
stat -c %g /var/run/docker.sock
```

Make the folders and give the data to uid 1000 (compare `docs/06` step 3 and 7b):

```sh
mkdir -p "$BOSSMAN_HOME/data/postgres" "$BOSSMAN_HOME/data/companies" "$BOSSMAN_HOME/src/secrets"
```

```sh
chown -R 1000:1000 "$BOSSMAN_HOME/data/companies" "$BOSSMAN_HOME/src/secrets" && chmod 700 "$BOSSMAN_HOME/src/secrets"
```

Write `.env` by copying the old host's and changing only: `BOSSMAN_DATA`, `BOSSMAN_BIND`, `BOSSMAN_PORTAL_URL`, `BOSSMAN_DOCKER_GID`, `PENPOT_*` if used. Keep `POSTGRES_PASSWORD` the same as the old host's. Do not start the stack yet.

Build the images (same as `docs/06` step 5):

```sh
docker compose build server launcher
```

### Stage 2: rehearse the restore

Copy any recent `bossman-*.sql.gz` from the old host's backup folder to the new host's folder above `src/`. Start only the database, then rehearse:

```sh
docker compose up -d db
```

```sh
scripts/restore-test.sh ../bossman-YYYY-MM-DD-HHMM.sql.gz
```

It must end with a line starting `OK:`. The script was written to compare the restored copy with a live database (`bossman`) in the same Postgres. On a brand-new host that database is empty or missing, so the "live minus restored" column means nothing there, and the script may stop early. **Unconfirmed on a fresh host:** if it stops with an ERROR before restoring, the rehearsal cannot be done here; skip to stage 3 and rely on the old host's proven 27 Oct result and the count comparison in stage 4. Details: wiki `runbooks/database-restore-and-bluegreen-rollback`, section 1.

### Stage 3: final backup and stop (on the OLD host)

1. In Boss Man, pause the agents and wait until no run is in progress. Stop the deployer's scheduled job in whatever scheduler the host uses (**Unconfirmed per host**).
2. Take a backup and write down its table counts:

```sh
docker compose exec -T db pg_dump -U bossman bossman | gzip > ../bossman-final-$(date +%F-%H%M).sql.gz
```

3. Copy the backup, `secrets/`, `.env` and `$BOSSMAN_DATA` (without `postgres/`, which is rebuilt from the dump) to the new host. Use the tool you trust (`rsync -a` keeps owners and times; **Unconfirmed**: check it is installed with `command -v rsync`). Compare checksums of `master.key` and the backup on both sides:

```sh
sha256sum secrets/master.key ../bossman-final-*.sql.gz
```

4. Only when the checksums match, stop Boss Man and Tailscale on the old host. Do not delete anything:

```sh
docker compose stop
```

### Stage 4: restore and check (on the NEW host)

Follow `runbooks/database-restore-and-bluegreen-rollback` section 2, steps 4 to 6, using the final backup (there is no running writer to stop on a fresh host). Then start the stack and compare:

```sh
docker compose up -d
```

```sh
curl -s http://<host-ip>:3101/api/ready
```

It must show `"role":"leader"`. Ticket and migration counts must equal the numbers you wrote down in stage 3.

### Stage 5: switch over

With Tailscale state copied, `docker compose up -d tailscale server` brings the same machine name up (`docs/20-https-tailscale.md`, "Backing up and moving to a new host"). Update the addresses you use. Then the checks listed in step 5 of section 3 run from Boss Man.

### Stage 6: retire the old host

After your sign-off: remove the old deploy key from GitHub, delete the old host's machine from the Tailscale admin console if it shows twice, and decommission the old host with the host's own tools (**Unconfirmed per host**).

## 5. Host notes

### TrueNAS (the old host)

- Paths in `docs/06-install-truenas.md` and `docs/09-self-deploy.md` are the owner's TrueNAS layout, `/mnt/NVME_Apps/Container_files/boss-man`.
- Keep the old host's datasets until sign-off; a dataset snapshot taken at stage 3 is a cheap extra safety net (**Unconfirmed**: how snapshots are taken is TrueNAS's own UI; see the TrueNAS documentation).
- The deployer's scheduler on TrueNAS is a cron job in the TrueNAS UI; stop it there at stage 3.

### Proxmox (the new host)

- **Recommendation: a VM, not an LXC container.** Boss Man mounts the Docker socket and starts runner containers that run agent code. A VM has its own kernel, so Docker uses normal overlay2 storage, nothing depends on LXC nesting or AppArmor, and agent code stays behind a hardware boundary. Tailscale needs no special device (this repository runs it in userspace mode).
- **If you choose an LXC container anyway,** each of these must be proven before the move, not assumed: nesting turned on in the container's options, a working Docker storage driver on the backing store, owner mapping so uid 1000 bind mounts work, and Tailscale in userspace mode (already the default in `deploy/tailscale.yml`; `/dev/net/tun` is then not needed). Prove it with `docker run --rm hello-world` and a Boss Man test run inside it.
- **Unconfirmed:** how to create the VM or container, which options to set, and how Proxmox backups are scheduled. Find out in the Proxmox web interface help (the **Help** button) and the Proxmox documentation. Report what you see on the ticket; no Proxmox command is given here on purpose.
- A Proxmox backup of the VM is an extra safety net. It does not replace the Postgres dump, which is what this guide restores.
- After the move, the guest is an ordinary Linux host: stages 1 to 6 above apply as written.
