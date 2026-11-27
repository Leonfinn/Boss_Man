# 35 — Install from ready-made images

This is the install that only needs Docker. Nothing is built on your machine, and nothing is needed on the host except Docker with the Compose plugin: no `openssl`, no `git`, no `sudo`, no `chown`, no source code. The images were built and signed by the Boss Man project and are pulled by their exact digest.

If you would rather build the images yourself from the source, use [docs/00-first-time-install.md](00-first-time-install.md) instead. Both installs work. Do not run both on one host under the same project name (`boss-man`).

> **Verification:** the compose file, the setup step, the launcher change and the release files were tested without a Docker daemon (a reader of the compose file, unit tests, a fake registry). The full install (pull, setup, start, a runner) is run by the *Install test* workflow on a real x86 and a real arm64 machine after each release. Until you see that workflow green for the release you are installing, treat the exact command output below as **unverified**. Per-host sections say what has and has not been tried.

## Before you start

You need:

- A **64-bit** machine (x86-64 or arm64) with **at least 4 GB of RAM**, and Docker Engine with Docker Compose v2 (`docker compose version` works).
- Internet access to your chosen registry, and to Anthropic if you use Claude Code (see "Claude Code" below).
- A browser on any computer that can reach the machine.

### Which platforms work

| | Platform |
|---|---|
| **Supported** | 64-bit Linux (a VM or bare metal) with Docker Engine, kernel 5.19 or newer. Kernel 6.12 or newer gives the full file fence. |
| **Preview** | Docker Desktop 4.60 or newer on macOS and Windows. Not yet proven on a real machine; expect rough edges. Docker Desktop's enhanced container isolation must be off, or the Boss Man images allowed. |
| **Not yet** | Podman, rootless Docker, Docker Desktop before 4.60, **Proxmox LXC containers** (use a full virtual machine), and **32-bit ARM** (Raspberry Pi OS 32-bit; use a 64-bit OS). |

On a setup that is not in the first list, Boss Man still refuses to run agents unless the network guard and the fence are proven on that machine, or you choose otherwise in Settings → Server and runner.

## 1. Get the files

Open the [release page of the Boss Man repository](https://github.com/Leonfinn/Boss_Man/releases) on GitHub, pick the version you want (the newest *Pre-release* is the beta), and download these into an empty folder:

- `docker-compose.images.yml`
- `images.env`

Both are made and signed by the release. `images.env` holds the registry and the exact digest of every image; do not edit the digests.

Optional: check the signature before you trust them. This needs [cosign](https://docs.sigstore.dev/cosign/installation/) and is the only step that does. Download `images.env.sigstore.json` and `docker-compose.images.yml.sigstore.json` from the same release page into the same folder, then run these two commands there, one for each file:

```
cosign verify-blob --bundle images.env.sigstore.json --certificate-oidc-issuer https://token.actions.githubusercontent.com --certificate-identity https://github.com/Leonfinn/Boss_Man/.github/workflows/release.yml@refs/heads/main images.env
```

```
cosign verify-blob --bundle docker-compose.images.yml.sigstore.json --certificate-oidc-issuer https://token.actions.githubusercontent.com --certificate-identity https://github.com/Leonfinn/Boss_Man/.github/workflows/release.yml@refs/heads/main docker-compose.images.yml
```

Each prints `Verified OK` when the file is the one the release signed.

## 2. Pick a registry

The images are the same bytes in every registry, so this only decides where Docker downloads them from.

- **GitHub's registry (`ghcr.io`) is the default** and the only one published today. It has no download limit for public images.
- **Docker Hub** is supported by the setting but is **not published yet**, so it is untested. When it is, you change one line in `images.env`:

  ```
  BOSSMAN_REGISTRY=docker.io/<namespace>
  ```

  Docker Hub limits anonymous downloads per IP address. If a pull fails with "toomanyrequests", run `docker login` with a free Docker Hub account and try again, or go back to `ghcr.io`: the digests are identical, so nothing else changes.

The database is the one image Boss Man does not publish: it is `pgvector/pgvector` from Docker Hub, pinned to a version. It is a normal Docker Hub download, so the anonymous limit above can apply to it even when everything else comes from `ghcr.io`. To take it from somewhere else, set `BOSSMAN_DB_IMAGE` in `images.env`.

## 3. Install

Run these in the folder with the two files.

1. Make the keys. This runs once and is safe to run again: it never replaces a file that exists.

   ```
   docker compose --env-file images.env -f docker-compose.images.yml run --rm setup
   ```

   It writes the master key into a Docker volume called `config` and the database password into a second one called `db-secret` (in a project named `boss-man`, they are `boss-man_config` and `boss-man_db-secret`). The database container gets only `db-secret`, so it never sees the master key. **Back up both volumes.** Without `master.key`, the secrets Boss Man stores cannot be read again, and without the database password the server cannot reach its database.

2. Start Boss Man. Compose starts only the database, a small proxy and the updater; the updater then downloads the server, launcher, runner and network-guard images by their digests and makes the server and the launcher itself, so the first start takes a few minutes longer than later ones:

   ```
   docker compose --env-file images.env -f docker-compose.images.yml up -d
   ```

3. Open `http://<this machine>:3100` and create the owner account. By default Boss Man listens only on the machine itself (`127.0.0.1`). To reach it from another computer, add `BOSSMAN_BIND=0.0.0.0` to `images.env` and run the start command in step 2 again, and keep the port off the internet. Logging in over plain `http://` on your home network also needs `BOSSMAN_INSECURE_COOKIES=1` in `images.env`; without it, login needs HTTPS.

Company data (workspaces, agent sessions) lives in Docker volumes created by Boss Man's launcher, not in a folder you choose. List them with `docker volume ls`.

### Updating to a new release

Nothing updates by itself. Take a release from Boss Man's own update screen: the updater checks the signed release, downloads every image of it by digest, backs up the database, switches the server over, watches it for 15 minutes (going back by itself if it fails), and then moves the rest of the release: it checks the new network guard, replaces the launcher once no run is starting (it waits up to 10 minutes; if a run is still starting it tries again later and says so on the screen), and removes the previous release's runner and guard images that no container uses any more. Runners that are working are not touched; each one moves to the new runner and guard when it next restarts, and until then keeps the guard it has, so nothing opens up. Your data and keys stay, because they are in volumes.

You do not run `docker compose pull` or `up -d` for a release any more, and you must not put an older `images.env` back over a running install: compose would start the older updater, which then moves itself forward to the release it recorded (it takes the release it last finished as the truth), but it is cleaner to leave the files alone. Do not run `setup` again; it is only for the first install (running it again is harmless, it keeps what exists).

The **Build and update runners** button in Settings builds images from source on the machine. It does not apply to this install, because there is no source here.

#### Moving an install made with an earlier compose file (server and launcher run by compose)

Until this change compose itself started the server and the launcher. An install like that is moved once, by hand: not confirmed on a real host yet, so follow it on a quiet day and keep the volumes.

1. Download the new `docker-compose.images.yml` and `images.env` from the release page into a new folder, and copy your own settings lines into the new `images.env`.
2. In the old folder stop and remove the old containers, keeping volumes (never add `-v`):

   ```
   docker compose --env-file images.env -f docker-compose.images.yml down
   ```

3. In the new folder start the new stack. The updater finds no server and no launcher, makes both from the release the new `images.env` pins (no backup or soak, nothing is serving), and the existing database, keys and company data are used as they are:

   ```
   docker compose --env-file images.env -f docker-compose.images.yml up -d
   ```

Runners keep their company data (it is in volumes); the new launcher picks them up by label and starts new ones as before.

### Back up two volumes

Back up `config` (the master key) and `db-secret` (the database password) after the first install, and keep the copies somewhere other than this machine. They are small. Keep them together with the database volume's backup: if you lose only `db-secret`, `setup` would make a new password, which the existing database refuses, and the server could not start. If that happens, restore `db-secret` from your backup. Without a backup the database password cannot be recovered, and the database volume would have to be recreated, which loses its data.

### Daily database backup, copy-off and restore (BOS-2817)

Compose runs a small `backup` service (the database's own image). Every 15 minutes it checks the newest `daily-*.sql.gz` file in the `backups` volume and, when that is over 24 hours old, makes a new one. It keeps the newest 14 (`BOSSMAN_BACKUP_KEEP` in `images.env` changes that), writes the time to Settings → Server, and so the "backup overdue" card closes by itself once the first backup exists (within about 15 minutes of the first start). The updater's own pre-update dumps (`bossman-*.sql.gz`, the last 3) live in the same volume and are never deleted by it. The files stay on this machine, so a disk that fails takes them too: copy them off.

An install made before this service existed gets it by downloading the new `docker-compose.images.yml` from the release page and running the start command again (section 3, step 2). Nothing else changes.

These commands use the default project name `boss-man`, so the volumes are `boss-man_config`, `boss-man_db-secret` and `boss-man_backups`. If you set `COMPOSE_PROJECT_NAME`, use that name instead. Run them in the folder with the two files. Not yet confirmed on a real host.

**Copy the two key volumes to a file** (the one-off tool image is the database image, which is already on this machine; if you changed `BOSSMAN_DB_IMAGE`, use that name):

```
docker run --rm -v boss-man_config:/from/config:ro -v boss-man_db-secret:/from/db-secret:ro -v "$PWD":/to pgvector/pgvector:0.8.7-pg17-bookworm tar czf /to/boss-man-keys.tgz -C /from .
```

**Copy the database backups to a folder** (needs the stack running):

```
docker compose --env-file images.env -f docker-compose.images.yml cp backup:/backups/. ./boss-man-backups
```

Move `boss-man-keys.tgz` and the `boss-man-backups` folder to another machine or an external disk. `boss-man-keys.tgz` holds the master key and the database password, so keep it as private as a password manager export. Keep the keys file together with the database backups from the same time.

**Restore onto a fresh install.** Install as in sections 1 and 2 on the new machine, but do not run step 5 (start) yet, and put your two copies in the folder. Then, one at a time:

1. Make the volumes with a new key (the next step replaces it):

   ```
   docker compose --env-file images.env -f docker-compose.images.yml run --rm setup
   ```

2. Put your saved keys over them:

   ```
   docker run --rm -v boss-man_config:/to/config -v boss-man_db-secret:/to/db-secret -v "$PWD":/from:ro pgvector/pgvector:0.8.7-pg17-bookworm tar xzpf /from/boss-man-keys.tgz -C /to
   ```

3. Start only the database. It makes its empty database with the restored password:

   ```
   docker compose --env-file images.env -f docker-compose.images.yml up -d db
   ```

4. Load the newest database file (replace the file name with yours from `boss-man-backups`):

   ```
   gunzip -c boss-man-backups/daily-2026-01-01-0300.sql.gz | docker compose --env-file images.env -f docker-compose.images.yml exec -T db psql -U bossman -d bossman
   ```

5. Start everything. The updater makes the server from the release `images.env` pins and migrates the restored data. Use the same release as the backup, or a newer one:

   ```
   docker compose --env-file images.env -f docker-compose.images.yml up -d
   ```

Then sign in with your old owner account. If step 4 says a table already exists, the database was not empty: stop, then follow "Start again from nothing" below and repeat from step 1.

### Settings

Add any of these to `images.env`, then run the start command again (section 3, step 2).

| Setting | What it does |
|---|---|
| `BOSSMAN_REGISTRY` | Where images are downloaded from (see section 2). |
| `BOSSMAN_DOCKER_SOCK` | The Docker socket on this machine. Default `/var/run/docker.sock`. Set it if your Docker's socket is somewhere else (for example Docker Desktop on macOS keeps one in your home folder). |
| `BOSSMAN_BIND`, `BOSSMAN_HOST_PORT` | Which address and port the web page uses. |
| `BOSSMAN_RUNNER_MEMORY` and the other `BOSSMAN_RUNNER_*` | Runner limits; see "Memory limits" in [docs/00-first-time-install.md](00-first-time-install.md). |

## Claude Code is downloaded from Anthropic on first start

The Boss Man runner image does not contain Claude Code. It is not ours to hand out, so the first time a runner starts, Boss Man downloads Claude Code from Anthropic (through the npm registry) and keeps it in a volume. Until that has finished, agents that use Claude Code wait, while OpenCode and Codex agents work as normal. This needs internet access from the machine. You still sign in with your own Claude subscription or API key, as in the first-time guide.

## Per-host notes

### Plain Linux

Install Docker Engine from Docker's own instructions, then follow sections 1 to 3. Nothing else is needed. Check the kernel with `uname -r` (5.19 or newer).

### Proxmox (a virtual machine)

Create a **virtual machine**, not an LXC container (LXC is not supported). Give it at least 4 GB of RAM and a 64-bit Linux with a kernel 5.19 or newer, install Docker Engine inside it, and follow sections 1 to 3 inside the VM. Take a Proxmox snapshot of the VM after setup; the `config` volume lives inside the VM's disk, so the snapshot covers it. This section has not been run on a real Proxmox host yet.

### TrueNAS SCALE

Use the machine's shell, in a **dataset-backed folder** for the two downloaded files, and follow sections 1 to 3. The compose file does not assume TrueNAS: it uses Docker volumes, which TrueNAS's Docker keeps in its own storage pool. TrueNAS SCALE versions differ in how they run Docker and Compose, so check `docker compose version` works first. For backups, snapshots and the self-update helper, the fuller worked example is [docs/06-install-truenas.md](06-install-truenas.md), which builds on the NAS. This section has not been run on a real TrueNAS machine for the image install.

### Docker Desktop (macOS, Windows) — preview

Follow sections 1 to 3 in a terminal. The launcher finds where Docker keeps its data volume inside Docker Desktop's own virtual machine, so no shared folders are needed. This has not been tried yet.

## If something goes wrong

- **`required variable BOSSMAN_REGISTRY is missing`**: you left out `--env-file images.env`.
- **The server cannot read `master.key`** or the database says its password file is missing: run step 1 first.
- **A pull is refused or "denied"**: the package may be private, or you hit Docker Hub's limit (section 2). Run `docker login` for that registry.
- **Start again from nothing** (this deletes everything, including your company data and keys): `docker compose --env-file images.env -f docker-compose.images.yml down -v`, then `docker rm -f launcher server-blue server-green updater` (the updater made those, so compose does not know them). Do not do this if you want to keep anything.
- **Go back to the build install**: stop this one with `docker compose --env-file images.env -f docker-compose.images.yml down` (without `-v`, so the volumes stay) and follow [docs/00-first-time-install.md](00-first-time-install.md) in a different folder. The two installs do not share data.

## What the install changes on your machine

Only Docker objects: containers, networks and volumes whose names start with `boss-man`. The launcher has access to the Docker socket (it starts one runner per company, from a fixed recipe), so treat the machine as dedicated to Boss Man. See [docs/20-netguard.md](20-netguard.md) for what keeps agents off your home network.

## Blue/green updates (the only way this install runs, since BOS-1227)

Compose holds the database, the daily `backup` service, a small Caddy `proxy` that owns the host ports and the name `server`, the `updater` and the one-shot `setup`. The updater makes `server-blue` (and later `server-green`) and the `launcher` itself, from the release `images.env` pins, and takes over from there. The updater swaps the server's two colours through the Docker API: it checks the signed release, backs up the database (the last 3 dumps stay in the `backups` volume), migrates while the old colour serves, starts the idle colour, hands over, moves the `server-live` alias on the private `front` network (the proxy dials it, so no file or reload is involved), watches for 15 minutes and switches back by itself if the new colour fails, then stops the old colour and keeps it as the standby. Going back to the standby's release needs no download; any other older release is refused. The updater replaces itself last, through a hand-over (`updater-next` must report in within 60 seconds, else it is removed and "Updater update failed" is recorded). Migrations must be expand-only so the old release runs on the new schema (docs/10-migrations.md). The first server and the launcher are made at the updater's first start with no backup and no soak. This has been tested against a fake Docker API only; **not yet confirmed on a real host** (the real-Docker proof runs in staging). The launcher is replaced one at a time: the new one is created, the old one stopped, the new one started and waited for; if it never becomes healthy it is removed and the old one starts again. Never delete the `backups` or `updater-state` volumes or remove the standby colour. Because compose no longer owns a server or launcher, `docker compose up -d` cannot bring an older one back; the updater, if compose starts it from an older digest than the release it recorded, moves itself forward again. `docker compose --env-file images.env -f docker-compose.images.yml down -v` (section "Start again from nothing") still deletes the volumes, and with them the updater's records.

## How the install is tested

`scripts/install-images.test.sh` reads the compose file and checks that every Boss Man image is named by digest, nothing is built, and the Docker socket is the only host path. With `INSTALL_RELEASE_JSON` set it does the real install on a machine with Docker. On every change, the CI `images` job (x86 and arm64 runners) builds the images, puts them in a local registry and runs the real install from them. The *Install test* workflow runs it again on x86 and arm64 against the published release files when a release finishes; it can also be started by hand (Actions → Install test → Run workflow, with the version). It times the run from the first command to `/api/health` answering and attaches `install-result.json` (date, version, pass or fail, minutes per architecture) to the release. A failed test marks the release: its title ends "(install test FAILED)" and its notes say so. `scripts/publish-site.sh` saves the newest release's file before it builds the website, and the install guide there shows "Last tested on (date) with (version), took (n) minutes"; with no result, or a failed one, it says so and never shows a pass. Details of how images are published and signed: [docs/25-published-images.md](25-published-images.md).
