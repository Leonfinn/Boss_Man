---
title: Install Boss Man
description: Take an empty Linux machine to the Boss Man web page: the folders, the master key, the settings file, and your owner account.
group: Start here
order: 2
lead: This guide takes you from an empty Linux machine to the Boss Man web page in your browser. Every file name and setting below was checked against the code.
time: About 20 minutes. You need a Linux machine with Docker and a web browser on the same network.
---

The full install was not re-run on a fresh machine for this guide, so the exact command output is unverified. The full reference, with TrueNAS notes and memory limits, is [`docs/00-first-time-install.md`](@repo/blob/main/docs/00-first-time-install.md) in the repository.

![What you install: the Boss Man server, its database, a launcher and one runner per company. Runners connect out to the server, so nothing needs an open port.](/img/what-you-install.svg =1160x800 narrow=/img/what-you-install-narrow.svg:360x1530 "What you are installing. Everything runs on one machine, and the runners dial out, so you open no ports for them.")

## What you need

- a 64-bit Linux machine with Docker Engine and Docker Compose v2 (check with `docker compose version`)
- `git`, `openssl` and `curl` on that machine
- a GitHub or Gitea account, for the repositories your agents work in
- an AI account: a Claude or ChatGPT plan, an Anthropic key, or any OpenAI-compatible API key, such as OpenRouter, Synthetic or Ollama. A Claude Pro or Max plan is the easiest start, because the CEO is a Claude Code agent unless you change it.
- a computer with a web browser on the same network

Boss Man needs Linux because two safety features use the Linux kernel: the network guard keeps agents off your home network, and the agent fence keeps each agent in its own folder. Settings shows whether each one is working on your machine. Docker Desktop on Mac and Windows isn't supported yet. Both safety features should work on Docker Desktop 4.60 or newer, and we're testing it.

The commands are for a root shell. On a normal Linux machine, run them as root or put `sudo` in front.

Each runner is limited to 4 GB of memory by default.

## 1. Choose a folder

Set a shell variable for the folder where Boss Man keeps everything. `/opt/boss-man` is an example.

```sh Run on the Linux machine, as root
B=/opt/boss-man
mkdir -p $B
```

Set `B` again if you open a new shell.

## 2. Get the code

Clone the Boss Man repository into `$B/src`:

```sh Run on the Linux machine, as root
git clone https://github.com/Leonfinn/Boss_Man.git $B/src
```

If you install from a private copy of the repository, use a read-only deploy key instead, as step 2 of [`docs/00-first-time-install.md`](@repo/blob/main/docs/00-first-time-install.md) shows.

:::worked
`git -C $B/src log --oneline -1` prints one line.
:::

## 3. Make the folders and the master key

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

## 4. Write the settings file

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

## 5. Build and start

Run every `docker compose` command from `$B/src`.

```sh Run on the Linux machine, as root
cd $B/src
docker compose build server launcher netguard
scripts/update-runner.sh
```

`update-runner.sh` builds the runner image, runs a safety check on it with networking off, and then starts everything. On a first install it says no launcher is running. That is expected.

:::worked
`docker compose ps` shows `db`, `server` and `launcher` running, and `curl -s http://<host-ip>:3100/api/health` prints a short line of JSON.
:::

## 6. Make the owner account

Open `http://<host-ip>:3100` in your browser. Type a username and a password of at least 12 characters, and choose **Create owner account**.

There is only one owner account, and it controls every company on the server. The setup wizard opens next. Carry on with [Your first company and task](/guides/first-company-and-ticket).

## If something goes wrong

- **The login page reloads.** `.env` is missing `BOSSMAN_INSECURE_COOKIES=1`, or you used a different address from last time. Add the line, run `docker compose up -d` from `$B/src`, and use the same address each time.
- **The port is in use.** Change `BOSSMAN_HOST_PORT` in `.env` to a free port and run `docker compose up -d`.
- **Compose says something is not set.** You are not in `$B/src`, or step 3 or 4 is unfinished.

Do not forward the web port on your router. For access from outside your home, use Tailscale (see [Add-ons](/guides/add-ons)).
