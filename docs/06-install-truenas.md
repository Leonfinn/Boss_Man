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

The commands below are a worked example. They put Boss Man in `/mnt/tank/apps/boss-man`, where `tank` is the pool and `apps` is a dataset you already keep container apps in. Use your own pool and dataset names, and change that path everywhere it appears. The examples use `192.168.1.50` as the NAS's LAN address; replace it, and `<nas-ip>`, with yours. You can find it in the TrueNAS UI under Network.

## 1. Create a dataset

Boss Man gets its own dataset under `apps`, so you can snapshot and roll it back on its own.

First check that `apps` is a dataset and not a plain folder. In a root shell on the NAS (step 2 says how to open one):

```sh
zfs list -o name,mountpoint -r tank
```

If `tank/apps` is in the list, it's a dataset. In the TrueNAS UI, go to Datasets, select `tank/apps`, and Add Dataset:
- **Name:** `boss-man`.
- **Dataset preset:** Generic. Generic datasets use a POSIX ACL, so ordinary `chown` and `chmod` behave as expected ([TrueNAS docs](https://www.truenas.com/docs/scale/25.10/scaletutorials/datasets/permissionsscale/)). Pick Generic even if `apps` itself was made with the Apps preset, which uses an NFSv4 ACL that can override them.

If `apps` isn't in the list, it's a plain folder, and TrueNAS can't create a dataset inside it. Then just make the folder; snapshots of the dataset that holds `apps` still cover it:

```sh
mkdir -p /mnt/tank/apps/boss-man
```

Everything Boss Man keeps goes in this folder.

## 2. Get the code

Open a root shell on the NAS (TrueNAS UI > System > Shell, or `ssh admin@<nas-ip>` from your computer and then `su -`). Go to the dataset:

```sh
cd /mnt/tank/apps/boss-man
```

How the NAS reads the repo (a deploy key if it is private, https if it is public) is in [docs/00, step 2](00-first-time-install.md#2-get-the-code-onto-the-host). Use `$B` as `/mnt/tank/apps/boss-man` there. For a public repo the clone is:

```sh
git clone <repo-https-url> src
```

Later `git pull`s, `scripts/deploy.sh` and the host deployer's `git ls-remote` read the same remote, so there is nothing more to set up. Moving this install to another host later: see [docs/21](21-move-to-new-host.md).

If git isn't on the host (`git --version` fails), let me know: the throwaway-container route isn't covered by this guide yet.

If the clone hangs, see the troubleshooting lines in [docs/00, step 2](00-first-time-install.md#2-get-the-code-onto-the-host).



## 3. Folders and ownership

The server and runners run as uid 1000. Postgres runs as its own user and sets the ownership of its own data folder on first start, so you only create that folder. These commands use full paths, so they work from any folder.

```sh
mkdir -p /mnt/tank/apps/boss-man/data/postgres /mnt/tank/apps/boss-man/data/app-co/workspaces /mnt/tank/apps/boss-man/data/app-co/runner-data /mnt/tank/apps/boss-man/data/app-co/claude /mnt/tank/apps/boss-man/src/secrets
```

```sh
chown -R 1000:1000 /mnt/tank/apps/boss-man/data/app-co /mnt/tank/apps/boss-man/src/secrets && chmod 700 /mnt/tank/apps/boss-man/src/secrets
```

## 4. Settings and the master key

Go to the repo folder. The `docker compose` commands from here on must run from `/mnt/tank/apps/boss-man/src`.

```sh
cd /mnt/tank/apps/boss-man/src
```

The master key encrypts every stored secret. Back it up somewhere safe outside the NAS. Without it, stored secrets can't be read.

```sh
openssl rand -base64 32 > /mnt/tank/apps/boss-man/src/secrets/master.key && chown 1000:1000 /mnt/tank/apps/boss-man/src/secrets/master.key && chmod 600 /mnt/tank/apps/boss-man/src/secrets/master.key
```

Compose won't start anything while a secret file is missing, so create the runner's token file now, empty. You fill it in at step 7.

```sh
touch /mnt/tank/apps/boss-man/src/secrets/runner-app-co.token && chown 1000:1000 /mnt/tank/apps/boss-man/src/secrets/runner-app-co.token && chmod 600 /mnt/tank/apps/boss-man/src/secrets/runner-app-co.token
```

Create `.env`. Compose reads it automatically. Its first two lines add the TrueNAS file and start the runners, so plain `docker compose` commands and the update script both use them.

```sh
cat > /mnt/tank/apps/boss-man/src/.env <<EOF
COMPOSE_FILE=docker-compose.yml:deploy/truenas.yml
COMPOSE_PROFILES=runners
BOSSMAN_DATA=/mnt/tank/apps/boss-man/data
POSTGRES_PASSWORD=$(openssl rand -hex 24)
BOSSMAN_BIND=<nas-ip>
BOSSMAN_HOST_PORT=3101
BOSSMAN_PORTAL_HOST_PORT=3102
BOSSMAN_INSECURE_COOKIES=1
EOF
```

```sh
chmod 600 /mnt/tank/apps/boss-man/src/.env
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

Memory limits for the server, database, runners and tool servers are set from this file too: see [docs/29, "Memory limits"](29-tune-and-troubleshoot.md#memory-limits). Nothing to add on TrueNAS; the defaults apply.

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

Open `http://<nas-ip>:3101` in a browser on your computer and create the owner account. The **setup wizard** opens. It has eight steps; each can be skipped and done later, and it remembers where you were. Anything left over shows as **Finish setting up** on Decisions until it's done or you dismiss it. **Run the setup wizard**, at the top of Settings, brings it back.

1. **Your company:** a name, for example "Boss Man Co", and what it's for. The CEO plans from this.
2. **A project:** a name, for example "Boss Man", and its **Git repo**:
   - GitHub: `https://github.com/<owner>/<repo>.git`
   - your Gitea: `http://192.168.1.50:3003/<owner>/<repo>.git` (plain http is allowed for private LAN addresses)
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
cat > /mnt/tank/apps/boss-man/src/secrets/runner-app-co.token
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
- **What it builds.** It builds the container itself: uid 1000, all capabilities dropped, `no-new-privileges`, not privileged, a memory limit sized from **Agents at once** and **Checks at once** (see [docs/29, "Memory limits"](29-tune-and-troubleshoot.md#memory-limits)), and only that company's folders under `data/companies/<slug>`.

These steps move an existing install, including the compose runner from step 7, over to the launcher. Run them from the repo folder.

```sh
cd /mnt/tank/apps/boss-man/src && git pull
```

The launcher keeps company data under `data/companies`, owned by uid 1000:

```sh
mkdir -p /mnt/tank/apps/boss-man/data/companies && chown 1000:1000 /mnt/tank/apps/boss-man/data/companies
```

In `.env`, replace `COMPOSE_PROFILES=runners` with the launcher profile and turn it on. The first command shows the file so you can check it before changing it.

```sh
cat /mnt/tank/apps/boss-man/src/.env
```

```sh
sed -i 's/^COMPOSE_PROFILES=runners$/COMPOSE_PROFILES=launcher/' /mnt/tank/apps/boss-man/src/.env && printf 'BOSSMAN_LAUNCHER=1\nBOSSMAN_DOCKER_GID=999\n' >> /mnt/tank/apps/boss-man/src/.env
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
  cp -a /mnt/tank/apps/boss-man/data/app-co/. /mnt/tank/apps/boss-man/data/companies/boss-man-co/
  ```

- **Updates.** `scripts/update-runner.sh` builds and checks the new image, then Boss Man drains (nothing new starts, runs finish) and the launcher recreates each company's runner as soon as that company is idle; `--rollback` does the same onto the previous image, and `--now` recreates everything at once (see the runner update section below).
- **Going back.** Choose **Stop** in Settings > Server and runner > Runner, put `COMPOSE_PROFILES=runners` back in `.env`, remove the two lines you added, and follow step 7.

## 8. Credentials and funding

Make both credentials on your own computer, then paste them into **Settings > Secrets**. Values are encrypted on the server and never shown again.

**Claude setup-token.** If Claude Code isn't on your computer yet, install it ([docs](https://code.claude.com/docs/en/setup)):

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

**Funding.** Under **Settings > Funding**, add one:
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

It stops if the working tree has uncommitted changes, if you are not on the default branch, or if there is nothing new (add `--force` to rebuild anyway). Backups go to the folder above the checkout, here `/mnt/tank/apps/boss-man/bossman-YYYY-MM-DD-HHMM.sql.gz` (the newest 14 are kept; set `BOSSMAN_BACKUP_DIR` or `BOSSMAN_BACKUP_KEEP` to change that). The result of the last run is in `deploy-status.json` next to them. Useful options:

- `--dry-run` shows the steps without running anything.
- `--runner` / `--no-runner` force or skip the runner update. Updating runners builds the image and asks Boss Man to drain first (runs in progress finish); without the launcher it restarts them at once and cuts runs off. The script asks first (`--yes` skips the question).
- `--commit <40-character hash>` deploys exactly that commit (it must be a fast-forward of what runs). The host deployer (step 9a) uses it.
- `--rollback` puts the previous commit back and rebuilds. It never touches the database. If a deploy fails the health check, the script prints the exact rollback and restore commands and changes nothing by itself.

Database changes apply by themselves when the server starts.

**The manual steps** (the same thing, by hand, if the script is ever unavailable):

```sh
docker compose exec -T db pg_dump -U bossman bossman | gzip > /mnt/tank/apps/boss-man/bossman-$(date +%F-%H%M).sql.gz
```

```sh
git pull && docker compose build server launcher && docker compose up -d
```

Leave `launcher` out of the build if you don't use it (step 7b).

`docker compose build` skips the runner image (it sits behind the `runners` profile), so runners keep their old code until you run the next command. With the host deployer set up (step 9), you can skip the shell: **Settings → Server and runner → Updates → Build and update runners** asks you once, then does the same thing. Run it after any update that changes `apps/runner`, `apps/launcher`, `packages/shared` or `pnpm-lock.yaml`, and for each new Claude Code release, roughly weekly (R9). It checks a new runner image with the canary and keeps the old one for rollback. It then asks Boss Man to **drain** (`docs/09-self-deploy.md`, phase 2): a banner appears on every page, nothing new starts in any company, runs in progress finish, and each company's runner is swapped as soon as it is idle. When every runner is on the new image the banner goes, and you get a notification. If runs are still going after 30 minutes (`BOSSMAN_DRAIN_MINUTES` in `.env` changes that) you get one decision: stop them and update now, keep waiting another 30 minutes, or cancel the update. Companies you paused stay paused.

```sh
scripts/update-runner.sh
```

The script returns as soon as it has asked; follow the swap in the banner or in the status box at the top of **Settings > Server and runner > Updates**, which also has **Cancel the runner update**. It finds the deployer folder from `BOSSMAN_DEPLOYER` in `.env` (step 9a). If you have not set that up, it says so and leaves the swap for you to start with **Update runners (finish runs first)** in Settings > Server and runner > Updates.

**Runner add-ons** (docs/12) are optional tools baked into the runner image, off by default. To give agents a browser (`agent-browser`, which drives Debian's Chromium), tick it under Settings → Server and runner → Runner → Add-ons, press **Save add-ons**, then press **Build and update runners**. The canary opens and closes a blank page in the new image before it is used. Untick it, save and update again to take the add-on out. (A `RUNNER_ADDONS=` line in `.env` still works until the first save, and when running `scripts/update-runner.sh` by hand without self-deploy.)

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
docker compose exec -T db pg_dump -U bossman bossman | gzip > /mnt/tank/apps/boss-man/bossman-$(date +%F).sql.gz
```

**Prove the backup restores.** A backup nobody has restored is a hope. This loads the newest backup into a throwaway database beside the live one (the live database is never written to), counts accounts, projects and tickets, prints how long it took and how much would be lost, and drops the throwaway:

```sh
cd /mnt/tank/apps/boss-man/src && scripts/restore-test.sh --fresh-backup
```

**Restore the live database from a backup (last resort).** Only when a deploy has damaged the data itself. If the code is the problem, use `scripts/deploy.sh --rollback` (or `host-deployer.sh --rollback`) instead: they never touch the data. A restore **replaces the live data** and loses everything written after the backup was taken. Do it at a quiet time, and ask for help if anything below does not look as described. Run every command as root from the checkout, `cd /mnt/tank/apps/boss-man/src`. The backups are in the folder above it.

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
BOSSMAN_MIGRATE_TAG=blue docker compose run --rm --no-deps migrate
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
ls -la /mnt/tank/apps/boss-man
```

```sh
cd /mnt/tank/apps/boss-man/src && docker compose down; cd /mnt/tank/apps/boss-man
```

```sh
rm -rf /mnt/tank/apps/boss-man/src /mnt/tank/apps/boss-man/data
```

## 9a. Install the host deployer (optional)

This lets you update Boss Man from its own Decisions page: when `main` moves on GitHub, Boss Man asks "Deploy abc1234?", and on your approval a root script on the NAS runs `scripts/deploy.sh`.

The steps are in [docs/30-in-app-updates.md](30-in-app-updates.md), which works on any Linux host. Its "TrueNAS SCALE" section covers the differences: set `B=/mnt/tank/apps/boss-man`, add `:deploy/truenas-deployer.yml` to the end of your existing `COMPOSE_FILE`, and make the every-minute cron job in **System > Advanced > Cron Jobs**.

With blue/green (9d), `host.conf` can also set `SOAK_SECONDS=900`. The host publishes it in `outbox/available.json` as `soakSeconds`, so Boss Man's runner-update trial uses the same length.

Later in this guide, `$D` means the deployer folder, here `/mnt/tank/apps/boss-man/deployer`.

## 9b. Upgrading to v1.2

v1.2 adds the launcher, the setup wizard, merge check presets, Gitea and pull requests, the Agents page, the model picker and ticket watchers. The server applies any database changes when it starts. Run these in a root shell (no `sudo`), from the repo folder:

```sh
cd /mnt/tank/apps/boss-man/src
```

1. **Back up the database** first:

   ```sh
   docker compose exec -T db pg_dump -U bossman bossman | gzip > /mnt/tank/apps/boss-man/bossman-$(date +%F).sql.gz
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
D=/mnt/tank/apps/boss-man/deployer
cd /mnt/tank/apps/boss-man/src
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
docker compose exec -T db pg_dump -U bossman bossman | gzip > /mnt/tank/apps/boss-man/before-bluegreen.sql.gz
ls -l .env.before-bluegreen /mnt/tank/apps/boss-man/before-bluegreen.sql.gz
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
		health_timeout 5s
		health_fails 3
		lb_try_duration 15s
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
setenv BOSSMAN_PORTAL_BIND 192.168.1.50
setenv BOSSMAN_PORTAL_URL http://192.168.1.50:3111
grep -q '^BOSSMAN_DEPLOYER=' .env || echo "BOSSMAN_DEPLOYER=$D" >> .env
sed -i 's#^COMPOSE_FILE=.*#&:deploy/truenas-bluegreen.yml#' .env
grep -E '^(COMPOSE_FILE|BOSSMAN_HOST_PORT|BOSSMAN_PORTAL_HOST_PORT|BOSSMAN_PORTAL_BIND|BOSSMAN_PORTAL_URL|BOSSMAN_DEPLOYER|BOSSMAN_BIND)=' .env
```

`COMPOSE_FILE` must now end in `:deploy/truenas-bluegreen.yml`. `BOSSMAN_BIND` (the address the UI listens on) is unchanged: it must be the NAS address you use for `http://192.168.1.50:3101` (the proxy uses the same variable the server did). Use the same address in the browser as today, so the login cookie keeps working. Check the compose file renders: `docker compose config -q && echo ok`.

**5. First bring-up, in this order.** The image for blue is built and the database migrated before anything starts. Do not run a bare `docker compose up -d` during this.

```sh
BOSSMAN_COMMIT=$(git rev-parse HEAD) docker compose build server-blue
BOSSMAN_MIGRATE_TAG=blue docker compose run --rm --no-deps migrate
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
curl -s http://192.168.1.50:3101/api/ready; echo
curl -s -o /dev/null -w '%{http_code}\n' http://192.168.1.50:3111/portal.html
grep 'Live colour' $D/proxy/active.caddy
docker compose logs server-blue | grep 'LEADER: \*\*\*'
```

The first line should show `"role":"leader"`, the second `200`, the third `blue`. In Boss Man, **Settings > Server and runner > Runner** should show each company's runner `Connected` within a minute: runners retry every 30 seconds, and reconnect through the proxy by themselves. **Settings > Server and runner > Server** shows "Blue/green: On" with blue Live and green Not running. If any of this is wrong: "If something goes wrong" below, or "Go back".

**7. Try a swap.** `$D/host-deployer.sh --dry-run` with a request (as in [docs/30, step 5](30-in-app-updates.md#5-test-the-script)) should say `would run: a blue/green swap to ...`. For a real one, approve a deploy as usual. Watch with `tail -f $D/deployer.log`; a good swap ends with a line like `deployed: Deployed 5d983a16 to 46822c2b: green is live; blue stays up as a standby for 15 minutes`. The UI stays up throughout. **Settings > Server and runner > Server** then shows green Live and blue Standby, and **Settings > Server and runner > Runner** shows "Connected since" the time of the swap. A good swap leaves the old colour running for 15 minutes (`SOAK_SECONDS=900`, changeable in `host.conf`); a later cron minute then stops it.

**Which colour is live?**

```sh
grep 'Live colour' $D/proxy/active.caddy
docker compose ps --format '{{.Service}} {{.Status}}' | grep server-
curl -s http://192.168.1.50:3101/api/health; echo     # "role":"leader"; the commit it was built from
```

**What the deployer will not do for you**
- It refuses any change to infra files: `deploy/` (including the Caddyfile), the compose files, the deploy scripts (`scripts/deploy.sh`, `rebuild-live.sh`, `update-runner.sh`, `host-deployer.sh`; build-only scripts do not count, see docs/09 step 6) and any `Dockerfile`. `scripts/deploy.sh` refuses to run on this install too. Apply such a change by hand, after merging it on its own (see 9a step 3):
  - **Everything starts the same way:** bring the checkout up to `main` with `git fetch origin main && git merge --ff-only origin/main`.
  - **A `Dockerfile` or other server-image change:** rebuild the live colour in place, as in "Rebuild the live colour in place" below.
  - **The Caddyfile:** `docker compose exec proxy caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile`. The Caddyfile now has `encode zstd gzip` on both sites, so the proxy compresses API JSON on the way out. The runner websocket (`/api/runner/connect`) and other streaming responses are never compressed: Caddy leaves an upgrade or streaming response alone. Confirming on staging: `curl -sI -H 'Accept-Encoding: gzip' http://<host>:3100/api/ready` should answer `content-encoding: gzip` once a response is big enough to be worth compressing (Caddy leaves very small ones alone).
  - **The proxy's compose settings:** `docker compose up -d --no-deps proxy`, which leaves the UI down for a few seconds.
  - **The launcher** (`apps/launcher/` or its compose settings): it runs its own image built from this checkout, so rebuild it first, or the old code keeps running: `docker compose build launcher && docker compose up -d --no-deps launcher`. The UI stays up. Runners keep their old limits until they are recreated: at the next runner update, or now with `scripts/update-runner.sh --settings`, which waits for runs to finish, recreates each runner and wakes the agents again.
  - **`scripts/host-deployer.sh`:** copy it to `$D` as in 9a step 3.
- **Compression is not the Caddyfile's job alone.** The web build now writes a brotli and a gzip copy next to every built asset, and the server serves those straight from disk, so **every** install (including the plain `docker-compose.yml` one with no proxy) sends compressed JavaScript, CSS and fonts with no CPU cost per page. What the proxy adds is compression of the **API JSON** (the polled dashboard data); a plain install sends that JSON uncompressed. If you want the JSON compressed without the proxy too, that is a separate change (it spends CPU on the server's event loop) and not part of this install.
- After a hand-applied change, the deployer may still show the alert about deployment files for a few minutes: press **Got it**.
- Runner updates are unchanged (the drain); they never touch the proxy.

**Rebuild the live colour in place.** This is for an image change the deployer refuses, or for a colour built from an older image. For ordinary app changes use Settings → Server and runner → Updates → **Deploy latest** instead: it swaps colours with no downtime. The UI is down for about 20 to 30 seconds.

**Before you run anything here that updates the checkout (`git merge`, `git checkout`, `git pull`), type `umask 022` in your root shell.** A root shell with `umask 077` writes every file git changes as mode 600. The server runs as user `node` in its container and the image copies file permissions as they are on disk, so it crashes at start with `EACCES: permission denied, open '/app/...'`, and a rollback with the same umask fails the same way (6 Nov outage, BOS-562). `scripts/rebuild-live.sh`, `scripts/deploy.sh` and the host deployer now check this before the backup and build: if any git-tracked file is unreadable by others, or its folder can't be read and searched, they stop, change nothing, list up to 10 paths and print the fix (`git ls-files -z | xargs -0 chmod go+r`, then `chmod go+rx` on the folders). Only tracked files are touched: `.env`, `secrets/` and the data folder stay private. If the new colour never answers, the STOPPED message ends with the last 20 lines of its container log.

`scripts/rebuild-live.sh` does all of the steps below in one go: it backs up, builds the colour the proxy points at, migrates, recreates it, sends SIGUSR2, and waits until `/api/ready` shows it leading at the new commit. It stops at the first failure and says which step. It first takes the host deployer's lock (`$BOSSMAN_DEPLOYER/lock`): if a deploy or switch-back is running it waits up to 120 s (`REBUILD_LOCK_WAIT_SECONDS`), then stops having changed nothing and says what holds the lock; run it again once the deployer is idle. It also refuses, changing nothing, while an update's trial window is running (`state/soak` exists): the deployer would switch a hand rebuild back, so wait until the window ends. The steps by hand, for reference (the examples say blue):

1. Back up the database:
```sh
docker compose exec -T db pg_dump -U bossman bossman | gzip > /mnt/tank/apps/boss-man/before-rebuild.sql.gz && ls -l /mnt/tank/apps/boss-man/before-rebuild.sql.gz
```
2. Build blue at the checkout's commit, then migrate:
```sh
BOSSMAN_COMMIT=$(git rev-parse HEAD) docker compose build server-blue && BOSSMAN_MIGRATE_TAG=blue docker compose run --rm --no-deps migrate
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
docker compose exec -T server-blue cat /proc/1/cmdline | tr '\0' ' '; echo; curl -s http://192.168.1.50:3101/api/ready; echo
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
		health_timeout 5s
		health_fails 3
		lb_try_duration 15s
	}
}
INC
chmod 644 $D/proxy/active.caddy.new && mv -fT $D/proxy/active.caddy.new $D/proxy/active.caddy
docker compose exec -T proxy caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile && docker compose exec -T proxy caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile
curl -s http://192.168.1.50:3101/api/ready; echo
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

Boss Man pushes pages and asks to your phone through your own ntfy server, run on the same host. The steps are in [docs/31-phone-notifications.md](31-phone-notifications.md), which works on any Linux host. On TrueNAS, do section 10b first, and make the ntfy data folder under your dataset, for example `/mnt/tank/apps/boss-man/data/ntfy`.


## 10b. HTTPS through Tailscale Serve (tailnet only)

The steps are in [docs/20-https-tailscale.md](20-https-tailscale.md), which works on any Docker host. TrueNAS specifics:

- `COMPOSE_FILE` becomes `docker-compose.yml:deploy/truenas.yml:deploy/tailscale.yml`, and the state folder is `/mnt/tank/apps/boss-man/data/tailscale` (so create it there). Keep it in a dataset your snapshots cover.
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

**Behind a reverse proxy (optional).** If the portal is reached through a reverse proxy (Nginx Proxy Manager, Cloudflare, Caddy, Traefik), the portal only sees the proxy's address, so every visitor would share one limit (120 reads a minute, 40 writes an hour). `BOSSMAN_PORTAL_TRUSTED_PROXY` fixes that: a comma-separated list of the proxy's **own** addresses or CIDRs, for example `BOSSMAN_PORTAL_TRUSTED_PROXY=203.0.113.10, 10.0.0.0/8`. Only a connection from a listed address may say who the visitor is, by the right-most address in `X-Forwarded-For` that is not itself listed (most proxies add it). From any other address the headers are ignored. `BOSSMAN_PORTAL_CLIENT_HEADER` chooses the header: empty or `x-forwarded-for` (default), or `cf-connecting-ip`, which you set only when Cloudflare is the proxy that connects to the portal (Cloudflare sets it and removes any copy a visitor sent). Only the chosen header is read, because Nginx Proxy Manager, Caddy and Traefik pass a visitor-sent `CF-Connecting-IP` through unchanged and a visitor could then pick their own address and dodge the limits. A malformed header or list entry is ignored too (a `/0` entry is refused), and an empty setting (the default) means the connecting address is the visitor, as before. List only the proxy, never a range that includes the internet, and keep the portal port reachable only through the proxy. Worked example for a proxy container on the NAS's Docker network 172.16.0.0/12 in front of `192.168.1.50:3111`: `setenv BOSSMAN_PORTAL_TRUSTED_PROXY 172.16.0.0/12`, then recreate the server as below.

Then recreate the server so it picks up the new port (single-server install), and check it:

```sh
docker compose up -d server
curl -s -o /dev/null -w '%{http_code}\n' http://<nas-ip>:3111/portal.html
```

The second line should print `200`. With blue/green (9d), step 4 there sets the same lines and the proxy serves the portal on 3111.

To share it more widely, expose port 3111 only, never 3101 (your login), through a reverse proxy or Tailscale Funnel. `docs/07-feature-requests.md` explains what the portal does and doesn't let people do.
