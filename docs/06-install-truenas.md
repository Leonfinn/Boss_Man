# Installing Boss Man on TrueNAS SCALE

This guide puts the whole stack on a TrueNAS SCALE box: Postgres, the server with the web UI, and one runner per company. Every image is built on the NAS itself. The runner image contains Claude Code, which must not be redistributed (see the licence note in `apps/runner/Dockerfile`). Building natively also avoids the arm64-to-x86_64 cross-build you'd need from an Apple Silicon Mac.

Checked against TrueNAS SCALE 25.10 "Goldeye" on 16 Oct 2026. Where TrueNAS doesn't document something, the guide says so.

## How it runs, and why not "Install via YAML"

TrueNAS has run apps on Docker since 24.10 "Electric Eel". Its own apps are Compose projects named `ix-<app>`. The supported way to add your own is Apps > Discover > Install via YAML ([docs](https://www.truenas.com/docs/scale/25.10/scaleuireference/apps/installcustomappscreens/)). That route doesn't suit Boss Man:
- **It starts no runners.** It runs `docker compose up` without `--profile`, so the profile-gated runner services never start.
- **Relative paths break.** It rewrites the file into `/mnt/.ix-apps/app_configs/...`, so relative paths such as `./secrets/master.key` stop pointing at your files.
- **Its Update button fails.** The button pulls images, and Boss Man's images are built locally, so there's nothing to pull.

Instead, this guide runs Boss Man with the `docker compose` command over SSH, as its own project, `boss-man`.
- **What TrueNAS documents.** The `docker` and `docker compose` commands are on the host; the TrueNAS middleware itself calls them. TrueNAS doesn't document running your own stack from the shell, so it is neither supported nor forbidden.
- **Why it doesn't clash.** The project name is different from TrueNAS's `ix-*` apps, so TrueNAS's app actions (which remove orphans only within their own project) leave it alone.
- **Where Docker keeps its data.** Docker's data lives on the apps pool (`/mnt/.ix-apps/docker`), so OS updates don't remove images or containers.
- **After a TrueNAS update,** check that it's all still running (step 9).

## What you need

- TrueNAS SCALE 24.10 or later, with an apps pool chosen under Apps > Configuration > Choose Pool. The Docker service only runs once a pool is chosen.
- SSH access as your admin user, who can use `sudo`.
- A Claude Pro or Max subscription for a setup-token, or an Anthropic API key.
- A GitHub account that can create a fine-grained token for the repos the agents will work on.

In the commands below, replace `<pool>` with the name of your SSD pool, the mirrored pair that holds apps. Replace `<nas-ip>` with the NAS's LAN address. Your router is at 192.168.68.1, so the NAS is most likely on 192.168.68.x. Check it in the TrueNAS UI under Network.

## 1. Create a dataset

In the TrueNAS UI, go to Datasets, select your SSD pool, and Add Dataset:
- **Name:** `apps/boss-man`. Create the `apps` dataset first if you don't have one.
- **Dataset preset:** Generic. With Generic, ordinary `chown` and `chmod` behave as expected, whereas an NFSv4 ACL can override them.

Everything Boss Man keeps goes under this dataset, so snapshots and replication cover it.

## 2. Get the code

SSH into the NAS from iTerm2 on your Mac:

```sh
ssh admin@<nas-ip>
```

Go to the dataset:

```sh
cd /mnt/<pool>/apps/boss-man
```

Check whether git is on the host:

```sh
git --version
```

If that prints a version, clone the repo with it:

```sh
sudo git clone https://github.com/Leonfinn/Boss_Man.git src
```

If git isn't there, clone the repo with a throwaway git container instead:

```sh
sudo docker run --rm -v "$PWD":/w -w /w alpine/git clone https://github.com/Leonfinn/Boss_Man.git src
```

## 3. Folders and ownership

The server and runners run as uid 1000. Postgres (the Alpine image) runs as uid 70 and sets the ownership of its own data folder on first start, so you only create that folder.

```sh
sudo mkdir -p data/postgres data/app-co/workspaces data/app-co/runner-data data/app-co/claude src/secrets
```

```sh
sudo chown -R 1000:1000 data/app-co src/secrets && sudo chmod 700 src/secrets
```

## 4. Settings and the master key

Go to the repo folder. Run everything from here from `/mnt/<pool>/apps/boss-man/src`.

```sh
cd /mnt/<pool>/apps/boss-man/src
```

The master key encrypts every stored secret. Back it up somewhere safe outside the NAS. Without it, stored secrets can't be read.

```sh
sudo sh -c 'openssl rand -base64 32 > secrets/master.key' && sudo chown 1000:1000 secrets/master.key && sudo chmod 600 secrets/master.key
```

Compose won't start anything while a secret file is missing, so create the runner's token file now, empty. You fill it in at step 7.

```sh
sudo touch secrets/runner-app-co.token && sudo chown 1000:1000 secrets/runner-app-co.token && sudo chmod 600 secrets/runner-app-co.token
```

Create `.env`. Compose reads it automatically. Its first two lines add the TrueNAS file and start the runners, so plain `docker compose` commands and the update script both use them.

```sh
sudo tee .env > /dev/null <<EOF
COMPOSE_FILE=docker-compose.yml:deploy/truenas.yml
COMPOSE_PROFILES=runners
BOSSMAN_DATA=/mnt/<pool>/apps/boss-man/data
POSTGRES_PASSWORD=$(openssl rand -hex 24)
BOSSMAN_BIND=<nas-ip>
BOSSMAN_INSECURE_COOKIES=1
EOF
```

```sh
sudo chmod 600 .env
```

- `BOSSMAN_BIND` publishes the web UI on the NAS's LAN address only, on port 3100. The TrueNAS UI keeps 80 and 443. Don't forward port 3100 on the router.
- `BOSSMAN_INSECURE_COOKIES=1` lets you log in over plain HTTP on your LAN.
  - With HTTPS in front of Boss Man, remove this line. That could be Tailscale Serve, or a reverse proxy on your OPNsense box.
  - Browsers only allow notifications (R44) on HTTPS pages, so you need HTTPS for those anyway.

## 5. Build the images and start the server

Build the server image, which includes the web UI, and start Postgres and the server. For now, start them without the runner, which has no token yet.

```sh
sudo docker compose build server
```

```sh
sudo docker compose up -d db server
```

Build the runner image with the canary check. The script builds a candidate image and runs a real Claude Code session in it, with networking off and no credentials. It tags the image `boss-man-runner:current` only if that passes.

```sh
sudo scripts/update-runner.sh
```

The script also runs `docker compose up -d` at the end. Until its token file holds a token (step 7), the runner stops at start-up with "Set BOSSMAN_RUNNER_TOKEN_FILE..." and Docker keeps restarting it. That's expected.

## 6. First login and the company

Open `http://<nas-ip>:3100` on your Mac and create the owner account. Then:
1. On **Board**, create the company, for example "Boss Man Co", and a project, for example "Boss Man".
2. In **Settings**, under **Projects**, set:
   - **Git repo:** `https://github.com/Leonfinn/Boss_Man.git`
   - **Check before merging:** `pnpm install --frozen-lockfile && pnpm typecheck && pnpm test`

## 7. The runner token

In **Settings > Runner**, choose **Register a runner**. The token is shown once. Write it into the token file without it landing in your shell history: run the command, paste the token, press Return, then Ctrl-D.

```sh
sudo sh -c 'cat > secrets/runner-app-co.token'
```

The token file must hold only the token. A trailing newline is fine, because the runner trims it.

```sh
sudo docker compose up -d
```

Settings > Runner should show **Connected** within a minute.

The example service is called `runner-app-co`. For a second company:
1. Copy its block in `docker-compose.yml` and its volumes in `deploy/truenas.yml` under a new name.
2. Give the copy its own token file and its own `data/<company>/` folders.

## 8. Credentials and funding

Make both credentials on your Mac, then paste them into **Settings > Credentials**. Values are encrypted on the server and never shown again.

**Claude setup-token.** If Claude Code isn't on your Mac yet, install it ([docs](https://code.claude.com/docs/en/setup)):

```sh
curl -fsSL https://claude.ai/install.sh | bash
```

Then create the token. It prints a long-lived token for your subscription and doesn't save it ([docs](https://code.claude.com/docs/en/cli-reference)):

```sh
claude setup-token
```

In Settings, choose **Claude setup-token** and paste the token. Agents get it as `CLAUDE_CODE_OAUTH_TOKEN`. Boss Man refuses a token with stray spaces or quotes and says why.

**GitHub token.** Create a [fine-grained personal access token](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens#creating-a-fine-grained-personal-access-token):
- **Repository access:** only the repos the company works on.
- **Permissions:** Contents and Pull requests, both read and write.

In Settings, choose **GitHub token**. Agents get it as `GIT_TOKEN`, and it's used for clone, fetch and push. It's never written into a URL or onto disk.

Boss Man merges approved work by pushing to the default branch (R46). If that branch is protected so that only pull requests can change it, the push is refused and the ticket goes back to the agent with the error. In that case, allow the token to push, or ask the agents for pull requests through the git templates instead.

**Funding.** Under **Agents and what pays for them**, add a funding source:
- "Subscription (setup-token)" for a Claude subscription;
- "API credit" with your monthly grant for an API key.

Then set each agent's **Paid from** to that source, so cost and quota are tracked.

## 9. Updates and checks

**See what's running:**

```sh
sudo docker compose ps
```

**Server logs:**

```sh
sudo docker compose logs --tail 100 server
```

**Update to the latest code:**

```sh
sudo git pull && sudo docker compose build server && sudo docker compose up -d db server
```

**New Claude Code release, roughly weekly (R9):** this checks a new runner image with the canary and keeps the old one for rollback.

```sh
sudo scripts/update-runner.sh
```

**Undo a runner update:**

```sh
sudo scripts/update-runner.sh --rollback
```

**After a TrueNAS update,** check `sudo docker compose ps`. Images and containers live on the apps pool and survive OS updates. TrueNAS doesn't document how its own app actions treat containers started from the shell. Running Boss Man as its own `boss-man` project is what keeps it out of their way.

**Backups.** Snapshot `apps/boss-man` and keep a copy of `src/secrets/master.key` off the NAS. A Postgres data folder copied while the database is running may not restore cleanly. For a consistent backup, also dump it:

```sh
sudo docker compose exec -T db pg_dump -U bossman bossman | gzip | sudo tee /mnt/<pool>/apps/boss-man/bossman-$(date +%F).sql.gz > /dev/null
```
