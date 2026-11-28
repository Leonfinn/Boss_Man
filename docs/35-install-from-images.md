# 35 — Install from ready-made images

This is the install that only needs Docker. Nothing is built on your machine, and nothing is needed on the host except Docker with the Compose plugin: no `openssl`, no `git`, no `sudo`, no `chown`, no source code. The images were built and signed by the Boss Man project and are pulled by their exact digest.

If you would rather build the images yourself from the source, use [docs/00-first-time-install.md](00-first-time-install.md) instead. Both installs work. Do not run both on one host under the same project name (`boss-man`).

> **Verification:** the *Install test* workflow runs the full install (pull, setup, start, a runner) on a clean x86 and a clean arm64 machine after each release; 0.1.0-beta.3 passed on both on 26 Nov 2026, in under a minute of machine time. A person installed 0.1.0-beta.3 this way on plain x86 Linux on 27 Nov 2026 (it worked once `-f docker-compose.images.yml` was added to the commands). arm64 by a person, Proxmox, TrueNAS and Docker Desktop are not yet confirmed; the per-host sections say so.

Allow about 5 minutes of your own time once Docker is installed. The first page can take a few minutes to answer after the start command, which is normal.

## Before you start

You need:

- A **64-bit** machine (x86-64 or arm64) with **at least 4 GB of RAM**, running Linux. Docker Engine with Docker Compose v2; "Install Docker" below installs it.
- Internet access from that machine.
- A Claude account (a Pro or Max plan, or an Anthropic API key) for the first start: the CEO is a Claude Code agent. Other AI providers can be added later, under Settings → Secrets.
- A GitHub or Gitea account, only if your agents will work on code. A team that works on documents and research does not need one.
- A browser on any computer that can reach the machine.

### Open a terminal on the machine

Every command here runs in a terminal on the machine that will run Boss Man.

- From a laptop: open Terminal (macOS) or PowerShell (Windows) and connect over SSH with the user name and address you gave the machine (for example `ssh alex@192.168.1.20`). The first time, type `yes` to trust the machine, then its password.

  ```
  ssh <your user name>@<host-ip>
  ```

- TrueNAS SCALE: **System → Shell** in its web page (a root shell).
- Proxmox: the virtual machine's **Console** in the Proxmox web page, or SSH as above.

### Install Docker

TrueNAS SCALE 24.10 or newer already has Docker; skip this. Elsewhere, check first:

```
docker compose version
```

If it prints `Docker Compose version` and a number, Docker is installed. If it says `command not found`, install it on Ubuntu or Debian (a server, or a Proxmox VM) with Docker's own install script, the same steps as Docker's [Ubuntu](https://docs.docker.com/engine/install/ubuntu/) and [Debian](https://docs.docker.com/engine/install/debian/) pages:

```
sudo apt-get update && sudo apt-get install -y curl
curl -fsSL https://get.docker.com -o get-docker.sh
sudo sh get-docker.sh
sudo usermod -aG docker $USER
```

The last line lets you run Docker without `sudo`; it takes effect at your next login, so type `exit` and open the terminal again. Then `docker compose version` prints a version.

### Which platforms work

| | Platform |
|---|---|
| **Supported** | 64-bit Linux (a VM or bare metal) with Docker Engine, kernel 5.19 or newer. Kernel 6.12 or newer gives the full agent fence. |
| **Preview** | Docker Desktop 4.60 or newer on macOS and Windows. Not yet proven on a real machine; expect rough edges. Docker Desktop's enhanced container isolation must be off, or the Boss Man images allowed. |
| **Not yet** | Podman, rootless Docker, Docker Desktop before 4.60, **Proxmox LXC containers** (use a full virtual machine), and **32-bit ARM** (Raspberry Pi OS 32-bit; use a 64-bit OS). |

On a setup that is not in the first list, Boss Man still refuses to run agents unless the network guard and the agent fence are proven on that machine, or you choose otherwise in Settings → Server and runner.

## 1. Get the files

Make a folder and go into it:

```
mkdir -p ~/boss-man && cd ~/boss-man
```

On TrueNAS, make it on a dataset instead. The first line lists your storage pools; put one pool's name where the second says `<your pool>`:

```
cd /mnt && ls
mkdir -p <your pool>/boss-man && cd <your pool>/boss-man
```

Then find the newest release (the first line prints its tag, such as `v0.1.0-beta.3`; the same list is on the [release page](https://github.com/Leonfinn/Boss_Man/releases)) and download its two files, `docker-compose.images.yml` and `images.env`:

```
V=$(curl -fsS https://api.github.com/repos/Leonfinn/Boss_Man/releases | grep -m1 '"tag_name"' | cut -d '"' -f 4) && echo $V
curl -fsSLO https://github.com/Leonfinn/Boss_Man/releases/download/$V/docker-compose.images.yml
curl -fsSLO https://github.com/Leonfinn/Boss_Man/releases/download/$V/images.env
```

The API lists releases newest first, pre-releases included (GitHub's `releases/latest` link skips pre-releases, so it does not work while every release is a beta). Both files are made and signed by the release. `images.env` holds the registry and the exact digest of every image; do not edit the digests.

Optional: check the signature before you trust them. This needs [cosign](https://docs.sigstore.dev/cosign/installation/) and is the only step that does. Download the two signature files of the same release into the same folder:

```
curl -fsSLO https://github.com/Leonfinn/Boss_Man/releases/download/$V/images.env.sigstore.json
curl -fsSLO https://github.com/Leonfinn/Boss_Man/releases/download/$V/docker-compose.images.yml.sigstore.json
```

Then run these two commands there, one for each file:

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

2. If Boss Man is on a server or NAS, do this step. By default Boss Man listens only on the machine itself (`127.0.0.1`), so another computer cannot open it. This adds `BOSSMAN_BIND=0.0.0.0` (the page on every address of the machine) and `BOSSMAN_INSECURE_COOKIES=1` (login over plain `http://` on your home network; without it, login needs HTTPS) to the end of `images.env`, with no text editor. Keep the port off the internet.

   ```
   printf '\nBOSSMAN_BIND=0.0.0.0\nBOSSMAN_INSECURE_COOKIES=1\n' >> images.env
   ```

   `tail -2 images.env` then prints the two lines.

3. Start Boss Man. Compose starts only the database (`db`), a small `proxy` and the `updater`; the updater then downloads the server, launcher, runner and network-guard images by their digests and makes the server and the launcher itself, so the first start takes a few minutes, which is normal:

   ```
   docker compose --env-file images.env -f docker-compose.images.yml up -d
   ```

   **It worked if** this lists `boss-man-db-1`, `boss-man-proxy-1` and `updater` at once, and `server-blue` and `launcher` within a few minutes, each with a status starting `Up`. Compose's own `ps` lists only the first three: the updater makes the other two, so compose does not know them.

   ```
   docker ps --filter label=com.bossman.install=boss-man --format '{{.Names}}  {{.Status}}'
   ```

   Then this prints a short line of JSON starting `{"ok":true`:

   ```
   curl -sS http://127.0.0.1:3100/api/health
   ```

   If `server-blue` or `launcher` has not appeared after 10 minutes, the updater's log says what it is waiting for:

   ```
   docker compose --env-file images.env -f docker-compose.images.yml logs --tail 30 updater
   ```

   The x86 install on 27 Nov 2026 showed `boss-man-db-1`, `boss-man-proxy-1` and `updater` up after 4 minutes, and `/api/health` answered with `"ok":true` and `"colour":"blue"`.

4. Find the machine's address and create the owner account. This prints the machine's addresses; use the first (usually `192.168.…` or `10.…`; the `172.…` ones belong to Docker):

   ```
   hostname -I
   ```

   Open `http://<that address>:3100` in a browser, for example `http://192.168.1.20:3100`, and create the owner account.

Company data (workspaces, agent sessions) lives in Docker volumes created by Boss Man's launcher, not in a folder you choose. List them with `docker volume ls`.

### Updating to a new release

Nothing installs by itself: Boss Man tells you about a new release (docs/23, "How you are told about a new release") and you press **Install** in Settings → Server and runner → Updates. Take a release from Boss Man's own update screen: the updater checks the signed release, downloads every image of it by digest, backs up the database, switches the server over, watches it for 15 minutes (going back by itself if it fails), and then moves the rest of the release: it checks the new network guard, replaces the launcher once no run is starting (it waits up to 10 minutes; if a run is still starting it tries again later and says so on the screen), and removes the previous release's runner and guard images that no container uses any more. Runners that are working are not touched; each one moves to the new runner and guard when it next restarts, and until then keeps the guard it has, so nothing opens up. Your data and keys stay, because they are in volumes.

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

### Settings

Add any of these to `images.env`, then run the start command again (section 3, step 3).

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

On Ubuntu or Debian, install Docker with the lines under "Install Docker" above, then follow sections 1 to 3. Nothing else is needed. Check the kernel with `uname -r` (5.19 or newer). Confirmed on plain x86 Linux, 27 Nov 2026; arm64 not yet confirmed by a person.

### Proxmox (a virtual machine)

Create a **virtual machine**, not an LXC container (LXC is not supported). Give it at least 4 GB of RAM and Ubuntu Server or Debian (64-bit, kernel 5.19 or newer), install Docker inside it with the lines under "Install Docker" above, and follow sections 1 to 3 inside the VM. Take a Proxmox snapshot of the VM after setup; the `config` volume lives inside the VM's disk, so the snapshot covers it. This section has not been run on a real Proxmox host yet.

### TrueNAS SCALE

Use **System → Shell** (a root shell), make the folder on a dataset as section 1 shows, and follow sections 1 to 3. TrueNAS SCALE 24.10 or newer has Docker already, so skip "Install Docker". The compose file does not assume TrueNAS: it uses Docker volumes, which TrueNAS's Docker keeps in its own storage pool. TrueNAS SCALE versions differ in how they run Docker and Compose, so check `docker compose version` works first. For backups, snapshots and the self-update helper, the fuller worked example is [docs/06-install-truenas.md](06-install-truenas.md), which builds on the NAS. This section has not been run on a real TrueNAS machine for the image install.

### Docker Desktop (macOS, Windows) — preview

Install [Docker Desktop](https://docs.docker.com/desktop/) in place of "Install Docker", then follow sections 1 to 3 in a terminal. `hostname -I` does not work on macOS: open `http://localhost:3100` on the same computer. The launcher finds where Docker keeps its data volume inside Docker Desktop's own virtual machine, so no shared folders are needed. This has not been tried yet.

## If something goes wrong

- **`sudo: command not found`** (Debian): type `su -` and the root password, then run the "Install Docker" lines without `sudo`.
- **`permission denied` on `docker.sock`**: your login has no Docker rights yet. Type `exit`, open the terminal again, and run the command again.
- **`curl: (22)` while getting the files, or the first line of section 1's download prints no version**: GitHub did not answer the version question, often because it limits how often one address can ask. Wait a few minutes and run the three download lines again in the folder.
- **`no configuration file provided`** or **`required variable BOSSMAN_REGISTRY is missing`**: you are not in the folder with the two files, or part of the command is missing (`-f docker-compose.images.yml` or `--env-file images.env`). `cd` into the folder and copy the whole command again.
- **The server cannot read `master.key`** or the database says its password file is missing: run step 1 first.
- **A pull is refused or "denied"**: the package may be private, or you hit Docker Hub's limit (section 2). Run `docker login` for that registry.
- **The page does not open from another computer**: check the address from `hostname -I` (section 3, step 4) and that `tail -2 images.env` shows the two lines of step 2. If not, run step 2 and then the start command (step 3) again. If the `curl` health line answers on the machine itself but the page does not open elsewhere, a firewall on the machine is blocking port 3100.
- **The login page reloads**: `images.env` is missing `BOSSMAN_INSECURE_COOKIES=1` (step 2). Run step 2, then the start command again.
- **Start again from nothing** (this deletes everything, including your company data and keys): see the next section. Do not do this if you want to keep anything.
- **Go back to the build install**: stop this one with `docker compose --env-file images.env -f docker-compose.images.yml down` (without `-v`, so the volumes stay) and follow [docs/00-first-time-install.md](00-first-time-install.md) in a different folder. The two installs do not share data.

## Start again from nothing

This deletes everything this install made, including your company data, your keys and the database. Back up first if you want to keep anything. **Remove from a host that runs only this install**: step 2 removes every runner and network guard on the host, not only this install's, until names follow the project (BOS-2851 narrows step 2 to this install's own runners and guards by the install label).

The order matters. The updater made the server and the launcher, and the launcher made the runners and guards, so Compose does not know them. They hold your volumes, and Docker will not delete a volume a container still uses. Containers go first, then the volumes. The examples use `boss-man`, the project name unless you set another with `-p` or `COMPOSE_PROJECT_NAME`; use your own name in its place. Run each command from the folder with `images.env`. A command that finds nothing to remove prints nothing, and that is fine.

1. Remove every container this install owns (the database, proxy, updater, server and launcher), found by their label:

   ```
   docker ps -aq --filter label=com.bossman.install=boss-man | xargs -r docker rm -f
   ```

2. Remove the launcher's runners, then its network guards:

   ```
   docker ps -aq --filter label=boss-man.launcher=1 | xargs -r docker rm -f
   ```

   ```
   docker ps -aq --filter label=boss-man.netguard=1 | xargs -r docker rm -f
   ```

3. Let Compose remove what it knows, with the volumes and any container it lost track of:

   ```
   docker compose -f docker-compose.images.yml --env-file images.env down -v --remove-orphans
   ```

4. Remove the Claude pack volume. A launcher from a release that includes the install label puts it on this volume. An older install made it with no label, under the name `boss-man-claude-pack`, so the second command catches that one:

   ```
   docker volume ls -q --filter label=com.bossman.install=boss-man | xargs -r docker volume rm
   ```

   ```
   docker volume ls -q --filter name=boss-man-claude-pack | xargs -r docker volume rm
   ```

   Compose can leave the `config` and `data` volumes behind (the real install test found this), so remove whatever is still named for the project (`boss-man_`, or your own project name):

   ```
   docker volume ls -q --filter name=^boss-man_ | xargs -r docker volume rm
   ```

5. Check nothing is left. Both commands only list, and both must print nothing:

   ```
   docker ps -a --format '{{.Names}}' --filter label=com.bossman.install=boss-man
   ```

   ```
   docker volume ls -q --filter name=boss-man
   ```

If either command prints a name, something is still holding it: run `docker ps -a` and remove that container with `docker rm -f <name>`, then repeat steps 3 to 5. Not yet confirmed on a real host after this change; the release install test runs these same steps after each real install (scripts/install-images.test.sh).

## What the install changes on your machine

Only Docker objects: containers, networks and volumes whose names start with `boss-man`. The launcher has access to the Docker socket (it starts one runner per company, from a fixed recipe), so treat the machine as dedicated to Boss Man. See [docs/20-netguard.md](20-netguard.md) for what keeps agents off your home network.

## Blue/green updates (the only way this install runs, since BOS-1227)

Compose holds the database, a small Caddy `proxy` that owns the host ports and the name `server`, the `updater` and the one-shot `setup`. The updater makes `server-blue` (and later `server-green`) and the `launcher` itself, from the release `images.env` pins, and takes over from there. The updater swaps the server's two colours through the Docker API: it checks the signed release, backs up the database (the last 3 dumps stay in the `backups` volume), migrates while the old colour serves, starts the idle colour, hands over, moves the `server-live` alias on the private `front` network (the proxy dials it, so no file or reload is involved), watches for 15 minutes and switches back by itself if the new colour fails, then stops the old colour and keeps it as the standby. Going back to the standby's release needs no download; any other older release is refused. The updater replaces itself last, through a hand-over (`updater-next` must report in within 60 seconds, else it is removed and "Updater update failed" is recorded). Migrations must be expand-only so the old release runs on the new schema (docs/10-migrations.md). The first server and the launcher are made at the updater's first start with no backup and no soak. This has been tested against a fake Docker API only; **not yet confirmed on a real host** (the real-Docker proof runs in staging). The launcher is replaced one at a time: the new one is created, the old one stopped, the new one started and waited for; if it never becomes healthy it is removed and the old one starts again. Never delete the `backups` or `updater-state` volumes or remove the standby colour. Because compose no longer owns a server or launcher, `docker compose up -d` cannot bring an older one back; the updater, if compose starts it from an older digest than the release it recorded, moves itself forward again. Removing the install (section "Start again from nothing") still deletes the volumes, and with them the updater's records.

## How the install is tested

`scripts/install-images.test.sh` reads the compose file and checks that every Boss Man image is named by digest, nothing is built, and the Docker socket is the only host path. With `INSTALL_RELEASE_JSON` set it does the real install on a machine with Docker. On every change, the CI `images` job (x86 and arm64 runners) builds the images, puts them in a local registry and runs the real install from them. The *Install test* workflow runs it again on x86 and arm64 against the published release files when a release finishes; it can also be started by hand (Actions → Install test → Run workflow, with the version). It times the run from the first command to `/api/health` answering and attaches `install-result.json` (date, version, pass or fail, minutes per architecture) to the release. A failed test marks the release: its title ends "(install test FAILED)" and its notes say so. `scripts/publish-site.sh` saves the newest release's file before it builds the website, and the install guide there shows "Last tested on (date) with (version), took (n) minutes"; with no result, or a failed one, it says so and never shows a pass. Details of how images are published and signed: [docs/25-published-images.md](25-published-images.md).
