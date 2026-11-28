---
title: Install Boss Man
description: Take a 64-bit machine with Docker to the Boss Man web page, from ready-made images: two files, the keys, start, and your owner account. Building from source is the second option.
group: Start here
order: 2
lead: This guide takes you from a 64-bit machine with Docker to the Boss Man web page in your browser. The main way installs ready-made images. Building from source is the second option, further down.
time: {{install-time}}You need a 64-bit machine with Docker and Compose, and a web browser on the same network.
---

{{install-test}} The full references are in the repository: [`docs/35-install-from-images.md`](@repo/blob/main/docs/35-install-from-images.md) for the image install, and [`docs/00-first-time-install.md`](@repo/blob/main/docs/00-first-time-install.md) for building from source. Memory limits and other tuning are in [`docs/29-tune-and-troubleshoot.md`](@repo/blob/main/docs/29-tune-and-troubleshoot.md). On Proxmox, use a VM, not an LXC container: see [`docs/32-proxmox.md`](@repo/blob/main/docs/32-proxmox.md).

Still deciding? [What can go wrong with AI agent teams](/what-can-go-wrong) matches published failure stories, such as runaway bills and deleted databases, to what Boss Man does about each, and says where it does nothing yet.

Coming from Paperclip? Install Boss Man first, then follow [Moving a company from Paperclip](/guides/move-from-paperclip) to bring your company, its tickets and its wiki pages across.

![What you install: the Boss Man server, its database, a launcher and one runner per company. Runners connect out to the server, so nothing needs an open port.](/img/what-you-install.svg =1160x800 narrow=/img/what-you-install-narrow.svg:360x1530 "What you are installing. Everything runs on one machine, and the runners dial out, so you open no ports for them.")

## What machine do I need

Plan on 16 GB of memory for one company with Boss Man's default settings. 8 GB can work if you let fewer agents run at once. These sizes are estimates: they come from Boss Man's settings and one measured install, not from a sizing test.

| | Minimum (estimate) | Comfortable (estimate) |
|---|---|---|
| Memory | 8 GB, with 1 agent at once | 16 GB for one company with the default settings |
| Disk | 100 GB free, on an SSD | 250 GB or more, on an SSD or NVMe drive |
| CPU | 4 cores, 64-bit (x86-64, or arm64 for the image install) | 8 cores or more |

**How memory is shared.** Each company gets one runner, the container its agents work in. Boss Man gives each runner 2 GB, plus 1 GB for each agent that may run at once, plus 3 GB for each check. With the defaults (6 agents and 1 check) that is 11 GB. Boss Man always leaves 2 GB of the machine for its server and database, so on a smaller machine the runner gets less. If the runner gets under 4 GB, Boss Man warns you to run fewer agents. You set both numbers in **Settings → Server and runner → Limits and checks**, under **Agents at once** and **Checks at once**, and the **Checks** section there shows what the runner gets and why.

**More than one company.** Each runner is sized from the whole machine, but a runner with no work uses almost no memory. Add memory for the companies that will be busy at the same time.

**Disk.** Each task gets its own copy of the code, and each company's copies are capped at 20 GB by default.

**Fastest win.** An SSD matters more than a faster CPU, because tests and installs touch many small files.

## Install from ready-made images

This install only needs Docker with the Compose plugin. Nothing is built on your machine, and you need no `git`, `openssl`, `sudo` or source code. The images are built and signed by the Boss Man project, and Docker pulls them by their exact digest.

The image install has not yet been run from start to finish on a real machine for this guide, so treat the exact command output as unverified. The *Install test* workflow runs the full install on an x86 and an arm64 machine after each release: if it is green for the release you install, the steps have worked there.

### What you need

- a 64-bit machine (x86-64 or arm64) with at least 4 GB of memory, and Docker Engine with Docker Compose v2 (check with `docker compose version`). For agents to run, size it as in [What machine do I need](#what-machine-do-i-need).
- internet access to the image registry, and to Anthropic if you use Claude Code
- only if your agents will work on code: a GitHub or Gitea account, for the repositories they work in. A team that works on documents and research does not need one.
- an AI account: a Claude or ChatGPT plan, or an API key from Anthropic, OpenAI, OpenRouter, Ollama Cloud or Synthetic. A Claude Pro or Max plan is the easiest start, because the CEO is a Claude Code agent unless you change it. You pay for this account. Boss Man itself is free.
- a computer with a web browser

### Which platforms work

| | Platform |
|---|---|
| Supported | 64-bit Linux (a VM or bare metal) with Docker Engine, kernel 5.19 or newer. Kernel 6.12 or newer gives the full file fence. |
| Preview | Docker Desktop 4.60 or newer on macOS and Windows. Not yet proven on a real machine. Docker Desktop's enhanced container isolation must be off, or the Boss Man images allowed. |
| Not yet | Podman, rootless Docker, Docker Desktop before 4.60, Proxmox LXC containers (use a full virtual machine), and 32-bit ARM (use a 64-bit OS). |

Boss Man needs the Linux kernel for two safety features: the network guard keeps agents off your home network, and the agent fence keeps each agent in its own folder. On a platform outside the first row, Boss Man refuses to run agents unless both are proven on that machine, or you choose otherwise in **Settings → Server and runner**. **Settings → Permissions → Agent fence** shows whether each one is working. What each one blocks, platform by platform, is in [What keeps agents fenced in](/guides/what-keeps-agents-fenced-in).

### 1. Get the files

Open the [Boss Man releases page](@repo/releases) and pick a version. The newest *Pre-release* is the beta. Download these two files into an empty folder:

- `docker-compose.images.yml`
- `images.env`

Use 0.1.0-beta.3 or newer. The older 0.1.0-beta.1 has no `images.env`, because its images were not published.

`images.env` holds the registry and the exact digest of every image. Do not edit the digests.

Optional: check the signatures with [cosign](https://docs.sigstore.dev/cosign/installation/). Download `images.env.sigstore.json` and `docker-compose.images.yml.sigstore.json` from the same release into the same folder, then run these two commands there, one for each file:

```sh Run in the folder with the files (checks images.env)
cosign verify-blob --bundle images.env.sigstore.json --certificate-oidc-issuer https://token.actions.githubusercontent.com --certificate-identity https://github.com/Leonfinn/Boss_Man/.github/workflows/release.yml@refs/heads/main images.env
```

```sh Run in the folder with the files (checks docker-compose.images.yml)
cosign verify-blob --bundle docker-compose.images.yml.sigstore.json --certificate-oidc-issuer https://token.actions.githubusercontent.com --certificate-identity https://github.com/Leonfinn/Boss_Man/.github/workflows/release.yml@refs/heads/main docker-compose.images.yml
```

Each prints `Verified OK` when the file is the one the release signed.

:::worked
`ls` in the folder shows `docker-compose.images.yml` and `images.env`.
:::

### 2. Pick a registry

The images are the same in every registry. This setting only decides where Docker downloads them from.

- **GitHub's registry (`ghcr.io`) is the default** and the only one published today. It has no download limit for public images. Leave `images.env` as it is.
- **Docker Hub** is supported by the setting but is not published yet, so it is untested. When it is, you change one line in `images.env`: `BOSSMAN_REGISTRY=docker.io/<namespace>`.

Docker Hub limits anonymous downloads per IP address. If a pull fails with `toomanyrequests`, run `docker login` with a free Docker Hub account and try again, or go back to `ghcr.io`. The digests are the same, so nothing else changes.

The database image, `pgvector/pgvector`, always comes from Docker Hub, so that limit can apply to it even when you use `ghcr.io`. To take it from somewhere else, set `BOSSMAN_DB_IMAGE` in `images.env`.

### 3. Make the keys

Run this and every later command in the folder with the two files.

```sh Run in the folder with the files
docker compose --env-file images.env -f docker-compose.images.yml run --rm setup
```

This writes the master key into a Docker volume called `config`, and the database password into one called `db-secret`. It is safe to run again: it never replaces a file that exists.

**Back up both volumes**, and keep the copies off this machine. Without the master key, Boss Man cannot read your stored secrets again. Without the database password, the server cannot reach its database.

### 4. Choose who can reach it

By default Boss Man listens only on the machine itself. To open it from another computer on your home network, add these two lines to `images.env`:

```sh Add to images.env
BOSSMAN_BIND=0.0.0.0
BOSSMAN_INSECURE_COOKIES=1
```

- `BOSSMAN_BIND=0.0.0.0` shows the web page on every address of the machine
- `BOSSMAN_INSECURE_COOKIES=1` lets you log in over plain `http://` (remove it once you use HTTPS)

Keep the port off the internet. Skip this step if you only open Boss Man in a browser on the same machine.

### 5. Start Boss Man

```sh Run in the folder with the files
docker compose --env-file images.env -f docker-compose.images.yml up -d
```

This starts Boss Man. Compose starts only the database, a small proxy and the updater; the updater then downloads the server, launcher, runner and network-guard images by their digests and makes the server and the launcher itself, so the first start takes a few minutes longer than later ones.

:::worked
`docker compose --env-file images.env -f docker-compose.images.yml ps` shows `db`, `server` and `launcher` running, and `http://<this machine>:3100` opens a Boss Man page. (Expected from the compose file; not yet seen on a real install.)

If `ps` shows the server restarting, run `docker compose --env-file images.env -f docker-compose.images.yml logs server` to see why, and check the list under "If something goes wrong" below.
:::

### 6. Make the owner account

Open `http://<this machine>:3100` in your browser, for example `http://192.168.1.20:3100`. Type a username and a password of at least 12 characters, and choose **Create owner account**.

There is only one owner account, and it controls every company on the server. The setup wizard opens next. Carry on with [Your first company and task](/guides/first-company-and-ticket).

### Claude Code downloads on first start

The runner image does not contain Claude Code. The first time a runner starts, Boss Man downloads Claude Code from Anthropic (through the npm registry) and keeps it in a volume. Until that has finished, agents that use Claude Code wait. OpenCode and Codex agents work as normal. You still sign in with your own Claude plan or API key.

### Per host

- **Plain Linux.** Install Docker Engine from Docker's own instructions, then follow steps 1 to 6. Check the kernel with `uname -r` (5.19 or newer).
- **Proxmox.** Use a virtual machine, not an LXC container. Give it at least 4 GB of memory and a 64-bit Linux with kernel 5.19 or newer, install Docker Engine inside it, and follow the steps inside the VM. A Proxmox snapshot of the VM covers the key volumes, because they live on the VM's disk. Not yet run on a real Proxmox host.
- **TrueNAS SCALE.** Use the machine's shell, put the two files in a folder on a dataset, and follow the steps. First check that `docker compose version` works, because TrueNAS versions differ in how they run Docker. Not yet run on a real TrueNAS machine for this install. For snapshots and backups, see [`docs/06-install-truenas.md`](@repo/blob/main/docs/06-install-truenas.md).
- **Docker Desktop (preview).** Follow the steps in a terminal. Not tried yet.

### Start again from nothing

This deletes everything this install made, including your company data, your keys and the database. Back up first if you want to keep anything. Do this only on a machine that runs just this install: step 2 removes every runner and network guard on the machine, not only this install's. `boss-man` below is the project name unless you set another with `-p` or `COMPOSE_PROJECT_NAME`; use your own name in its place. Run each command in the folder with `images.env`. A command that finds nothing to remove prints nothing, and that is fine.

The order matters: the updater and launcher started some containers that Compose does not know, and they hold your volumes, so they go first.

1. Remove every container this install owns:

```sh Run in the folder with images.env
docker ps -aq --filter label=com.bossman.install=boss-man | xargs -r docker rm -f
```

2. Remove the runners, then the network guards:

```sh Run in the folder with images.env
docker ps -aq --filter label=boss-man.launcher=1 | xargs -r docker rm -f
```

```sh Run in the folder with images.env
docker ps -aq --filter label=boss-man.netguard=1 | xargs -r docker rm -f
```

3. Remove what Compose knows, with its volumes:

```sh Run in the folder with images.env
docker compose -f docker-compose.images.yml --env-file images.env down -v --remove-orphans
```

4. Remove the Claude pack volume. The second command catches one an older install made without the label:

```sh Run in the folder with images.env
docker volume ls -q --filter label=com.bossman.install=boss-man | xargs -r docker volume rm
```

```sh Run in the folder with images.env
docker volume ls -q --filter name=boss-man-claude-pack | xargs -r docker volume rm
```

Compose can leave the `config` and `data` volumes behind, so remove whatever is still named for the project (`boss-man_`, or your own project name):

```sh Run in the folder with images.env
docker volume ls -q --filter name=^boss-man_ | xargs -r docker volume rm
```

5. Check nothing is left. Both commands only list, and both must print nothing:

```sh Run in the folder with images.env
docker ps -a --format '{{.Names}}' --filter label=com.bossman.install=boss-man
```

```sh Run in the folder with images.env
docker volume ls -q --filter name=boss-man
```

If either prints a name, run `docker ps -a` and remove that container with `docker rm -f` and its name, then repeat steps 3 to 5.

Not yet confirmed on a real host as of 2026-11-27; the release install test runs these same steps after each real install.

### Updating to a new release

Nothing updates by itself. Take a release from Boss Man's own update screen: the updater checks the signed release, downloads every image of it by digest, backs up the database, switches the server over, watches it for 15 minutes (going back by itself if it fails), and then moves the rest of the release. Your data and keys stay, because they are in volumes.

You do not run `docker compose pull` or `up -d` for a release any more. Do not run `setup` again: it is only for the first install. The **Build and update runners** button in Settings builds images from source, so it does not apply to this install.

### If something goes wrong

- **`required variable BOSSMAN_REGISTRY is missing`.** You left out `--env-file images.env`.
- **The server cannot read `master.key`, or the database says its password file is missing.** Run step 3 first.
- **A pull is refused or "denied".** You may have hit Docker Hub's limit (step 2). Run `docker login` for that registry.
- **The login page reloads.** `images.env` is missing `BOSSMAN_INSECURE_COOKIES=1` (step 4). Add it and run `docker compose --env-file images.env -f docker-compose.images.yml up -d`.

Do not forward the web port on your router. For access from outside your home, use Tailscale (see [Add-ons](/guides/add-ons)).

## Build from source

The second option: build every image on your own machine from the code. Use it if you want to change Boss Man's code. Building takes disk space and CPU time, during the install and each update. Do not run both installs on one machine under the same project name.

### What you need to build

- a 64-bit Linux machine with Docker Engine and Docker Compose v2 (check with `docker compose version`)
- `git`, `openssl` and `curl` on that machine
- only if your agents will work on code: a GitHub or Gitea account, for the repositories they work in. A team that works on documents and research does not need one.
- an AI account: a Claude or ChatGPT plan, or an API key from Anthropic, OpenAI, OpenRouter, Ollama Cloud or Synthetic. A Claude Pro or Max plan is the easiest start, because the CEO is a Claude Code agent unless you change it. You pay for this account. Boss Man itself is free.
- a computer with a web browser on the same network

Boss Man needs Linux because two safety features use the Linux kernel: the network guard keeps agents off your home network, and the agent fence keeps each agent in its own folder. **Settings → Permissions → Agent fence** shows whether each one is working on your machine. See [What keeps agents fenced in](/guides/what-keeps-agents-fenced-in).

Mac and Windows: not supported yet for this install, but we're testing Docker Desktop. On a Mac with Apple silicon, the agent fence already works under Docker Desktop. The network guard isn't proven there yet, and Windows hasn't been tested. For now, use a Linux machine.

The commands are for a root shell. On a normal Linux machine, run them as root or put `sudo` in front.

### 1. Choose a folder

Set a shell variable for the folder where Boss Man keeps everything. `/opt/boss-man` is an example.

```sh Run on the Linux machine, as root
B=/opt/boss-man
mkdir -p $B
```

Set `B` again if you open a new shell.

### 2. Get the code

Clone the Boss Man repository into `$B/src`:

```sh Run on the Linux machine, as root
git clone https://github.com/Leonfinn/Boss_Man.git $B/src
```

If you install from a private copy of the repository, use a read-only deploy key instead, as step 2 of [`docs/00-first-time-install.md`](@repo/blob/main/docs/00-first-time-install.md) shows.

:::worked
`git -C $B/src log --oneline -1` prints one line.
:::

### 3. Make the folders and the master key

The server and runners run as user ID 1000, so the folders they write to must belong to user 1000.

```sh Run on the Linux machine, as root
mkdir -p $B/data/companies $B/src/secrets
chown 1000:1000 $B/data/companies $B/src/secrets && chmod 700 $B/src/secrets
```

The master key encrypts every secret Boss Man stores. Make it:

```sh Run on the Linux machine, as root
openssl rand -base64 32 > $B/src/secrets/master.key && chown 1000:1000 $B/src/secrets/master.key && chmod 600 $B/src/secrets/master.key
```

Copy `master.key` somewhere safe off the machine now. Without it, Boss Man cannot read your stored secrets again.

Docker Compose will not start while a secret file it names is missing, so make an empty runner token file:

```sh Run on the Linux machine, as root
touch $B/src/secrets/runner-app-co.token && chown 1000:1000 $B/src/secrets/runner-app-co.token && chmod 600 $B/src/secrets/runner-app-co.token
```

:::worked
`ls -l $B/src/secrets` lists `master.key` and `runner-app-co.token`.
:::

### 4. Write the settings file

Replace `<host-ip>` with the machine's address on your home network, for example `192.168.1.20`. Then run:

```sh Run on the Linux machine, as root, with <host-ip> filled in
cat > $B/src/.env <<EOF
COMPOSE_PROFILES=launcher
BOSSMAN_LAUNCHER=1
BOSSMAN_DOCKER_GID=$(stat -c %g /var/run/docker.sock)
BOSSMAN_DATA=$B/data
POSTGRES_PASSWORD=$(openssl rand -hex 24)
BOSSMAN_BIND=<host-ip>
BOSSMAN_HOST_PORT=3100
BOSSMAN_INSECURE_COOKIES=1
BOSSMAN_DEPLOYER=$B/deployer
EOF
chmod 600 $B/src/.env
```

What the settings do:

- `BOSSMAN_LAUNCHER=1` lets Boss Man start each company's runner for you
- `BOSSMAN_BIND` shows the web page on that address only
- `BOSSMAN_HOST_PORT` is the port you type in the browser
- `BOSSMAN_INSECURE_COOKIES=1` lets you log in over plain `http://` on your home network (remove it once you use HTTPS)

### 5. Build and start

Run every `docker compose` command from `$B/src`.

```sh Run on the Linux machine, as root
cd $B/src
docker compose build server launcher
scripts/update-runner.sh
```

`update-runner.sh` builds the runner image, runs a safety check on it with networking off, and then starts everything. On a first install it says no launcher is running. That is expected.

:::worked
`docker compose ps` shows `db`, `server` and `launcher` running, and `curl -sS http://<host-ip>:<your BOSSMAN_HOST_PORT, 3100 unless you changed it>/api/health` prints a short line of JSON. For example, `curl -sS http://192.168.1.20:3100/api/health`.

If you see `Connection refused`, the server has not started yet or the port is wrong. Wait a minute and run the command again, and check that the port matches `BOSSMAN_HOST_PORT` in your `.env`. If it still fails after a few minutes, run `docker compose ps` and `docker compose logs server` to see why the server is not running.
:::

### 6. Make the owner account

Open `http://<host-ip>:3100` in your browser. Type a username and a password of at least 12 characters, and choose **Create owner account**.

There is only one owner account, and it controls every company on the server. The setup wizard opens next. Carry on with [Your first company and task](/guides/first-company-and-ticket).

### If the build install goes wrong

- **The login page reloads.** `.env` is missing `BOSSMAN_INSECURE_COOKIES=1`, or you used a different address from last time. Add the line, run `docker compose up -d` from `$B/src`, and use the same address each time.
- **The port is in use.** Change `BOSSMAN_HOST_PORT` in `.env` to a free port and run `docker compose up -d`.
- **Compose says something is not set.** You are not in `$B/src`, or step 3 or 4 is unfinished.

Do not forward the web port on your router. For access from outside your home, use Tailscale (see [Add-ons](/guides/add-ons)).
