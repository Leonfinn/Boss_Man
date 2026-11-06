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
- A root shell on the NAS: TrueNAS UI > System > Shell, or `su -` over SSH. Every command in this guide is typed there, so none has `sudo` in front.
- A Claude Pro or Max subscription for a setup-token, or an Anthropic API key.
- A GitHub account that can create a fine-grained token for the repos the agents will work on, and read access to the Boss Man repo from the NAS: a read-only deploy key if the repo is private, nothing if it is public (see [docs/00, step 2](00-first-time-install.md#2-get-the-code-onto-the-host)).

The commands below put Boss Man in `/mnt/NVME_Apps/Container_files/boss-man`, next to your other container apps on the mirrored NVMe pool. If you keep it somewhere else, change that path everywhere it appears. Replace `<nas-ip>` with the NAS's LAN address. Your router is at 192.168.68.1, so the NAS is most likely on 192.168.68.x. Check it in the TrueNAS UI under Network.

## 1. Create a dataset

Boss Man gets its own dataset under `Container_files`, so you can snapshot and roll it back on its own.

First check that `Container_files` is a dataset and not a plain folder. In a root shell on the NAS (step 2 says how to open one):

```sh
zfs list -o name,mountpoint -r NVME_Apps
```

If `NVME_Apps/Container_files` is in the list, it's a dataset. In the TrueNAS UI, go to Datasets, select `NVME_Apps/Container_files`, and Add Dataset:
- **Name:** `boss-man`.
- **Dataset preset:** Generic. Generic datasets use a POSIX ACL, so ordinary `chown` and `chmod` behave as expected ([TrueNAS docs](https://www.truenas.com/docs/scale/25.10/scaletutorials/datasets/permissionsscale/)). Pick Generic even if `Container_files` itself was made with the Apps preset, which uses an NFSv4 ACL that can override them.

If `Container_files` isn't in the list, it's a plain folder, and TrueNAS can't create a dataset inside it. Then just make the folder; snapshots of the dataset that holds `Container_files` still cover it:

```sh
mkdir -p /mnt/NVME_Apps/Container_files/boss-man
```

Everything Boss Man keeps goes in this folder.

## 2. Get the code

Open a root shell on the NAS (TrueNAS UI > System > Shell, or `ssh admin@<nas-ip>` from your Mac and then `su -`). Go to the dataset:

```sh
cd /mnt/NVME_Apps/Container_files/boss-man
```

How the NAS reads the repo (a deploy key if it is private, https if it is public) is in [docs/00, step 2](00-first-time-install.md#2-get-the-code-onto-the-host). Use `$B` as `/mnt/NVME_Apps/Container_files/boss-man` there. For a public repo the clone is:

```sh
git clone <repo-https-url> src
```

Later `git pull`s, `scripts/deploy.sh` and the host deployer's `git ls-remote` read the same remote, so there is nothing more to set up.

If git isn't on the host (`git --version` fails), let me know: the throwaway-container route isn't covered by this guide yet.

If the clone hangs, see the troubleshooting lines in [docs/00, step 2](00-first-time-install.md#2-get-the-code-onto-the-host).



## 3. Folders and ownership

The server and runners run as uid 1000. Postgres runs as its own user and sets the ownership of its own data folder on first start, so you only create that folder. These commands use full paths, so they work from any folder.

```sh
mkdir -p /mnt/NVME_Apps/Container_files/boss-man/data/postgres /mnt/NVME_Apps/Container_files/boss-man/data/app-co/workspaces /mnt/NVME_Apps/Container_files/boss-man/data/app-co/runner-data /mnt/NVME_Apps/Container_files/boss-man/data/app-co/claude /mnt/NVME_Apps/Container_files/boss-man/src/secrets
```

```sh
chown -R 1000:1000 /mnt/NVME_Apps/Container_files/boss-man/data/app-co /mnt/NVME_Apps/Container_files/boss-man/src/secrets && chmod 700 /mnt/NVME_Apps/Container_files/boss-man/src/secrets
```

## 4. Settings and the master key

Go to the repo folder. The `docker compose` commands from here on must run from `/mnt/NVME_Apps/Container_files/boss-man/src`.

```sh
cd /mnt/NVME_Apps/Container_files/boss-man/src
```

The master key encrypts every stored secret. Back it up somewhere safe outside the NAS. Without it, stored secrets can't be read.

```sh
openssl rand -base64 32 > /mnt/NVME_Apps/Container_files/boss-man/src/secrets/master.key && chown 1000:1000 /mnt/NVME_Apps/Container_files/boss-man/src/secrets/master.key && chmod 600 /mnt/NVME_Apps/Container_files/boss-man/src/secrets/master.key
```

Compose won't start anything while a secret file is missing, so create the runner's token file now, empty. You fill it in at step 7.

```sh
touch /mnt/NVME_Apps/Container_files/boss-man/src/secrets/runner-app-co.token && chown 1000:1000 /mnt/NVME_Apps/Container_files/boss-man/src/secrets/runner-app-co.token && chmod 600 /mnt/NVME_Apps/Container_files/boss-man/src/secrets/runner-app-co.token
```

Create `.env`. Compose reads it automatically. Its first two lines add the TrueNAS file and start the runners, so plain `docker compose` commands and the update script both use them.

```sh
cat > /mnt/NVME_Apps/Container_files/boss-man/src/.env <<EOF
COMPOSE_FILE=docker-compose.yml:deploy/truenas.yml
COMPOSE_PROFILES=runners
BOSSMAN_DATA=/mnt/NVME_Apps/Container_files/boss-man/data
POSTGRES_PASSWORD=$(openssl rand -hex 24)
BOSSMAN_BIND=<nas-ip>
BOSSMAN_HOST_PORT=3101
BOSSMAN_PORTAL_HOST_PORT=3102
BOSSMAN_INSECURE_COOKIES=1
EOF
```

```sh
chmod 600 /mnt/NVME_Apps/Container_files/boss-man/src/.env
```

- `BOSSMAN_BIND` publishes the web UI on the NAS's LAN address only. The TrueNAS UI keeps 80 and 443.
- `BOSSMAN_HOST_PORT` is the NAS port for the web UI. Paperclip already uses 3100 on your NAS, so this guide uses 3101. `BOSSMAN_PORTAL_HOST_PORT` (3102) is the feedback portal's port (step 11). Inside the containers they stay 3100 and 3101, so nothing else changes. Don't forward either port on the router.
- Check both ports are free before you start. This prints nothing if they are:

  ```sh
  ss -tlnp | grep -E ':(3101|3102)\b'
  ```

  If either is taken, pick other free ports and use them in `.env` and in the addresses below.
- `BOSSMAN_INSECURE_COOKIES=1` lets you log in over plain `http://<nas-ip>:3101` on your LAN. Once the Tailscale sidecar of section 10b is running (it sets `BOSSMAN_TRUSTED_PROXIES`), Boss Man decides per request: Secure on HTTPS through the sidecar, off on plain LAN http, whatever this line says, so you can leave it or remove it. Without the sidecar, removing it makes the cookie always Secure and plain http login fails.
- Plain LAN login only works because `BOSSMAN_BIND` is set to the NAS address above (the default, 127.0.0.1, is reachable from the NAS itself only).
  - Browsers only allow notifications (R44) and the installable web app on HTTPS pages, so do 10b.

Memory limits for the server, database, runners and tool servers are set from this file too: see [docs/00, "Memory limits"](00-first-time-install.md#memory-limits-so-one-container-cant-take-the-whole-host). Nothing to add on TrueNAS; the defaults apply.

## 5. Build the images and start the server

Build the server image, which includes the web UI, and start Postgres and the server. For now, start them without the runner, which has no token yet.

```sh
docker compose build server
```

```sh
docker compose up -d db server
```

Build the runner image with the canary check. The script builds a candidate image and runs a real Claude Code session in it, with networking off and no credentials. It tags the image `boss-man-runner:current` only if that passes.

```sh
scripts/update-runner.sh
```

With no launcher yet, the script also runs `docker compose up -d` at the end (a runner update later drains first, step 7b). Until its token file holds a token (step 7), the runner stops at start-up with "Set BOSSMAN_RUNNER_TOKEN_FILE..." and Docker keeps restarting it. That's expected.

## 6. First login and the setup wizard

Open `http://<nas-ip>:3101` on your Mac and create the owner account. The **setup wizard** opens. It has eight steps; each can be skipped and done later, and it remembers where you were. Anything left over shows as **Finish setting up** on Decisions until it's done or you dismiss it. **Run the setup wizard**, at the top of Settings, brings it back.

1. **Your company:** a name, for example "Boss Man Co", and what it's for. The CEO plans from this.
2. **A project:** a name, for example "Boss Man", and its **Git repo**:
   - GitHub: `https://github.com/Leonfinn/Boss_Man.git`
   - your Gitea: `http://192.168.68.67:3003/<owner>/<repo>.git` (plain http is allowed for private LAN addresses)
3. **The runner:** set it up with step 7b (the launcher, recommended) or step 7, then come back. It shows **Connected** when it's up.
4. **Claude:** a setup-token or API key (step 8).
5. **A git token** (step 8). **Check the token against <project>** reads the repo once and says whether the token can push. It changes nothing.
6. **Checks before merging:** **Before merging, Boss Man will** proposes a check from the repo through the runner. For Boss Man itself that's **Run the tests (detected)**: `pnpm install --frozen-lockfile && pnpm typecheck && pnpm test`. Until a runner is connected it offers the standard list; choose **Re-detect** once it is.
7. **What pays for the CEO:** add a funding source and pick it for the CEO (step 8).
8. **A first task:** optional.

If you'd rather use the screens directly, **"I know what I'm doing, let me get on with it"** on the first step closes the wizard. Everything it does is also in **Settings**, **Projects** and **Agents**.

## 7. The runner token

In **Settings > Server and runner > Runner**, choose **Register a runner**. The token is shown once. Write it into the token file without it landing in your shell history: run the command, paste the token, press Return, then Ctrl-D.

```sh
cat > /mnt/NVME_Apps/Container_files/boss-man/src/secrets/runner-app-co.token
```

The token file must hold only the token. A trailing newline is fine, because the runner trims it.

```sh
docker compose up -d
```

Settings > Server and runner > Runner should show **Connected** within a minute.

The example service is called `runner-app-co`. For a second company:
1. Copy its block in `docker-compose.yml` and its volumes in `deploy/truenas.yml` under a new name.
2. Give the copy its own token file and its own `data/<company>/` folders.

## 7b. Let the launcher run the runners (recommended)

With the launcher (R55), each company's runner starts by itself when you create the company, and **Settings > Server and runner > Runner** gets **Start**, **Reconnect**, **Restart** and **Stop** buttons. There are no token files to copy and no compose blocks to duplicate per company.
- **How it stays safe.** The launcher is the only container that can reach Docker. It joins the socket's group (`docker`, group 999 on your NAS, from `stat -c '%U:%G %g %a %n' /var/run/docker.sock`) instead of running as root.
- **What it accepts.** It publishes no ports, and only the server can reach it, over an internal network with a key. It accepts only "start, stop or restart company X's runner".
- **What it builds.** It builds the container itself: uid 1000, all capabilities dropped, `no-new-privileges`, not privileged, the 4 GB memory limit, and only that company's folders under `data/companies/<slug>`.

These steps move an existing install, including the compose runner from step 7, over to the launcher. Run them from the repo folder.

```sh
cd /mnt/NVME_Apps/Container_files/boss-man/src && git pull
```

The launcher keeps company data under `data/companies`, owned by uid 1000:

```sh
mkdir -p /mnt/NVME_Apps/Container_files/boss-man/data/companies && chown 1000:1000 /mnt/NVME_Apps/Container_files/boss-man/data/companies
```

In `.env`, replace `COMPOSE_PROFILES=runners` with the launcher profile and turn it on. The first command shows the file so you can check it before changing it.

```sh
cat /mnt/NVME_Apps/Container_files/boss-man/src/.env
```

```sh
sed -i 's/^COMPOSE_PROFILES=runners$/COMPOSE_PROFILES=launcher/' /mnt/NVME_Apps/Container_files/boss-man/src/.env && printf 'BOSSMAN_LAUNCHER=1\nBOSSMAN_DOCKER_GID=999\n' >> /mnt/NVME_Apps/Container_files/boss-man/src/.env
```

Stop and remove the old compose runner. Its folders in `data/app-co` stay where they are.

```sh
docker compose --profile runners rm -sf runner-app-co
```

Build the launcher and the server, then start everything:

```sh
docker compose build server launcher && docker compose up -d
```

Open **Settings > Server and runner > Runner** and choose **Start runner**. It shows **Starting…**, then **Connected** within a minute. A new company's runner starts by itself.

- **The old runner's work.** The new runner starts with empty folders under `data/companies/<slug>`, where `<slug>` comes from the company's name (e.g. `boss-man-co`) and is shown in Settings > Server and runner > Runner. To bring over unfinished work and Claude sessions, choose **Stop**, then copy the old folders, then choose **Start runner** again:

  ```sh
  cp -a /mnt/NVME_Apps/Container_files/boss-man/data/app-co/. /mnt/NVME_Apps/Container_files/boss-man/data/companies/boss-man-co/
  ```

- **Updates.** `scripts/update-runner.sh` builds and checks the new image, then Boss Man drains (nothing new starts, runs finish) and the launcher recreates each company's runner as soon as that company is idle; `--rollback` does the same onto the previous image, and `--now` recreates everything at once (see the runner update section below).
- **Going back.** Choose **Stop** in Settings > Server and runner > Runner, put `COMPOSE_PROFILES=runners` back in `.env`, remove the two lines you added, and follow step 7.

## 8. Credentials and funding

Make both credentials on your Mac, then paste them into **Settings > Secrets**. Values are encrypted on the server and never shown again.

**Claude setup-token.** If Claude Code isn't on your Mac yet, install it ([docs](https://code.claude.com/docs/en/setup)):

```sh
curl -fsSL https://claude.ai/install.sh | bash
```

Then create the token. It prints a long-lived token for your subscription and doesn't save it ([docs](https://code.claude.com/docs/en/cli-reference)):

```sh
claude setup-token
```

On the Secrets page, choose **Claude setup-token** and paste the token. Agents get it as `CLAUDE_CODE_OAUTH_TOKEN`. Boss Man refuses a token with stray spaces or quotes and says why.

**Git token, for GitHub.** Create a [fine-grained personal access token](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens#creating-a-fine-grained-personal-access-token):
- **Repository access:** only the repos the company works on.
- **Permissions:** Contents, Pull requests and Workflows, all read and write. Without Workflows, any change to `.github/workflows/` can't be pushed.

**Git token, for Gitea.** In Gitea 28, open your avatar menu > **Settings > Applications**, then under **Manage Access Tokens > Generate New Token**:
- **Token Name:** for example "boss-man".
- **Repository and Organization Access:** **All (public, private, and limited)**.
- **repository:** **Read and Write** (the `write:repository` scope, which the pull-request routes need). Leave the rest at **No Access**.

Choose **Generate Token** and copy it; Gitea shows it only once. The token can do what your Gitea user can, so a user with write access to the repo is enough. (Labels from Gitea 28.0.0's [`access_tokens.tmpl`](https://github.com/go-gitea/gitea/blob/v28.0.0/templates/shared/user/access_tokens.tmpl); see also Gitea's [scopes documentation](https://docs.gitea.com/development/oauth2-provider#scopes).)

On the Secrets page, choose **Git token (GitHub or Gitea)** and paste it. Boss Man's runner holds it as `GIT_TOKEN` (agents' sessions never see it, so an agent can't push by itself), and it's used for clone, fetch, push and pull requests. It's never written into a URL or onto disk. The wizard's git step, or the same check on the Projects page, tells you whether it can push.

**When work is approved** (the Projects page) is either **Merge into the default branch** (R46) or **Open a pull request** (R59). If the default branch is protected so that only pull requests can change it, choose the pull request option; a direct push would be refused and the ticket would go back to the agent with the error.

**Funding.** Under **Settings > Access and funding > Funding sources**, add one:
- "Subscription (setup-token)" for a Claude subscription;
- "API credit" with your monthly grant for an API key.

Then, on the **Agents** page, set each agent's **Paid from** to that source, so cost and quota are tracked. The same page sets each agent's **Model** from what the runner and your API keys offer.

## 9. Updates and checks

**See what's running:**

```sh
docker compose ps
```

**Server logs:**

```sh
docker compose logs --tail 100 server
```

**Update to the latest code** with the deploy script. It backs up the database, pulls, rebuilds, restarts, waits until the server reports healthy, and updates the runners only when their code changed. Run it from the `src` folder:

```sh
scripts/deploy.sh
```

It stops if the working tree has uncommitted changes, if you are not on the default branch, or if there is nothing new (add `--force` to rebuild anyway). Backups go to the folder above the checkout, here `/mnt/NVME_Apps/Container_files/boss-man/bossman-YYYY-MM-DD-HHMM.sql.gz` (the newest 14 are kept; set `BOSSMAN_BACKUP_DIR` or `BOSSMAN_BACKUP_KEEP` to change that). The result of the last run is in `deploy-status.json` next to them. Useful options:

- `--dry-run` shows the steps without running anything.
- `--runner` / `--no-runner` force or skip the runner update. Updating runners builds the image and asks Boss Man to drain first (runs in progress finish); without the launcher it restarts them at once and cuts runs off. The script asks first (`--yes` skips the question).
- `--commit <40-character hash>` deploys exactly that commit (it must be a fast-forward of what runs). The host deployer (step 9a) uses it.
- `--rollback` puts the previous commit back and rebuilds. It never touches the database. If a deploy fails the health check, the script prints the exact rollback and restore commands and changes nothing by itself.

Database changes apply by themselves when the server starts.

**The manual steps** (the same thing, by hand, if the script is ever unavailable):

```sh
docker compose exec -T db pg_dump -U bossman bossman | gzip > /mnt/NVME_Apps/Container_files/boss-man/bossman-$(date +%F-%H%M).sql.gz
```

```sh
git pull && docker compose build server launcher && docker compose up -d
```

Leave `launcher` out of the build if you don't use it (step 7b).

`docker compose build` skips the runner image (it sits behind the `runners` profile), so runners keep their old code until you run the next command. With the host deployer set up (step 9), you can skip the shell: **Settings → Server and runner → Updates → Build and update runners** asks you once, then does the same thing. Run it after any update that changes `apps/runner`, `apps/launcher`, `packages/shared` or `pnpm-lock.yaml`, and for each new Claude Code release, roughly weekly (R9). It checks a new runner image with the canary and keeps the old one for rollback. It then asks Boss Man to **drain** (`docs/09-self-deploy.md`, phase 2): a banner appears on every page, nothing new starts in any company, runs in progress finish, and each company's runner is swapped as soon as it is idle. When every runner is on the new image the banner goes, and you get a notification. If runs are still going after 30 minutes (`BOSSMAN_DRAIN_MINUTES` in `.env` changes that) you get one decision: stop them and update now, keep waiting another 30 minutes, or cancel the update. Companies you paused stay paused.

```sh
scripts/update-runner.sh
```

The script returns as soon as it has asked; follow the swap in the banner or **Settings > Server and runner > Runner update**, which also has **Cancel the update**. It finds the deployer folder from `BOSSMAN_DEPLOYER` in `.env` (step 9a). If you have not set that up, it says so and leaves the swap for you to start with **Update runners** in Settings > Server and runner > Runner update.

**Runner add-ons** (docs/12) are optional tools baked into the runner image, off by default. To give agents a browser (`agent-browser`, which drives Debian's Chromium), add this line to `.env`, then run `scripts/update-runner.sh` as above. The canary opens and closes a blank page in the new image before it is used. Remove the line and update again to take the add-on out.

```sh
RUNNER_ADDONS=agent-browser
```

**Emergency: restart every runner now,** cutting off runs in progress (crash recovery restarts them):

```sh
scripts/update-runner.sh --now
```

**Undo a runner update** (drains onto the previous image; add `--now` to do it at once):

```sh
scripts/update-runner.sh --rollback
```

**After a TrueNAS update,** check `docker compose ps`. Images and containers live on the apps pool and survive OS updates. TrueNAS doesn't document how its own app actions treat containers started from the shell. Running Boss Man as its own `boss-man` project is what keeps it out of their way.

**Backups.** Snapshot the `boss-man` dataset (or the one that holds it) and keep a copy of `src/secrets/master.key` off the NAS. A Postgres data folder copied while the database is running may not restore cleanly. For a consistent backup, also dump it:

```sh
docker compose exec -T db pg_dump -U bossman bossman | gzip > /mnt/NVME_Apps/Container_files/boss-man/bossman-$(date +%F).sql.gz
```

**Prove the backup restores.** A backup nobody has restored is a hope. This loads the newest backup into a throwaway database beside the live one (the live database is never written to), counts accounts, projects and tickets, prints how long it took and how much would be lost, and drops the throwaway:

```sh
cd /mnt/NVME_Apps/Container_files/boss-man/src && scripts/restore-test.sh --fresh-backup
```

**Restore the live database from a backup (last resort).** Only when a deploy has damaged the data itself. If the code is the problem, use `scripts/deploy.sh --rollback` (or `host-deployer.sh --rollback`) instead: they never touch the data. A restore **replaces the live data** and loses everything written after the backup was taken. Do it at a quiet time, and ask for help if anything below does not look as described. Run every command as root from the checkout, `cd /mnt/NVME_Apps/Container_files/boss-man/src`. The backups are in the folder above it.

1. Pick the backup and rehearse it on the throwaway database first (the live database is not written to). It must end with a line starting `OK:`. If it does not, stop and choose another file:
```sh
ls -lt ../bossman-*.sql.gz | head -5
```
```sh
scripts/restore-test.sh ../bossman-YYYY-MM-DD-HHMM.sql.gz
```
2. Note the data you will lose: the "live minus restored" column of that output, and the age on its `Backup:` line.
3. Stop the app so nothing writes. With the single server install:
```sh
docker compose stop server
```
   With blue/green (step 9d), stop both colours:
```sh
docker compose stop server-blue server-green
```
4. Keep a copy of the current, damaged data in case the restore was the wrong call (this file is a full copy of your data; delete it when you are sure):
```sh
docker compose exec -T db pg_dump -U bossman bossman | gzip > ../before-restore-$(date +%F-%H%M).sql.gz && ls -l ../before-restore-*.sql.gz
```
5. Replace the live database. The first command fails with "being accessed by other users" if something is still connected: go back to step 3 and do not continue.
```sh
docker compose exec -T db psql -U bossman -d postgres -c 'DROP DATABASE bossman' -c 'CREATE DATABASE bossman OWNER bossman'
```
```sh
gunzip -c ../bossman-YYYY-MM-DD-HHMM.sql.gz | docker compose exec -T db psql -v ON_ERROR_STOP=1 -q -U bossman -d bossman
```
6. Start the app. Single server:
```sh
docker compose up -d
```
   Blue/green: first bring the schema up to what the running code expects (a restored older backup may be behind), using the live colour (`blue` below; find it with `grep reverse_proxy $D/proxy/active.caddy`, where `$D` is the deployer folder from step 9), then start only that colour:
```sh
BOSSMAN_MIGRATE_TAG=blue docker compose run --rm migrate
```
```sh
docker compose up -d --no-deps server-blue
```
   If the live colour is green, also run `docker compose kill -s SIGUSR2 server-green`; green starts as a standby and nothing is in charge until it gets that signal.
7. Check: `curl -s http://<nas-ip>:3101/api/ready` shows `"role":"leader"`; sign in and open Tickets; and compare the counts with the rehearsal output:
```sh
docker compose exec -T db psql -U bossman -d bossman -tA -c 'SELECT count(*) FROM tickets' -c 'SELECT count(*) FROM drizzle.__drizzle_migrations'
```
8. To undo the restore (step 4's copy holds the damaged state): repeat steps 3, 5 and 6 with `../before-restore-….sql.gz`.

If step 5's second command stops with an error, the new empty database is half filled: do not start the app. Repeat step 5 (it drops and recreates) with the same or an older backup.

**Starting again.** To throw away an install and redo it from step 2, stop it and delete the repo and data folders. This deletes the database and every workspace. It keeps nothing git-related to redo: the repo is cloned fresh (a deploy key, if you use one, stays in place). Check what's there first:

```sh
ls -la /mnt/NVME_Apps/Container_files/boss-man
```

```sh
cd /mnt/NVME_Apps/Container_files/boss-man/src && docker compose down; cd /mnt/NVME_Apps/Container_files/boss-man
```

```sh
rm -rf /mnt/NVME_Apps/Container_files/boss-man/src /mnt/NVME_Apps/Container_files/boss-man/data
```

## 9a. Install the host deployer (optional)

This lets you update Boss Man from its own Decisions page: when `main` moves on GitHub, Boss Man asks "Deploy abc1234?", and on your approval a root script on the NAS runs `scripts/deploy.sh`. How it works and what it refuses is in `docs/09-self-deploy.md`. Nothing here gives a container `docker.sock`.

Everything below is typed in a **root shell** on the NAS (TrueNAS UI > System > Shell, or `su -` over SSH), so there is no `sudo` in front of the commands. Do the steps in this order. Set the folder once in the shell, and use it in every step:

```sh
D=/mnt/NVME_Apps/Container_files/boss-man/deployer
```

**Before you start**
- `main` on GitHub should be branch-protected, so agents can only land reviewed PRs: Repo > Settings > Branches > add a rule for `main` that requires a pull request. The deployer treats the tip of `main` as approved code.
- The `src` checkout must be on `main`, clean, and able to read the remote (https for a public repo, the deploy key for a private one). Check that the NAS sees the tip of `main`; it prints one line, a hash and `refs/heads/main`:

  ```sh
  git -C /mnt/NVME_Apps/Container_files/boss-man/src ls-remote origin refs/heads/main
  ```

**1. Get this code onto the NAS, by hand.** The change that adds the deployer edits `scripts/` and `deploy/`, which the deployer itself refuses to deploy, so the first time is yours:

```sh
cd /mnt/NVME_Apps/Container_files/boss-man/src && scripts/deploy.sh
```

Nothing changes for Boss Man yet: the new compose file is opt-in (step 6).

**2. Create the folders.** The server (uid 1000) may write only `inbox`; it reads `outbox`.

```sh
mkdir -p $D/inbox $D/outbox $D/state
chown root:root $D $D/outbox $D/state && chmod 755 $D $D/outbox && chmod 700 $D/state
chown 1000:1000 $D/inbox && chmod 750 $D/inbox
ls -ld $D $D/inbox $D/outbox $D/state
```

`ls` may show `inbox` as owned by another name, such as `n8n`: TrueNAS shows uid 1000 by the name of whichever app user has it. What matters is the number 1000 (`ls -ldn $D/inbox` shows it).

**3. Install the script as a copy.** Read it first (`less /mnt/NVME_Apps/Container_files/boss-man/src/scripts/host-deployer.sh`). Copy it; do not make a link into the checkout, because a link would let a merged PR change what root runs.

```sh
cp /mnt/NVME_Apps/Container_files/boss-man/src/scripts/host-deployer.sh $D/host-deployer.sh
chown root:root $D/host-deployer.sh && chmod 750 $D/host-deployer.sh
```

When a later change touches `scripts/host-deployer.sh`, the deployer refuses to deploy it (scripts are infra). Read the diff, hand-deploy with `scripts/deploy.sh`, and copy it over again.

Merge a PR that touches infra files on its own, after the app PRs before it are deployed. The deployer offers only the tip of `main`, so while an unapplied infra change is anywhere in that range, every later app PR is stuck behind it too, until you apply it by hand.

To see whether your copy is current:

```sh
diff $D/host-deployer.sh /mnt/NVME_Apps/Container_files/boss-man/src/scripts/host-deployer.sh && echo same
```

**4. The config file, with the alert webhook.** This is the whole alert setup. It lives only here, not in Boss Man, so it still works when Boss Man is down. Keep the single quotes (a URL can contain `?` and `&`). Replace the address with your Home Assistant's, and the last part with the long random ID you will use in the automation (see "Home Assistant" below):

```sh
cat > $D/host.conf <<'EOF'
WEBHOOK_URL='http://homeassistant.local:8123/api/webhook/PUT-A-LONG-RANDOM-ID-HERE'
WEBHOOK_ON_SUCCESS=1
EOF
chown root:root $D/host.conf && chmod 600 $D/host.conf
```

- `WEBHOOK_ON_SUCCESS=1` also posts when a deploy works; `0` (the default) posts only failures (`failed`, `partial`, `rolled_back`, `rejected`).
- Optional lines: `REPO=` (the checkout; default `$D/../src`), `RATE_LIMIT_SECONDS=600` and, with blue/green (9d), `SOAK_SECONDS=900`. The host publishes `SOAK_SECONDS` in `outbox/available.json` as `soakSeconds`, so Boss Man's runner-update trial uses the same length you set here (no second place to keep in step).
- The script refuses to start if this file is not owned by the user running it with mode 600.
- It sends `POST` with `Content-Type: application/json` and a body like `{"result":"failed","message":"...","from_commit":"...","to_commit":"...","at":"2026-10-20T12:03:00Z"}`. Any service that takes a JSON webhook works. ntfy's JSON publish needs a `topic` field this body does not have, so for ntfy use a small relay or Home Assistant; that is untested.

Test the webhook alone, with the same URL, before anything else:

```sh
. $D/host.conf && curl -fsS -X POST -H 'Content-Type: application/json' -d '{"result":"failed","message":"Test from the NAS","from_commit":"aaaaaaaa","to_commit":"bbbbbbbb","at":"2026-10-20T12:00:00Z"}' "$WEBHOOK_URL" && echo sent
```

Your phone should buzz. `sent` only means Home Assistant accepted the request: it answers `200` even when no automation listens on that ID (seen on a real install, where the cause turned out to be a mistake in the automation's YAML). If you get `sent` and no buzz, check that the automation saved without errors and that its `webhook_id` matches the end of `WEBHOOK_URL` exactly.

**5. Test the script.** First with no request: it reads `main` and writes what is waiting.

```sh
$D/host-deployer.sh && cat $D/outbox/available.json
```

Then rehearse a request without running anything. `--dry-run` runs every check and leaves the file where it is:

```sh
TIP=$(git -C /mnt/NVME_Apps/Container_files/boss-man/src ls-remote origin refs/heads/main | cut -f1)
printf '{"id":"00000000-0000-4000-8000-000000000001","target":"server","commit":"%s","requestedAt":"2026-10-20T12:00:00Z","approvedBy":"me"}\n' "$TIP" > $D/inbox/request.json
$D/host-deployer.sh --dry-run
rm -f $D/inbox/request.json
```

You should see either `nothing_new: Nothing new: ... already deployed` (you are up to date) or `[dry-run] checks passed: would run: scripts/deploy.sh --yes --no-runner --commit ...`. A `rejected:` line says why.

**6. Let the server see the folders.** This is the one compose change, and it is also yours to apply. Add the opt-in file and the folder to `.env`, then recreate the server:

```sh
cd /mnt/NVME_Apps/Container_files/boss-man/src
sed -i 's#^COMPOSE_FILE=.*#&:deploy/truenas-deployer.yml#' .env
echo "BOSSMAN_DEPLOYER=$D" >> .env
grep -E '^(COMPOSE_FILE|BOSSMAN_DEPLOYER)=' .env
docker compose up -d server
docker compose exec server ls /run/deployer
```

`COMPOSE_FILE` should now end in `:deploy/truenas-deployer.yml`, and the last command should list `inbox` and `outbox`. Reload Boss Man: **Settings > Server and runner** now has an **Updates** section.

**7. The cron job.** In the TrueNAS UI: **System > Advanced > Cron Jobs > Add** (field names as of 25.10; UNVERIFIED, check them on your version):
- **Description:** `Boss Man host deployer`
- **Command:** `/mnt/NVME_Apps/Container_files/boss-man/deployer/host-deployer.sh`
- **Run As User:** `root`
- **Schedule:** choose **Custom** and put `*` in every field (Minutes, Hours, Days of month, Months, Days of week), which means every minute. The **Hourly** preset is not enough: it runs once an hour, so a deploy you approve could wait up to an hour.
- **Hide Standard Output:** ticked (the script keeps its own log). Leave **Hide Standard Error** unticked.
- **Enabled:** ticked.

Save it. A few minutes later `$D/outbox/available.json` should have a newer `checkedAt`. The log is `$D/deployer.log`.

**8. Try it for real.** When `main` is ahead, a "Deploy abc1234?" decision appears (with a notification); **Settings > Server and runner > Updates > Deploy latest** raises it on demand. Approve it. Within a minute the host starts, Boss Man restarts for a minute or two, and when it is back you get a notification and **Updates** shows the result. Watch it on the NAS with `tail -f $D/deployer.log`.

What you may see instead of a deploy:
- "Rejected: this change touches deployment files": run `scripts/deploy.sh` yourself in the `src` folder.
- "Rejected: only one server deploy every 10 minutes": wait, then press **Deploy latest**.
- "is not the tip of main": main moved after you approved; approve the new one. The host looks at `main` at most every 5 minutes, and not while a request is waiting, so after two merges close together Boss Man can briefly offer the older one. The host refuses it, drops its note, and offers the real tip within a minute or two. To refresh the note at once: `rm -f $D/outbox/available.json` (the next cron minute writes a new one).
- An alert saying the change touches deployment files when you have already applied it by hand: the note was written before you did. Press **Got it**; it refreshes within about 6 minutes.
- Runner code changed: after the server is deployed, a second decision "Update the runners?" appears. Anything under `packages/shared/` counts as runner code, even text the runner never reads (such as the agents' role text); when the change is only that, **Not now** is fine.
- Approving the runner update builds the new image, then drains: runs in progress finish and each runner is swapped when its company is idle, so there is no need to wait for quiet. Approving frees the host script within minutes; the result of the swap arrives as a Boss Man notification.

**Turn it off:** disable the cron job, or remove `:deploy/truenas-deployer.yml` from `COMPOSE_FILE` and run `docker compose up -d server`.

### Home Assistant: a phone alert from the webhook

Create an automation (Settings > Automations & Scenes > Create > Edit in YAML) with a `webhook` trigger. Pick a long random `webhook_id` (for example the output of `openssl rand -hex 24`); anyone who knows it can trigger the automation, so treat it like a password. This uses the current syntax (`triggers:` / `trigger: webhook`, `actions:` / `action:`), which Home Assistant introduced in 2024.10 (**UNVERIFIED** against your version):

```yaml
alias: Boss Man deploy alert
description: The NAS posts here when a Boss Man deploy fails or is refused.
triggers:
  - trigger: webhook
    webhook_id: "PUT-A-LONG-RANDOM-ID-HERE"
    allowed_methods:
      - POST
    local_only: true
actions:
  - action: notify.mobile_app_YOUR_PHONE
    data:
      title: "Boss Man deploy: {{ trigger.json.result }}"
      message: >-
        {{ trigger.json.message }}
        ({{ trigger.json.from_commit[:8] }} to {{ trigger.json.to_commit[:8] }})
mode: queued
```

- The webhook's address is `http://<home-assistant>:8123/api/webhook/<webhook_id>`; that is what goes in `WEBHOOK_URL`.
- `local_only: true` accepts only requests from your local network, so the NAS must reach Home Assistant directly, not through a public URL or a reverse proxy that adds forwarding headers.
- `trigger.json` is the parsed JSON body of the POST. `notify.mobile_app_YOUR_PHONE` is the notify action Home Assistant makes for your phone's companion app; find its exact name in Developer tools > Actions.
- Source for the trigger options and `trigger.json`: [Home Assistant, Webhook trigger](https://www.home-assistant.io/docs/automation/trigger/#webhook-trigger). That page could not be opened from where this was written, so the YAML above is from memory of it and not checked; test it with the curl line in step 4.

## 9b. Upgrading to v1.2

v1.2 adds the launcher, the setup wizard, merge check presets, Gitea and pull requests, the Agents page, the model picker and ticket watchers. The server applies any database changes when it starts. Run these in a root shell (no `sudo`), from the repo folder:

```sh
cd /mnt/NVME_Apps/Container_files/boss-man/src
```

1. **Back up the database** first:

   ```sh
   docker compose exec -T db pg_dump -U bossman bossman | gzip > /mnt/NVME_Apps/Container_files/boss-man/bossman-$(date +%F).sql.gz
   ```

2. **Update the code and the server:**

   ```sh
   git pull && docker compose build server && docker compose up -d db server
   ```

3. **Rebuild the runner.** The v1.2 server asks runners for things v1.1 runners don't know (detecting checks, pushing branches for pull requests, listing models), so the runner image has to match:

   ```sh
   scripts/update-runner.sh
   ```

4. **Move to the launcher** (recommended): step 7b. If you stay on the compose runner, step 3 is enough.

5. **Check in the UI:**
   - **Projects page:** your existing check command shows as the preset it matches (Boss Man's own matches **Run the tests (detected)** once the runner is connected), otherwise as **Custom command…**. Either is fine.
   - **Agents:** model and funding for each agent now live here.
   - The setup wizard doesn't open by itself on an install that already has a company. Open it with **Run the setup wizard** at the top of Settings if you want its checklist.

Keep the dump from step 1 until you're happy with v1.2. Going back means restoring it and checking out the older code, which hasn't been tried here, so ask before doing it.

## 9c. Upgrading to semantic wiki search

The `db` image changed from `postgres:17-alpine` to `pgvector/pgvector:0.8.7-pg17-bookworm`, Postgres 17 with the pgvector extension. The two images use different base systems, so start with a **fresh database volume**: there is no dump and restore path (this alpha has one user). Stop the stack, delete the database folder (`$BOSSMAN_DATA/postgres` on TrueNAS, or the `db-data` volume with plain compose), then `docker compose up -d`. Semantic search itself is off until you turn it on in **Wiki > Semantic search**.

## 9d. Switch to blue/green (optional)

With this, a server update has no "Boss Man is down for a minute" gap: the new version starts next to the old one, is checked, and takes over; the old one stays up for 15 minutes so the deployer can switch back by itself if checks fail. How it works, what it checks and what it cannot: `docs/09-self-deploy.md`, "Phase 3, part 2". It needs the host deployer (9a) already working. These steps were first run on a real TrueNAS SCALE NAS on 22 and 23 Oct 2026. Two bugs found then are fixed in the repo (see "If something goes wrong" below), so use a checkout at commit `5d983a16` or later. Do them with the stack quiet (no important agent runs), because step 6 is one planned stop of 1 to 2 minutes.

Root shell, no `sudo`. Set the variables once:

```sh
D=/mnt/NVME_Apps/Container_files/boss-man/deployer
cd /mnt/NVME_Apps/Container_files/boss-man/src
```

**1. Get the new files onto the NAS, by hand** (they are in `deploy/` and `scripts/`, which the deployer refuses to deploy). Boss Man keeps running as a single server:

```sh
scripts/deploy.sh
cp scripts/host-deployer.sh $D/host-deployer.sh && chown root:root $D/host-deployer.sh && chmod 750 $D/host-deployer.sh
ls deploy/truenas-bluegreen.yml deploy/caddy/Caddyfile
```

(Read the new `host-deployer.sh` first, as in 9a step 3.) Docker Compose must be 2.24 or newer for the compose file: `docker compose version`.

**2. Back up `.env` and the database.**

```sh
cp -p .env .env.before-bluegreen
docker compose exec -T db pg_dump -U bossman bossman | gzip > /mnt/NVME_Apps/Container_files/boss-man/before-bluegreen.sql.gz
ls -l .env.before-bluegreen /mnt/NVME_Apps/Container_files/boss-man/before-bluegreen.sql.gz
```

**3. Create the proxy folder, owned by root, with the first include.** Nothing a container can write to may hold this file:

```sh
mkdir -p $D/proxy && chown root:root $D/proxy && chmod 755 $D/proxy
cat > $D/proxy/active.caddy <<'EOF'
# Written by host-deployer.sh. Do not edit. Live colour: blue
(active) {
	reverse_proxy server-blue:{args[0]} {
		health_uri {args[1]}
		health_interval 2s
		health_timeout 2s
	}
}
EOF
chmod 644 $D/proxy/active.caddy
```

**4. Settings in `.env`.** UI on 3101 and the portal on 3111 stay settings. This helper replaces a line or adds it; check the result:

```sh
setenv() { if grep -q "^$1=" .env; then sed -i "s#^$1=.*#$1=$2#" .env; else echo "$1=$2" >> .env; fi; }
setenv BOSSMAN_HOST_PORT 3101
setenv BOSSMAN_PORTAL_HOST_PORT 3111
setenv BOSSMAN_PORTAL_BIND 192.168.68.67
setenv BOSSMAN_PORTAL_URL http://192.168.68.67:3111
grep -q '^BOSSMAN_DEPLOYER=' .env || echo "BOSSMAN_DEPLOYER=$D" >> .env
sed -i 's#^COMPOSE_FILE=.*#&:deploy/truenas-bluegreen.yml#' .env
grep -E '^(COMPOSE_FILE|BOSSMAN_HOST_PORT|BOSSMAN_PORTAL_HOST_PORT|BOSSMAN_PORTAL_BIND|BOSSMAN_PORTAL_URL|BOSSMAN_DEPLOYER|BOSSMAN_BIND)=' .env
```

`COMPOSE_FILE` must now end in `:deploy/truenas-bluegreen.yml`. `BOSSMAN_BIND` (the address the UI listens on) is unchanged: it must be the NAS address you use for `http://192.168.68.67:3101` (the proxy uses the same variable the server did). Use the same address in the browser as today, so the login cookie keeps working. Check the compose file renders: `docker compose config -q && echo ok`.

**5. First bring-up, in this order.** The image for blue is built and the database migrated before anything starts. Do not run a bare `docker compose up -d` during this.

```sh
BOSSMAN_COMMIT=$(git rev-parse HEAD) docker compose build server-blue
BOSSMAN_MIGRATE_TAG=blue docker compose run --rm migrate
```

**6. The cutover (the one planned stop).** The old single server and its ports go; the proxy and blue take over. The runners reconnect by themselves (their address, `ws://server:3100`, now points at the proxy):

```sh
docker ps --filter name=boss-man-server-1 --format '{{.Names}}'     # must print boss-man-server-1
docker stop boss-man-server-1 && docker rm boss-man-server-1
docker compose up -d --no-deps proxy server-blue
docker compose ps proxy server-blue
```

Wait for both to say `healthy`. Then check, using your NAS address:

```sh
curl -s http://192.168.68.67:3101/api/ready; echo
curl -s -o /dev/null -w '%{http_code}\n' http://192.168.68.67:3111/portal.html
grep 'Live colour' $D/proxy/active.caddy
docker compose logs server-blue | grep 'LEADER: \*\*\*'
```

The first line should show `"role":"leader"`, the second `200`, the third `blue`. In Boss Man, **Settings > Server and runner > Runner** should show each company's runner `Connected` within a minute: runners retry every 30 seconds, and reconnect through the proxy by themselves. **Settings > Server and runner > Server** shows "Blue/green: On" with blue Live and green Not running. If any of this is wrong: "If something goes wrong" below, or "Go back".

**7. Try a swap.** `$D/host-deployer.sh --dry-run` with a request (as in 9a step 5) should say `would run: a blue/green swap to ...`. For a real one, approve a deploy as usual. Watch with `tail -f $D/deployer.log`; a good swap ends with a line like `deployed: Deployed 5d983a16 to 46822c2b: green is live; blue stays up as a standby for 15 minutes`. The UI stays up throughout. **Settings > Server and runner > Server** then shows green Live and blue Standby, and **Settings > Server and runner > Runner** shows "Connected since" the time of the swap. A good swap leaves the old colour running for 15 minutes (`SOAK_SECONDS=900`, changeable in `host.conf`); a later cron minute then stops it.

**Which colour is live?**

```sh
grep 'Live colour' $D/proxy/active.caddy
docker compose ps --format '{{.Service}} {{.Status}}' | grep server-
curl -s http://192.168.68.67:3101/api/health; echo     # "role":"leader"; the commit it was built from
```

**What the deployer will not do for you**
- It refuses any change to infra files: `deploy/` (including the Caddyfile), the compose files, the deploy scripts (`scripts/deploy.sh`, `rebuild-live.sh`, `update-runner.sh`, `host-deployer.sh`; build-only scripts do not count, see docs/09 step 6) and any `Dockerfile`. `scripts/deploy.sh` refuses to run on this install too. Apply such a change by hand, after merging it on its own (see 9a step 3):
  - **Everything starts the same way:** bring the checkout up to `main` with `git fetch origin main && git merge --ff-only origin/main`.
  - **A `Dockerfile` or other server-image change:** rebuild the live colour in place, as in "Rebuild the live colour in place" below.
  - **The Caddyfile:** `docker compose exec proxy caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile`. The Caddyfile now has `encode zstd gzip` on both sites, so the proxy compresses API JSON on the way out. The runner websocket (`/api/runner/connect`) and other streaming responses are never compressed: Caddy leaves an upgrade or streaming response alone. Confirming on staging: `curl -sI -H 'Accept-Encoding: gzip' http://<host>:3100/api/ready` should answer `content-encoding: gzip` once a response is big enough to be worth compressing (Caddy leaves very small ones alone).
  - **The proxy's compose settings:** `docker compose up -d --no-deps proxy`, which leaves the UI down for a few seconds.
  - **The launcher** (`apps/launcher/` or its compose settings): it runs its own image built from this checkout, so rebuild it first, or the old code keeps running: `docker compose build launcher && docker compose up -d --no-deps launcher`. The UI stays up. Runners keep their old limits until they are recreated: at the next runner update, or now with `docker compose exec launcher node dist/main.js recreate-all`, which cuts off runs in progress (crash recovery restarts them).
  - **`scripts/host-deployer.sh`:** copy it to `$D` as in 9a step 3.
- **Compression is not the Caddyfile's job alone.** The web build now writes a brotli and a gzip copy next to every built asset, and the server serves those straight from disk, so **every** install (including the plain `docker-compose.yml` one with no proxy) sends compressed JavaScript, CSS and fonts with no CPU cost per page. What the proxy adds is compression of the **API JSON** (the polled dashboard data); a plain install sends that JSON uncompressed. If you want the JSON compressed without the proxy too, that is a separate change (it spends CPU on the server's event loop) and not part of this install.
- After a hand-applied change, the deployer may still show the alert about deployment files for a few minutes: press **Got it**.
- Runner updates are unchanged (the drain); they never touch the proxy.

**Rebuild the live colour in place.** This is for an image change the deployer refuses, or for a colour built from an older image. For ordinary app changes use Settings → Server and runner → Updates → **Deploy latest** instead: it swaps colours with no downtime. The UI is down for about 20 to 30 seconds.

`scripts/rebuild-live.sh` does all of the steps below in one go: it backs up, builds the colour the proxy points at, migrates, recreates it, sends SIGUSR2, and waits until `/api/ready` shows it leading at the new commit. It stops at the first failure and says which step. The steps by hand, for reference (the examples say blue):

1. Back up the database:
```sh
docker compose exec -T db pg_dump -U bossman bossman | gzip > /mnt/NVME_Apps/Container_files/boss-man/before-rebuild.sql.gz && ls -l /mnt/NVME_Apps/Container_files/boss-man/before-rebuild.sql.gz
```
2. Build blue at the checkout's commit, then migrate:
```sh
BOSSMAN_COMMIT=$(git rev-parse HEAD) docker compose build server-blue && BOSSMAN_MIGRATE_TAG=blue docker compose run --rm migrate
```
3. Restart blue on the new image (this is the 20 to 30 second gap):
```sh
docker compose up -d --no-deps --force-recreate server-blue
```
   **If the live colour is green**, also tell it to take charge. Green starts as a standby (`BOSSMAN_ROLE: standby`) and only contests the leader lock after SIGUSR2, which the deployer normally sends; without it no server is in charge, writes answer "standby" and the runner can't connect:
```sh
docker compose kill -s SIGUSR2 server-green
```
4. Check. Blue's start command should be `node --import tsx src/main.ts`, and `/api/ready` should show `"role":"leader"` with the new commit:
```sh
docker compose exec -T server-blue cat /proc/1/cmdline | tr '\0' ' '; echo; curl -s http://192.168.68.67:3101/api/ready; echo
```

**If something goes wrong**
- **The proxy keeps restarting** (`Restarting (255)`, and `docker logs boss-man-proxy-1` says `exec /usr/bin/caddy: operation not permitted`). The `caddy` program in the official image carries a file capability (bind to low ports). With every capability dropped and none added back, Linux refuses to run it at all. The compose file now gives back that one capability (`cap_add: [NET_BIND_SERVICE]`); a checkout from before 23 Oct 2026 lacks it. Bring the checkout up to `main`, then `docker compose up -d --no-deps proxy`.
- **"Update failed: … blue did not step down. Switched back to blue automatically."** The live colour was built from an image that starts the server through the `tsx` command. That command runs the server as a child process and passes on only SIGINT and SIGTERM, so the hand-over signal (SIGUSR1) never arrives. Images from `5d983a16` on start `node --import tsx` directly. Rebuild the live colour in place (above) once; swaps work after that. The automatic switch-back left the live colour untouched. Any migration the attempt ran was expand-only, so the old code keeps working with it.
- **Runner shows Offline after the cutover.** Its log (`docker logs -t --since 1h boss-man-runner-<company> 2>&1 | tail`) shows `getaddrinfo ENOTFOUND server` while the proxy is down. It reconnects by itself within 30 seconds of the proxy coming up.

**The private "front" network (an install that is already running blue/green).** The compose file now gives the proxy and the two colours a private network, `front`, where the proxy has a fixed address (172.30.0.18). The proxy reaches the live colour there as `server-<colour>-front`, and the colours believe the forwarded client address only from that one address. Nothing else can use that network: not the runners, not Tailscale. Defaults: `BOSSMAN_FRONT_SUBNET=172.30.0.16/28`, `BOSSMAN_FRONT_PROXY_IP=172.30.0.18`, `BOSSMAN_FRONT_RANGE=172.30.0.24/29`. The deployer refuses this change (it edits `deploy/` and `scripts/`), so apply it by hand, on staging first:

1. Check the subnet is free: `docker network ls -q | xargs docker network inspect --format '{{range .IPAM.Config}}{{.Subnet}} {{end}}'` must not list anything inside 172.30.0.16/28. If it does, set all three `BOSSMAN_FRONT_*` variables in `.env` to a free block (the range must sit inside the subnet and not contain the proxy address).
2. Back up (`.env` and the database, as in step 2 above), then `git fetch origin main && git merge --ff-only origin/main`.
3. Copy the new deployer: `cp scripts/host-deployer.sh $D/host-deployer.sh && chown root:root $D/host-deployer.sh && chmod 750 $D/host-deployer.sh`. It works with the old and the new compose files: it only writes the new form of the include when the proxy can reach `server-<colour>-front`.
4. Recreate the proxy and the live colour (a few seconds of downtime; the standby colour picks up the change at the next swap): `docker compose up -d --no-deps --force-recreate proxy server-blue` (use the live colour's name).
5. Check that the network lists the proxy (172.30.0.18) and the colours, and nothing else: `docker network inspect boss-man_front --format '{{range .Containers}}{{.Name}} {{.IPv4Address}} {{end}}'`. Then put the live colour's include in the new form, by running a swap or by hand:

~~~sh
cat > $D/proxy/active.caddy.new <<'INC'
# Written by host-deployer.sh. Do not edit. Live colour: blue
(active) {
	reverse_proxy server-blue-front:{args[0]} {
		header_up X-Forwarded-For {client_ip}
		health_uri {args[1]}
		health_interval 2s
		health_timeout 2s
	}
}
INC
chmod 644 $D/proxy/active.caddy.new && mv -fT $D/proxy/active.caddy.new $D/proxy/active.caddy
docker compose exec -T proxy caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile && docker compose exec -T proxy caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile
curl -s http://192.168.68.67:3101/api/ready; echo
~~~

6. What changes for people: the server now sees each device's real address (before, every device looked like the proxy), so the login attempt limit counts per device.

**Undo the front network.** Revert the commit (or check out the previous `deploy/truenas-bluegreen.yml` and `deploy/caddy/Caddyfile`), put back the previous deployer copy, rewrite the include in the old form (the snippet in step 3 above, with the live colour's name), then `docker compose up -d --no-deps --force-recreate proxy server-<live colour>`. An old deployer cannot read the new form of the include, so the rewrite is required.

**Go back to the previous release after the 15 minutes** (the old colour has been stopped, its image is still there until the next swap). As root on the NAS, from the deployer folder:

```sh
$D/host-deployer.sh --rollback --dry-run   # checks only
$D/host-deployer.sh --rollback             # backs up, starts the old colour, hands over, flips the proxy, checks
```

It reverses itself if the checks fail. It never touches the database. If the bad release changed the database in a non-expand-only way, see the wiki page "Database restore and blue/green rollback".

**Go back to a single server** (any time, also if step 6 misbehaves):

```sh
docker compose stop proxy server-blue server-green
docker compose rm -f proxy server-blue server-green
rm -f $D/state/soak
cp -p .env.before-bluegreen .env        # the COMPOSE_FILE and port lines as they were
docker compose up -d server
docker compose ps server
```

If you edited `.env` after the backup, copy those changes back by hand instead of the whole file. Keep `$D/proxy` or delete it; nothing reads it without the opt-in. The images `boss-man-server:blue` and `:green` can be removed with `docker image rm`.

**Checked on the real NAS (22 and 23 Oct 2026):**
- the bring-up and cutover commands (Docker Compose v2.32.3);
- `caddy validate` and `caddy reload`, and busybox `wget` inside the `caddy:2.11.7` container;
- runners reconnecting through the proxy without being recreated;
- the automatic switch-back during a failed swap;
- a full automatic swap from blue to green.

**Still UNVERIFIED:**
- the old colour being stopped by itself when the 15-minute soak ends;
- an automatic switch-back during the soak (only the one during the swap has been seen);
- whether the timeout defaults suit slower hardware.

## 10. Phone notifications (optional)

Boss Man pushes pages and asks to your phone through your own [ntfy](https://github.com/binwiederhier/ntfy) server (R44), run on the same Docker host as Boss Man from `deploy/ntfy.yml` (any host: TrueNAS, a Proxmox VM or container, or plain Linux). Boss Man only makes outbound requests to it. Nothing is opened at the router and nothing is exposed on your LAN.

How it is set up (all in `deploy/ntfy.yml`):
- **Off by default,** its own Compose project like Penpot. A normal `docker compose up -d` never starts it.
- **Tailnet and https only.** No port is opened on the host. ntfy joins the private `edge` network of the Tailscale container from section 10b, and that container's Serve config publishes it to your tailnet over https on port 8443 (Boss Man's own address stays on 443). It uses the same Tailscale certificate and the same Tailscale container, so there is only one Tailscale to look after. Funnel stays off.

**Do section 10b (HTTPS through Tailscale Serve) first.** This section builds on it and doesn't work without it.
- **Deny-all access.** Nobody can publish or read without a user. There is no sign-up and no web page.
- **Short memory.** Messages are kept for 1 hour (`NTFY_CACHE_DURATION`), then dropped.
- **No relay.** No upstream server is set, so nothing leaves your network.

Treat the topic name and the passwords as secrets: notifications will carry Approve links. Don't paste them into tickets, chat or this repository.

### Your steps

1. Make the data folder and give it to uid 1000. By default it is `ntfy` inside your Boss Man data folder (`$BOSSMAN_DATA`, as in section 10b), so the usual backup and move steps already cover it:
   ```
   sudo mkdir -p "${BOSSMAN_DATA:-/srv/boss-man/data}/ntfy" && sudo chown 1000:1000 "${BOSSMAN_DATA:-/srv/boss-man/data}/ntfy"
   ```
   It holds the users, tokens and cache. Keep it in your backup: restoring it on a new host keeps the tokens and the phone subscription working.
2. Back up `.env`, then add one line. The address is the same ts.net name as in 10b, with port 8443:
   ```
   NTFY_BASE_URL=https://<host-name>.<tailnet>.ts.net:8443
   ```
   Nothing else is needed. ntfy finds the `edge` network from section 10b by its default name (`boss-man_edge`). Only if you changed the Compose project name, or set `NTFY_DATA` or `NTFY_EDGE_NETWORK` yourself, add those lines too. `NTFY_DATA` and `NTFY_EDGE_NETWORK` are only for a different data folder or network; `NTFY_EDGE_NETWORK` is the name of that network, which `docker network ls` lists (it ends in `_edge`).
3. Start it. **This needs BOS-242 (section 10b) merged with an extra port 8443 entry in `deploy/tailscale/serve.json`, `"${TS_CERT_DOMAIN}:8443"` proxying to `http://ntfy:80`, with no Funnel.** Check that the file has it before you go on: `grep -c ':8443' deploy/tailscale/serve.json` must print `1`. If it prints `0`, stop: nothing publishes ntfy yet.
   ```
   docker compose -p boss-man-ntfy --env-file .env -f deploy/ntfy.yml --profile ntfy up -d
   docker exec <tailscale container> tailscale serve status
   ```
   Use the Tailscale container's name from `docker ps`. The status should list `https://<host-name>.<tailnet>.ts.net:8443` as **tailnet only** and must not mention Funnel. If it does, stop and tell me.
4. Pick a topic name nobody could guess, such as 20 random letters and digits. It is a password. Make two users, one that can only publish and one that can only read. `ntfy user add` asks for a password, so type a long one each time:
   ```
   docker exec -it boss-man-ntfy-ntfy-1 ntfy user add bossman-publish
   docker exec -it boss-man-ntfy-ntfy-1 ntfy user add phone-read
   docker exec boss-man-ntfy-ntfy-1 ntfy access bossman-publish <topic> write-only
   docker exec boss-man-ntfy-ntfy-1 ntfy access phone-read <topic> read-only
   docker exec boss-man-ntfy-ntfy-1 ntfy token add bossman-publish
   ```
   The last command prints the **publish token** (it starts with `tk_`). Copy it now.
5. In Boss Man, open **Settings > Secrets** and save the publish token as a new secret.
6. Open **Settings > Notifications** and fill in **ntfy server** with `http://ntfy:80`, **Topic**, and **Access token** (the secret from step 5). Set **Boss Man's address on your phone** to Boss Man's https address. Boss Man's server and ntfy share the private `edge` network from section 10b, so Boss Man sends over that network and needs no tailnet name. Only your phone and the Approve buttons use the https address. If "Send a test" fails, check that ntfy is running (`docker compose -p boss-man-ntfy ps`) and that the server is on the `edge` network.
7. In the ntfy app on your phone (the phone must be on your tailnet), choose **Use another server**, enter the https address, and log in as `phone-read` with its password. Subscribe to your topic.
8. In Boss Man, choose **Send a test to my phone**. It should arrive within seconds.

Check that it is locked down. Both commands must print `401` or `403` (the first tries to read, the second to publish, with no login):
```
curl -s -o /dev/null -w '%{http_code}\n' https://<host-name>.<tailnet>.ts.net:8443/<topic>/json?poll=1
curl -s -o /dev/null -w '%{http_code}\n' -d probe https://<host-name>.<tailnet>.ts.net:8443/<topic>
```
From a device that is not on your tailnet the address must not answer at all.

### iPhone

iPhones only get instant delivery from a self-hosted server if the server forwards a wake-up through ntfy.sh. If you use an iPhone, add `NTFY_UPSTREAM_BASE_URL=https://ntfy.sh` to `.env` and run step 3's `docker compose` command again. ntfy sends ntfy.sh only a poll request containing the message ID, never the title, text or buttons ([iOS instant notifications](https://docs.ntfy.sh/config/#ios-instant-notifications)). Android doesn't need this: leave it unset.

### Approve buttons

ntfy action buttons make your phone call Boss Man directly, over Boss Man's https address on your tailnet (the address from section 10b). The Approve button (BOS-243) only turns on when a publish token is set and Boss Man's public URL is https.

### Moving off the Home Assistant webhook

Run both for a day. During that time the webhook keeps getting plain alerts only. When the ntfy test and a real alert have both reached your phone, remove the webhook in **Settings > Notifications**.

### Any Docker host

The same steps work on plain Linux Docker, a Proxmox VM and a Proxmox container (LXC), because ntfy rides on the Tailscale container from section 10b, which runs in Tailscale's userspace mode and needs no `/dev/net/tun`. Nothing here is specific to TrueNAS. Host differences (such as how to back up or add a tun device) are in `docs/20-https-tailscale.md`. Moving to a new host: copy `$BOSSMAN_DATA` (it includes `ntfy` and `tailscale`), bring up section 10b, then run step 3 again. Users, tokens and the phone subscription carry over.

### Rolling back

`docker compose -p boss-man-ntfy --env-file .env -f deploy/ntfy.yml --profile ntfy down`. Port 8443 then answers with an error until you start it again; to remove it for good, delete the 8443 entry from `deploy/tailscale/serve.json`. Your messages are only kept for an hour and are not worth restoring. The users and tokens live in `NTFY_DATA/user.db`; copy that file first if you want to keep them.

ntfy's docs site wasn't reachable when this was written, so the links point at it but were checked against the same pages in [ntfy's repository](https://github.com/binwiederhier/ntfy/tree/main/docs).

## 10b. HTTPS through Tailscale Serve (tailnet only)

The steps are in [docs/20-https-tailscale.md](20-https-tailscale.md), which works on any Docker host. TrueNAS specifics:

- `COMPOSE_FILE` becomes `docker-compose.yml:deploy/truenas.yml:deploy/tailscale.yml`, and the state folder is `/mnt/NVME_Apps/Container_files/boss-man/data/tailscale` (so create it there). Keep it in a dataset your snapshots cover.
- Use the sidecar, not the TrueNAS Tailscale app: the app cannot show that LAN traffic is kept apart from the trusted address.
- Blue/green (9d) is not covered yet.

## 11. Feedback portal (optional)

Each company can have a public feedback portal (see `docs/07-feature-requests.md`). Turn it on under **Feedback > Feedback portal**, and tick **Show on the feedback portal** on the features people may vote on.

The server also has a port that serves only the portal. Inside the container it is 3101; on the NAS it is `BOSSMAN_PORTAL_HOST_PORT`. By default it's bound to the NAS itself (`127.0.0.1`), so nobody else can reach it. To give the portal its own port on your LAN, 3111 here, back up `.env` and set these (check the result with the `grep`):

```sh
cp -p .env .env.before-portal
setenv() { if grep -q "^$1=" .env; then sed -i "s#^$1=.*#$1=$2#" .env; else echo "$1=$2" >> .env; fi; }
setenv BOSSMAN_PORTAL_HOST_PORT 3111
setenv BOSSMAN_PORTAL_BIND <nas-ip>
setenv BOSSMAN_PORTAL_URL http://<nas-ip>:3111
grep -E '^BOSSMAN_PORTAL_' .env
```

`BOSSMAN_PORTAL_URL` is the portal's address as people reach it. The link to share under **Feedback > Feedback portal** uses it, so it points at the portal's own port rather than your owner UI.

Then recreate the server so it picks up the new port (single-server install), and check it:

```sh
docker compose up -d server
curl -s -o /dev/null -w '%{http_code}\n' http://<nas-ip>:3111/portal.html
```

The second line should print `200`. With blue/green (9d), step 4 there sets the same lines and the proxy serves the portal on 3111.

To share it more widely, expose port 3111 only, never 3101 (your login), through a reverse proxy or Tailscale Funnel. `docs/07-feature-requests.md` explains what the portal does and doesn't let people do.
