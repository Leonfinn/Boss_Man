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
- A GitHub account that can create a fine-grained token for the repos the agents will work on, and admin access to `Leonfinn/Boss_Man` to add a deploy key (the repo is private).

The commands below put Boss Man in `/mnt/NVME_Apps/Container_files/boss-man`, next to your other container apps on the mirrored NVMe pool. If you keep it somewhere else, change that path everywhere it appears. Replace `<nas-ip>` with the NAS's LAN address. Your router is at 192.168.68.1, so the NAS is most likely on 192.168.68.x. Check it in the TrueNAS UI under Network.

## 1. Create a dataset

Boss Man gets its own dataset under `Container_files`, so you can snapshot and roll it back on its own.

First check that `Container_files` is a dataset and not a plain folder. Over SSH (step 2 shows how to connect):

```sh
sudo zfs list -o name,mountpoint -r NVME_Apps
```

If `NVME_Apps/Container_files` is in the list, it's a dataset. In the TrueNAS UI, go to Datasets, select `NVME_Apps/Container_files`, and Add Dataset:
- **Name:** `boss-man`.
- **Dataset preset:** Generic. Generic datasets use a POSIX ACL, so ordinary `chown` and `chmod` behave as expected ([TrueNAS docs](https://www.truenas.com/docs/scale/25.10/scaletutorials/datasets/permissionsscale/)). Pick Generic even if `Container_files` itself was made with the Apps preset, which uses an NFSv4 ACL that can override them.

If `Container_files` isn't in the list, it's a plain folder, and TrueNAS can't create a dataset inside it. Then just make the folder; snapshots of the dataset that holds `Container_files` still cover it:

```sh
sudo mkdir -p /mnt/NVME_Apps/Container_files/boss-man
```

Everything Boss Man keeps goes in this folder.

## 2. Get the code

SSH into the NAS from iTerm2 on your Mac:

```sh
ssh admin@<nas-ip>
```

Go to the dataset:

```sh
cd /mnt/NVME_Apps/Container_files/boss-man
```

The repo is private, and GitHub doesn't accept account passwords for git. The NAS reads it with a **deploy key**: an SSH key for this one repo, read-only unless you tick "Allow write access" ([GitHub blog](https://github.blog/engineering/read-only-deploy-keys)). The key and GitHub's host key are kept in the dataset, so snapshots cover them.

Make the key. It has no passphrase, so updates can run unattended:

```sh
sudo ssh-keygen -t ed25519 -N "" -C "truenas-boss-man" -f /mnt/NVME_Apps/Container_files/boss-man/deploy_key
```

Show the public half. It's safe to copy; never copy the file without `.pub`.

```sh
sudo cat /mnt/NVME_Apps/Container_files/boss-man/deploy_key.pub
```

On your Mac, open `https://github.com/Leonfinn/Boss_Man/settings/keys`, choose **Add deploy key**, call it `TrueNAS`, paste the line, and leave **Allow write access** unticked.

Clone with that key:

```sh
sudo env GIT_SSH_COMMAND='ssh -i /mnt/NVME_Apps/Container_files/boss-man/deploy_key -o IdentitiesOnly=yes -o UserKnownHostsFile=/mnt/NVME_Apps/Container_files/boss-man/known_hosts' git clone git@github.com:Leonfinn/Boss_Man.git src
```

The first time, ssh asks whether to trust github.com. Type `yes` only if the ED25519 fingerprint matches the one on [GitHub's SSH key fingerprints](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/githubs-ssh-key-fingerprints) page, `SHA256:+DiY3wvvV6TuJJhbpZisF/zLDA0zPMSvHdkr4UvCOqU` when this was written.

Make later `git pull`s use the same key:

```sh
sudo git -C /mnt/NVME_Apps/Container_files/boss-man/src config core.sshCommand 'ssh -i /mnt/NVME_Apps/Container_files/boss-man/deploy_key -o IdentitiesOnly=yes -o UserKnownHostsFile=/mnt/NVME_Apps/Container_files/boss-man/known_hosts'
```

If git isn't on the host (`git --version` fails), let me know: the throwaway-container route needs the key mounted in, which this guide doesn't cover yet.

If the clone hangs, outbound port 22 is probably blocked, for example on your router.

## 3. Folders and ownership

The server and runners run as uid 1000. Postgres (the Alpine image) runs as uid 70 and sets the ownership of its own data folder on first start, so you only create that folder. These commands use full paths, so they work from any folder.

```sh
sudo mkdir -p /mnt/NVME_Apps/Container_files/boss-man/data/postgres /mnt/NVME_Apps/Container_files/boss-man/data/app-co/workspaces /mnt/NVME_Apps/Container_files/boss-man/data/app-co/runner-data /mnt/NVME_Apps/Container_files/boss-man/data/app-co/claude /mnt/NVME_Apps/Container_files/boss-man/src/secrets
```

```sh
sudo chown -R 1000:1000 /mnt/NVME_Apps/Container_files/boss-man/data/app-co /mnt/NVME_Apps/Container_files/boss-man/src/secrets && sudo chmod 700 /mnt/NVME_Apps/Container_files/boss-man/src/secrets
```

## 4. Settings and the master key

Go to the repo folder. The `docker compose` commands from here on must run from `/mnt/NVME_Apps/Container_files/boss-man/src`.

```sh
cd /mnt/NVME_Apps/Container_files/boss-man/src
```

The master key encrypts every stored secret. Back it up somewhere safe outside the NAS. Without it, stored secrets can't be read.

```sh
sudo sh -c 'openssl rand -base64 32 > /mnt/NVME_Apps/Container_files/boss-man/src/secrets/master.key' && sudo chown 1000:1000 /mnt/NVME_Apps/Container_files/boss-man/src/secrets/master.key && sudo chmod 600 /mnt/NVME_Apps/Container_files/boss-man/src/secrets/master.key
```

Compose won't start anything while a secret file is missing, so create the runner's token file now, empty. You fill it in at step 7.

```sh
sudo touch /mnt/NVME_Apps/Container_files/boss-man/src/secrets/runner-app-co.token && sudo chown 1000:1000 /mnt/NVME_Apps/Container_files/boss-man/src/secrets/runner-app-co.token && sudo chmod 600 /mnt/NVME_Apps/Container_files/boss-man/src/secrets/runner-app-co.token
```

Create `.env`. Compose reads it automatically. Its first two lines add the TrueNAS file and start the runners, so plain `docker compose` commands and the update script both use them.

```sh
sudo tee /mnt/NVME_Apps/Container_files/boss-man/src/.env > /dev/null <<EOF
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
sudo chmod 600 /mnt/NVME_Apps/Container_files/boss-man/src/.env
```

- `BOSSMAN_BIND` publishes the web UI on the NAS's LAN address only. The TrueNAS UI keeps 80 and 443.
- `BOSSMAN_HOST_PORT` is the NAS port for the web UI. Paperclip already uses 3100 on your NAS, so this guide uses 3101. `BOSSMAN_PORTAL_HOST_PORT` (3102) is the feedback portal's port (step 11). Inside the containers they stay 3100 and 3101, so nothing else changes. Don't forward either port on the router.
- Check both ports are free before you start. This prints nothing if they are:

  ```sh
  sudo ss -tlnp | grep -E ':(3101|3102)\b'
  ```

  If either is taken, pick other free ports and use them in `.env` and in the addresses below.
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

## 6. First login and the setup wizard

Open `http://<nas-ip>:3101` on your Mac and create the owner account. The **setup wizard** opens. It has seven steps; each can be skipped and done later, and it remembers where you were. Anything left over shows as **Finish setting up** on Decisions until it's done or you dismiss it. **Settings > Run the setup wizard** brings it back.

1. **Your company:** a name, for example "Boss Man Co", and what it's for. The CEO plans from this.
2. **A project:** a name, for example "Boss Man", and its **Git repo**:
   - GitHub: `https://github.com/Leonfinn/Boss_Man.git`
   - your Gitea: `http://192.168.68.67:3003/<owner>/<repo>.git` (plain http is allowed for private LAN addresses)

   **Before merging, Boss Man will** proposes a check from the repo once a runner is connected. For Boss Man itself that's **Run the tests (detected)**: `pnpm install --frozen-lockfile && pnpm typecheck && pnpm test`. Until then it offers the standard list; choose **Re-detect** after step 7 or 7b.
3. **The runner:** set it up with step 7b (the launcher, recommended) or step 7, then come back. It shows **Connected** when it's up.
4. **Claude:** a setup-token or API key (step 8).
5. **A git token** (step 8). **Check the token against <project>** reads the repo once and says whether the token can push. It changes nothing.
6. **What pays for the CEO:** add a funding source and pick it for the CEO (step 8).
7. **A first ticket:** optional.

If you'd rather use the screens directly, **"I know what I'm doing, let me get on with it"** on the first step closes the wizard. Everything it does is also in **Settings** and **Agents**.

## 7. The runner token

In **Settings > Runner**, choose **Register a runner**. The token is shown once. Write it into the token file without it landing in your shell history: run the command, paste the token, press Return, then Ctrl-D.

```sh
sudo sh -c 'cat > /mnt/NVME_Apps/Container_files/boss-man/src/secrets/runner-app-co.token'
```

The token file must hold only the token. A trailing newline is fine, because the runner trims it.

```sh
sudo docker compose up -d
```

Settings > Runner should show **Connected** within a minute.

The example service is called `runner-app-co`. For a second company:
1. Copy its block in `docker-compose.yml` and its volumes in `deploy/truenas.yml` under a new name.
2. Give the copy its own token file and its own `data/<company>/` folders.

## 7b. Let the launcher run the runners (recommended)

With the launcher (R55), each company's runner starts by itself when you create the company, and **Settings > Runner** gets **Start**, **Reconnect**, **Restart** and **Stop** buttons. There are no token files to copy and no compose blocks to duplicate per company.
- **How it stays safe.** The launcher is the only container that can reach Docker. It joins the socket's group (`docker`, group 999 on your NAS, from `stat -c '%U:%G %g %a %n' /var/run/docker.sock`) instead of running as root.
- **What it accepts.** It publishes no ports, and only the server can reach it, over an internal network with a key. It accepts only "start, stop or restart company X's runner".
- **What it builds.** It builds the container itself: uid 1000, all capabilities dropped, `no-new-privileges`, not privileged, the 4 GB memory limit, and only that company's folders under `data/companies/<slug>`.

These steps move an existing install, including the compose runner from step 7, over to the launcher. Run them from the repo folder.

```sh
cd /mnt/NVME_Apps/Container_files/boss-man/src && sudo git pull
```

The launcher keeps company data under `data/companies`, owned by uid 1000:

```sh
sudo mkdir -p /mnt/NVME_Apps/Container_files/boss-man/data/companies && sudo chown 1000:1000 /mnt/NVME_Apps/Container_files/boss-man/data/companies
```

In `.env`, replace `COMPOSE_PROFILES=runners` with the launcher profile and turn it on. The first command shows the file so you can check it before changing it.

```sh
sudo cat /mnt/NVME_Apps/Container_files/boss-man/src/.env
```

```sh
sudo sed -i 's/^COMPOSE_PROFILES=runners$/COMPOSE_PROFILES=launcher/' /mnt/NVME_Apps/Container_files/boss-man/src/.env && printf 'BOSSMAN_LAUNCHER=1\nBOSSMAN_DOCKER_GID=999\n' | sudo tee -a /mnt/NVME_Apps/Container_files/boss-man/src/.env > /dev/null
```

Stop and remove the old compose runner. Its folders in `data/app-co` stay where they are.

```sh
sudo docker compose --profile runners rm -sf runner-app-co
```

Build the launcher and the server, then start everything:

```sh
sudo docker compose build server launcher && sudo docker compose up -d
```

Open **Settings > Runner** and choose **Start runner**. It shows **Starting…**, then **Connected** within a minute. A new company's runner starts by itself.

- **The old runner's work.** The new runner starts with empty folders under `data/companies/<slug>`, where `<slug>` comes from the company's name (e.g. `boss-man-co`) and is shown in Settings > Runner. To bring over unfinished work and Claude sessions, choose **Stop**, then copy the old folders, then choose **Start runner** again:

  ```sh
  sudo cp -a /mnt/NVME_Apps/Container_files/boss-man/data/app-co/. /mnt/NVME_Apps/Container_files/boss-man/data/companies/boss-man-co/
  ```

- **Updates.** `sudo scripts/update-runner.sh` now asks the launcher to recreate its runners on the new image, and `--rollback` does the same on the previous one.
- **Going back.** Choose **Stop** in Settings > Runner, put `COMPOSE_PROFILES=runners` back in `.env`, remove the two lines you added, and follow step 7.

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

**Git token, for GitHub.** Create a [fine-grained personal access token](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens#creating-a-fine-grained-personal-access-token):
- **Repository access:** only the repos the company works on.
- **Permissions:** Contents and Pull requests, both read and write.

**Git token, for Gitea.** In Gitea 28, open your avatar menu > **Settings > Applications**, then under **Manage Access Tokens > Generate New Token**:
- **Token Name:** for example "boss-man".
- **Repository and Organization Access:** **All (public, private, and limited)**.
- **repository:** **Read and Write** (the `write:repository` scope, which the pull-request routes need). Leave the rest at **No Access**.

Choose **Generate Token** and copy it; Gitea shows it only once. The token can do what your Gitea user can, so a user with write access to the repo is enough. (Labels from Gitea 28.0.0's [`access_tokens.tmpl`](https://github.com/go-gitea/gitea/blob/v28.0.0/templates/shared/user/access_tokens.tmpl); see also Gitea's [scopes documentation](https://docs.gitea.com/development/oauth2-provider#scopes).)

In Settings, choose **Git token (GitHub or Gitea)** and paste it. Agents get it as `GIT_TOKEN`, and it's used for clone, fetch, push and pull requests. It's never written into a URL or onto disk. The wizard's git step, or the same check under Settings > Projects, tells you whether it can push.

**When work is approved** (Settings > Projects) is either **Merge into the default branch** (R46) or **Open a pull request** (R59). If the default branch is protected so that only pull requests can change it, choose the pull request option; a direct push would be refused and the ticket would go back to the agent with the error.

**Funding.** Under **Settings > Funding sources**, add one:
- "Subscription (setup-token)" for a Claude subscription;
- "API credit" with your monthly grant for an API key.

Then, on the **Agents** page, set each agent's **Paid from** to that source, so cost and quota are tracked. The same page sets each agent's **Model** from what the runner and your API keys offer.

## 9. Updates and checks

**See what's running:**

```sh
sudo docker compose ps
```

**Server logs:**

```sh
sudo docker compose logs --tail 100 server
```

**Update to the latest code** (it uses the deploy key from step 2). Database changes apply by themselves when the server starts.

```sh
sudo git pull && sudo docker compose build server && sudo docker compose up -d db server
```

With the launcher (step 7b), rebuild it too and start everything:

```sh
sudo git pull && sudo docker compose build server launcher && sudo docker compose up -d
```

`docker compose build` skips the runner image (it sits behind the `runners` profile), so runners keep their old code until you run the next command. Run it after any update that changes `apps/runner` or `packages/shared`, and for each new Claude Code release, roughly weekly (R9). It checks a new runner image with the canary, keeps the old one for rollback, and recreates the runners on it.

```sh
sudo scripts/update-runner.sh
```

**Undo a runner update:**

```sh
sudo scripts/update-runner.sh --rollback
```

**After a TrueNAS update,** check `sudo docker compose ps`. Images and containers live on the apps pool and survive OS updates. TrueNAS doesn't document how its own app actions treat containers started from the shell. Running Boss Man as its own `boss-man` project is what keeps it out of their way.

**Backups.** Snapshot the `boss-man` dataset (or the one that holds it) and keep a copy of `src/secrets/master.key` off the NAS. A Postgres data folder copied while the database is running may not restore cleanly. For a consistent backup, also dump it:

```sh
sudo docker compose exec -T db pg_dump -U bossman bossman | gzip | sudo tee /mnt/NVME_Apps/Container_files/boss-man/bossman-$(date +%F).sql.gz > /dev/null
```

**Starting again.** To throw away an install and redo it from step 2, stop it and delete the repo and data folders. This deletes the database and every workspace. It keeps the deploy key and `known_hosts`, so GitHub needs nothing new. Check what's there first:

```sh
ls -la /mnt/NVME_Apps/Container_files/boss-man
```

```sh
cd /mnt/NVME_Apps/Container_files/boss-man/src && sudo docker compose down; cd /mnt/NVME_Apps/Container_files/boss-man
```

```sh
sudo rm -rf /mnt/NVME_Apps/Container_files/boss-man/src /mnt/NVME_Apps/Container_files/boss-man/data
```

## 9b. Upgrading to v1.2

v1.2 adds the launcher, the setup wizard, merge check presets, Gitea and pull requests, the Agents page, the model picker and ticket watchers. The server applies any database changes when it starts. Run these from the repo folder:

```sh
cd /mnt/NVME_Apps/Container_files/boss-man/src
```

1. **Back up the database** first:

   ```sh
   sudo docker compose exec -T db pg_dump -U bossman bossman | gzip | sudo tee /mnt/NVME_Apps/Container_files/boss-man/bossman-$(date +%F).sql.gz > /dev/null
   ```

2. **Update the code and the server:**

   ```sh
   sudo git pull && sudo docker compose build server && sudo docker compose up -d db server
   ```

3. **Rebuild the runner.** The v1.2 server asks runners for things v1.1 runners don't know (detecting checks, pushing branches for pull requests, listing models), so the runner image has to match:

   ```sh
   sudo scripts/update-runner.sh
   ```

4. **Move to the launcher** (recommended): step 7b. If you stay on the compose runner, step 3 is enough.

5. **Check in the UI:**
   - **Settings > Projects:** your existing check command shows as the preset it matches (Boss Man's own matches **Run the tests (detected)** once the runner is connected), otherwise as **Custom command…**. Either is fine.
   - **Agents:** model and funding for each agent now live here.
   - The setup wizard doesn't open by itself on an install that already has a company. Open it from **Settings > Run the setup wizard** if you want its checklist.

Keep the dump from step 1 until you're happy with v1.2. Going back means restoring it and checking out the older code, which hasn't been tried here, so ask before doing it.

## 9c. Upgrading to semantic wiki search

The `db` image changed from `postgres:17-alpine` to `pgvector/pgvector:0.8.7-pg17-bookworm`, Postgres 17 with the pgvector extension. The two images use different base systems, so start with a **fresh database volume**: there is no dump and restore path (this alpha has one user). Stop the stack, delete the database folder (`$BOSSMAN_DATA/postgres` on TrueNAS, or the `db-data` volume with plain compose), then `docker compose up -d`. Semantic search itself is off until you turn it on in **Wiki > Semantic search**.

## 10. Phone notifications (optional)

Boss Man can push pages and asks to your phone through your own [ntfy](https://github.com/binwiederhier/ntfy) server (R44). Boss Man only makes outbound requests to it, so nothing new is exposed at the router.

What you need, from ntfy's own docs:
- **A ntfy server** your phone can reach, for example on your tailnet ([install](https://docs.ntfy.sh/install/)). Lock it down with `auth-default-access: "deny-all"` ([access control](https://docs.ntfy.sh/config/#access-control)).
- **A user and an access token** for Boss Man, made on the ntfy server with `ntfy user add` and `ntfy token add` ([access tokens](https://docs.ntfy.sh/config/#access-tokens)). Give that user write access to one topic, for example `bossman`, with `ntfy access`.
- **The ntfy app** on your phone, subscribed to that topic on your server. On iPhone, instant delivery from a self-hosted server also needs `upstream-base-url: "https://ntfy.sh"` in the server's config, which forwards a wake-up (not the message) through ntfy.sh ([iOS instant notifications](https://docs.ntfy.sh/config/#ios-instant-notifications)).

Then, in Boss Man, open **Notifications** and fill in **How you're told**:
- **ntfy server**, **Topic** and **Access token**. The token is stored encrypted, like other credentials, and never shown again.
- **Boss Man's address on your phone**, so tapping a notification opens its evidence. This needs to be an address your phone can reach, such as a Tailscale Serve HTTPS name.
- **Quiet hours**, if you want them, and how many notifications each agent may send per hour.

Choose **Send a test to my phone** to check it. If it fails, the message says what ntfy answered.

ntfy's docs site wasn't reachable when this was written, so these links point at it but were checked against the same pages in [ntfy's repository](https://github.com/binwiederhier/ntfy/tree/main/docs). Setting up ntfy itself on TrueNAS isn't covered here.

## 11. Feedback portal (optional)

Each company can have a public feedback portal (see `docs/07-feature-requests.md`). Turn it on under **Feedback > Feedback portal**, and tick **Show on the feedback portal** on the features people may vote on.

The server also has a port that serves only the portal: 3102 on the NAS (`BOSSMAN_PORTAL_HOST_PORT`). By default it's bound to the NAS itself. To let people on your LAN or tailnet reach it, add this line to `.env`:

```sh
BOSSMAN_PORTAL_BIND=<nas-ip>
BOSSMAN_PORTAL_URL=http://<nas-ip>:3102
```

`BOSSMAN_PORTAL_URL` is the portal's address as people reach it. The link to share under **Feedback > Feedback portal** uses it, so it points at the portal's own port rather than your owner UI. Change the port in both lines if you set `BOSSMAN_PORTAL_HOST_PORT` to something else.

Then restart the server:

```sh
sudo docker compose up -d server
```

The portal link is `http://<nas-ip>:3102/portal.html#` followed by the secret from the link on the Feedback page; the link the Feedback page shows uses the owner's port, 3101, so swap the port before you share it. To share it more widely, expose port 3102 only, never 3101 (your login), through a reverse proxy or Tailscale Funnel; `docs/07-feature-requests.md` explains what the portal does and doesn't let people do.
