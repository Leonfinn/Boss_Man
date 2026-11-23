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

Open the release page of the Boss Man repository on GitHub, pick the version you want (the newest *Pre-release* is the beta), and download these into an empty folder:

- `docker-compose.images.yml`
- `images.env`

Both are made and signed by the release. `images.env` holds the registry and the exact digest of every image; do not edit the digests.

Optional: check the signature before you trust them. This needs [cosign](https://docs.sigstore.dev/cosign/installation/) and is the only step that does. Download `images.env.sigstore.json` and `docker-compose.images.yml.sigstore.json` from the same release page, then run, for each file:

```
cosign verify-blob --bundle images.env.sigstore.json --certificate-oidc-issuer https://token.actions.githubusercontent.com --certificate-identity https://github.com/<owner>/<repo>/.github/workflows/release.yml@refs/heads/main images.env
```

Replace `<owner>/<repo>` with the repository you downloaded from, and repeat with `docker-compose.images.yml`.

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
   docker compose --env-file images.env run --rm setup
   ```

   It writes the master key into a Docker volume called `config` and the database password into a second one called `db-secret` (in a project named `boss-man`, they are `boss-man_config` and `boss-man_db-secret`). The database container gets only `db-secret`, so it never sees the master key. **Back up both volumes.** Without `master.key`, the secrets Boss Man stores cannot be read again, and without the database password the server cannot reach its database.

2. Download the runner images the launcher starts for each company:

   ```
   docker compose --env-file images.env --profile images pull
   ```

3. Start Boss Man:

   ```
   docker compose --env-file images.env up -d
   ```

4. Open `http://<this machine>:3100` and create the owner account. By default Boss Man listens only on the machine itself (`127.0.0.1`). To reach it from another computer, add `BOSSMAN_BIND=0.0.0.0` to `images.env` and run step 3 again, and keep the port off the internet. Logging in over plain `http://` on your home network also needs `BOSSMAN_INSECURE_COOKIES=1` in `images.env`; without it, login needs HTTPS.

Company data (workspaces, agent sessions) lives in Docker volumes created by Boss Man's launcher, not in a folder you choose. List them with `docker volume ls`.

### Updating to a new release

Nothing updates by itself. Do this once for each release you choose to take (there is no need to take every one), in the folder with your two files:

1. Download the new `docker-compose.images.yml` and `images.env` from the release page and put them over the old ones. If you added settings of your own to `images.env` (section "Settings" below), copy those lines into the new file first; the new file replaces the digests and nothing else.
2. Download the new images, including the runner images:

   ```
   docker compose --env-file images.env --profile images pull
   ```

3. Start the new version. Your data and keys stay, because they are in volumes:

   ```
   docker compose --env-file images.env up -d
   ```

Do not run `setup` again; it is only for the first install (running it again is harmless, it keeps what exists). Runners that are already running keep the old image until the launcher starts them again; the launcher marks a runner that is not on the newest image as not current. (Not yet confirmed on a real install: whether Boss Man's own runner update button recreates runners from the pulled image. Until that is confirmed, `docker compose --env-file images.env --profile images pull` followed by `up -d` is the supported route.)

The **Build and update runners** button in Settings builds images from source on the machine. It does not apply to this install, because there is no source here: use the pull in step 2 instead.

### Back up two volumes

Back up `config` (the master key) and `db-secret` (the database password) after the first install, and keep the copies somewhere other than this machine. They are small. Keep them together with the database volume's backup: if you lose only `db-secret`, `setup` would make a new password, which the existing database refuses, and the server could not start. If that happens, restore `db-secret` from your backup. Without a backup the database password cannot be recovered, and the database volume would have to be recreated, which loses its data.

### Settings

Add any of these to `images.env`, then run step 3 again.

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

Install Docker Engine from Docker's own instructions, then follow steps 1 to 4. Nothing else is needed. Check the kernel with `uname -r` (5.19 or newer).

### Proxmox (a virtual machine)

Create a **virtual machine**, not an LXC container (LXC is not supported). Give it at least 4 GB of RAM and a 64-bit Linux with a kernel 5.19 or newer, install Docker Engine inside it, and follow steps 1 to 4 inside the VM. Take a Proxmox snapshot of the VM after setup; the `config` volume lives inside the VM's disk, so the snapshot covers it. This section has not been run on a real Proxmox host yet.

### TrueNAS SCALE

Use the machine's shell, in a **dataset-backed folder** for the two downloaded files, and follow steps 1 to 4. The compose file does not assume TrueNAS: it uses Docker volumes, which TrueNAS's Docker keeps in its own storage pool. TrueNAS SCALE versions differ in how they run Docker and Compose, so check `docker compose version` works first. For backups, snapshots and the self-update helper, the fuller worked example is [docs/06-install-truenas.md](06-install-truenas.md), which builds on the NAS. This section has not been run on a real TrueNAS machine for the image install.

### Docker Desktop (macOS, Windows) — preview

Follow steps 1 to 4 in a terminal. The launcher finds where Docker keeps its data volume inside Docker Desktop's own virtual machine, so no shared folders are needed. This has not been tried yet.

## If something goes wrong

- **`required variable BOSSMAN_REGISTRY is missing`**: you left out `--env-file images.env`.
- **The server cannot read `master.key`** or the database says its password file is missing: run step 1 first.
- **A pull is refused or "denied"**: the package may be private, or you hit Docker Hub's limit (section 2). Run `docker login` for that registry.
- **Start again from nothing** (this deletes everything, including your company data and keys): `docker compose --env-file images.env --profile images down -v`. Do not do this if you want to keep anything.
- **Go back to the build install**: stop this one with `docker compose --env-file images.env down` (without `-v`, so the volumes stay) and follow [docs/00-first-time-install.md](00-first-time-install.md) in a different folder. The two installs do not share data.

## What the install changes on your machine

Only Docker objects: containers, networks and volumes whose names start with `boss-man`. The launcher has access to the Docker socket (it starts one runner per company, from a fixed recipe), so treat the machine as dedicated to Boss Man. See [docs/20-netguard.md](20-netguard.md) for what keeps agents off your home network.

## How the install is tested

`scripts/install-images.test.sh` reads the compose file and checks that every Boss Man image is named by digest, nothing is built, and the Docker socket is the only host path. With `INSTALL_RELEASE_JSON` set it does the real install on a machine with Docker. On every change, the CI `images` job (x86 and arm64 runners) builds the images, puts them in a local registry and runs the real install from them. The *Install test* workflow runs it again on x86 and arm64 against the published release files when a release finishes; it can also be started by hand (Actions → Install test → Run workflow, with the version). Details of how images are published and signed: [docs/25-published-images.md](25-published-images.md).
