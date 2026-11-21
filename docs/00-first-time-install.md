# 00 — First-time install

This is the short path from nothing to a working Boss Man on a Linux host with Docker. It has the install steps only. Tuning (memory limits and more) and troubleshooting are in [docs/29-tune-and-troubleshoot.md](29-tune-and-troubleshoot.md). On TrueNAS SCALE, follow this guide too, with the differences in the next section and the extras in [docs/06-install-truenas.md](06-install-truenas.md).

> **Verification:** every file name, setting and button label in this guide was checked against the code. The full install was **not** re-run on a fresh machine for this edit, so treat the exact command output as unverified.

## What you'll end up with

- Boss Man running on a machine you own, with its web page open on your home network.
- One company, with a CEO agent already in it, and one more agent you hire.
- One project (a git repo) and a first ticket that an agent runs.

## What you need first

- **A 64-bit Linux host** with **Docker Engine** and **Docker Compose v2** (the `docker compose` command). Check with `docker compose version`. The compose files use secrets, profiles and the top-level `name:` setting. The repo doesn't state an exact minimum Compose version, except that the optional blue/green setup needs 2.24 or newer. There is no measured minimum for RAM or disk yet (BOS-212); the website's install guide gives estimates under "What machine do I need". With the launcher, each runner gets 2 GB, plus 1 GB per agent at once, plus 3 GB per check: 11 GB with the defaults (6 agents, 1 check). It is kept within the host's memory less 2 GB. See [docs/29, "Memory limits"](29-tune-and-troubleshoot.md#memory-limits).
- **Mac and Windows: not supported yet, but we're testing Docker Desktop.** On a Mac with Apple silicon, the agent fence already works under Docker Desktop. The network guard isn't proven there yet ([docs/27](27-netguard.md)), and Windows hasn't been tested. For now, use a Linux machine. The remaining work is BOS-1033.
- **On Proxmox, a VM, not an LXC container.** Install Docker in the VM and follow these steps inside it. Why: [docs/32-proxmox.md](32-proxmox.md).
- **These tools on the host:** `git`, `openssl`, `curl`, and a normal Linux shell with `stat`.
- **A git host account and token.** GitHub (a fine-grained token) or Gitea. You make the token in step 9.
- **An AI provider for at least one agent program.** The runner supports three:
  - **Claude Code**: a Claude Pro or Max subscription, or an Anthropic API key.
  - **Codex**: an OpenAI API key, or a ChatGPT plan.
  - **OpenCode**: an OpenRouter, Ollama Cloud or Synthetic key (or an OpenAI or Anthropic key).

  The CEO is a Claude Code agent unless you change it, so the easiest start is a Claude subscription.
- **A second computer** (or the host itself) with a web browser. It is also where you make the Claude token in step 9.
- **Read access from the host to the Boss Man code repo** (step 2): internet access to its https address if the repo is public, or a read-only deploy key if it is private.

## A note on commands

- The commands are written for a **root shell**. On a normal Linux host, either run them as root, or put `sudo` in front of each command (a redirect such as `> file` then needs `sudo sh -c '...'`), or add your user to the `docker` group. On TrueNAS there is no `sudo`: use the root shell.
- Each command is in its own box. Copy it whole.
- Where you see something in `<angle brackets>`, replace it, brackets and all. `<host-ip>` is your host's address on your home network.

## If you're on TrueNAS SCALE

Do these differences, then follow the steps as written:
- **Choose an apps pool first** (Apps > Configuration > Choose Pool). Docker only runs once a pool is chosen.
- **Use a root shell:** System > Shell in the TrueNAS web page, or `su -` over SSH.
- **Put the folder on a dataset** (make one for Boss Man), so you can snapshot it. [docs/06, step 1](06-install-truenas.md#1-create-a-dataset) shows how.
- **Use the `deploy/truenas.yml` overlay**, which keeps the database in your own folder instead of a Docker volume. Steps 3 and 4 say where. Skip it on other hosts.

## 1. Choose where Boss Man lives

Pick a folder for everything Boss Man keeps. `/opt/boss-man` is an example. This guide calls it `<install-dir>`.

Set a shell variable for it. Replace the path if you chose another.

```sh
B=/opt/boss-man
```

Keep this layout: the code goes in `<install-dir>/src`, backups in `<install-dir>`, and the optional host deployer in `<install-dir>/deployer`. The update scripts work these folders out from where they sit, so you don't set any paths for them. If you open a new shell, set `B` again before using it in a command.

Make the folder:

```sh
mkdir -p $B
```

Check it worked:

```sh
ls -ld $B
```

You should see the folder listed.

## 2. Get the code onto the host

How the host reads the code depends on the repo. Use the case that matches yours. Replace `<repo-https-url>` and `<repo-ssh-url>` with your repo's own addresses (the clone address your git host shows).

**Public repo: https, no key.** Clone it into `<install-dir>/src`:

```sh
git clone <repo-https-url> $B/src
```

**Private repo: a read-only deploy key, one per host.** A deploy key is an SSH key that gives read access to one repo. Do not reuse another host's key.

1. Make a key with no passphrase, so updates can run unattended:

   ```sh
   ssh-keygen -t ed25519 -N "" -C "boss-man-$(hostname)" -f $B/deploy_key
   ```

2. Show the public half. It is safe to copy. Never copy the file without `.pub`.

   ```sh
   cat $B/deploy_key.pub
   ```

3. In your git host, add it as a deploy key on the repo, with write access **off**. On GitHub: the repo's Settings > Deploy keys > Add deploy key.
4. Clone with the key. `-c core.sshCommand=...` also saves the setting in the checkout, so later `git pull` and `git ls-remote` use the same key:

   ```sh
   git clone -c core.sshCommand="ssh -i $B/deploy_key -o IdentitiesOnly=yes -o UserKnownHostsFile=$B/known_hosts" <repo-ssh-url> $B/src
   ```

   The first time, ssh asks whether to trust the git host. Type `yes` only if the fingerprint matches the one your git host publishes (for GitHub, its "SSH key fingerprints" page).

Check it worked:

```sh
git -C $B/src log --oneline -1
```

You should see one commit line.

If the clone hangs, check that the host can reach the git host: port 443 for https (`curl -sI <repo-https-url> | head -1` should print an HTTP status line), port 22 for ssh. If ssh says `Permission denied (publickey)`, the key is not added to the repo yet, or the `-i` path is wrong.

The same remote is used by later pulls, `scripts/deploy.sh` and the host deployer's `git ls-remote`, so there is nothing more to set up. Moving to another host? Make a new key there; a deploy key is never shared between hosts.

## 3. Make the folders, the master key and the token file

The server and runners run as user ID 1000, so the folders they write to must belong to 1000.

```sh
mkdir -p $B/data/companies $B/src/secrets
```

```sh
chown 1000:1000 $B/data/companies $B/src/secrets && chmod 700 $B/src/secrets
```

The **master key** encrypts every secret Boss Man stores. Make it:

```sh
openssl rand -base64 32 > $B/src/secrets/master.key && chown 1000:1000 $B/src/secrets/master.key && chmod 600 $B/src/secrets/master.key
```

Copy that file somewhere safe outside the host now. Without it, stored secrets cannot be read again.

Docker Compose refuses to start while a secret file named in the compose file is missing. Make the runner token file empty. The launcher (step 4) doesn't use it:

```sh
touch $B/src/secrets/runner-app-co.token && chown 1000:1000 $B/src/secrets/runner-app-co.token && chmod 600 $B/src/secrets/runner-app-co.token
```

Check it worked:

```sh
ls -l $B/src/secrets
```

You should see `master.key` and `runner-app-co.token`.

**On TrueNAS only:** also make the database folder the overlay uses:

```sh
mkdir -p $B/data/postgres
```

## 4. Write the settings file

Boss Man reads a file called `.env` in the repo folder. This one:
- turns on the **launcher**, which starts each company's runner for you. It is the only container that can reach Docker, and it accepts only "start, stop or restart company X's runner";
- opens the web page on your host's LAN address only.

Before you run the command, replace `<host-ip>` (the `BOSSMAN_BIND` line) with your host's address on your home network, for example `192.168.1.20`. The command reads the Docker socket's group number for you.

```sh
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
```

```sh
chmod 600 $B/src/.env
```

**On TrueNAS only:** add the overlay line, so the database lives in `$B/data/postgres`:

```sh
echo "COMPOSE_FILE=docker-compose.yml:deploy/truenas.yml" >> $B/src/.env
```

What the settings mean:
- `BOSSMAN_DATA` is where the launcher keeps each company's files (under `companies/`). The compose file's own default is `/srv/boss-man/data`.
- `BOSSMAN_BIND` publishes the web page on that address only. The default is `127.0.0.1`, which only the host itself can reach.
- `BOSSMAN_HOST_PORT` is the port you type in the browser. The compose file's default is 3100. If something else uses it, pick another free port (see [docs/29](29-tune-and-troubleshoot.md#the-port-is-already-in-use)).
- `BOSSMAN_INSECURE_COOKIES=1` lets you log in over plain `http://` on your home network. Without it, login needs HTTPS.
- `BOSSMAN_DEPLOYER` is the optional host deployer's folder ([docs/30](30-in-app-updates.md)). The runner update script and the deployer's compose files read it from here.

Check the file:

```sh
cat $B/src/.env
```

`BOSSMAN_DOCKER_GID` should be a number (the compose file's default is 999), and `BOSSMAN_BIND` should be your address.

## 5. Build the images and start Boss Man

Go to the repo folder. Every `docker compose` command must run from here.

```sh
cd $B/src
```

Build the server (it includes the web page) and the launcher:

```sh
docker compose build server launcher
```

Build the runner image and the network guard that runs beside each runner. The script builds them, runs a safety check (the "canary") with networking off and no credentials, and only then marks the runner image ready. It then starts everything.

```sh
scripts/update-runner.sh
```

Expect a line saying no launcher is running, so it restarts runners at once. That is harmless on a first install: it is how the script brings the stack up. If the canary fails, it says so and leaves the runner image unset; on a first install it still starts the database, server and launcher so you can open the web page, then exits with an error. Fix the cause it names and run `scripts/update-runner.sh` again. Your Docker dashboard may later show "update check failed" on the runner and guard containers. That is expected: the images are built here, not pulled.

Check it worked:

```sh
docker compose ps
```

You should see `db` and `server` as running (the server `healthy` after a short wait) and `launcher` running.

Check the server answers:

```sh
curl -sS http://<host-ip>:<your BOSSMAN_HOST_PORT, 3100 unless you changed it>/api/health
```

For example, `curl -sS http://192.168.1.50:3100/api/health`.

A good answer is a short line of JSON. The database tables are created by themselves when the server starts.

If you see `Connection refused`, the server has not started yet or the port is wrong. Wait a minute and run the command again, and check that the port matches `BOSSMAN_HOST_PORT` in your `.env`. If it still fails after a few minutes, run `docker compose ps` and `docker compose logs server` to see why the server is not running, and see [docs/29](29-tune-and-troubleshoot.md).

Container logs are capped so they can't slowly fill the disk: each container keeps at most 3 files of 10 MB (`docker compose logs` shows what is kept). To change that, set `BOSSMAN_LOG_MAX_SIZE` and `BOSSMAN_LOG_MAX_FILE` in `.env` (compose services; runners the launcher starts keep the fixed 10m × 3). A new cap applies to a container when it is next recreated by an update.

## 6. Open the web page and make the owner account

On your own computer, open `http://<host-ip>:3100` in a browser. Use the port from your `.env`.

You see "Create the owner account. There's only one, and it controls every company on this server."
1. Type a **Username** and a **Password** (at least 12 characters).
2. Choose **Create owner account**.

You are logged in and the **setup wizard** opens. It has eight steps, each skippable. It remembers where you were. If you leave it, **Finish setting up** shows on **Decisions**. **Settings > Run the setup wizard** brings it back.

## 7. Wizard step "Your company"

1. **Company name:** for example "Boss Man Co".
2. **What it's for:** a sentence or two. The CEO plans the work from this.
3. Choose **Create the company**, then **Next**.

Creating a company also creates its **CEO** agent and a paused **Wiki Maintainer**. With the launcher on, it also starts the company's runner.

Check it worked: you see "Saved." and the step shows a tick.

## 8. Wizard steps "A project" and "The runner"

**A project.** A project is a repo the agents work in.
1. Type a **Project name** and choose **Add the project**.
2. In **Git repo**, paste the repo address, for example `https://github.com/you/repo.git`. For a Gitea on your home network, plain `http://` is allowed.
3. Leave **Default branch** as it is unless yours differs. Under **When work is approved**, choose **Merge into the default branch** or **Open a pull request**. Choose the pull request option if your default branch only accepts pull requests.
4. Save, then **Next**.

**The runner.** It's the container where the company's agents work. It connects out to Boss Man, so it needs no open ports. This step only shows its status.
- If the tag says **Connected**, there is nothing to do.
- If it says **Not connected** and the launcher is on, choose **Start the runner**. Without the launcher, the step points you to **Settings → Server and runner**: follow the steps there.
- If something is wrong (the launcher can't be reached, the runner's container has stopped, or its network guard won't start), the step says which, with a link to the fix in [docs/29](29-tune-and-troubleshoot.md#the-runner-stays-offline-or-never-says-connected).
- Wait for the tag to say **Connected**. This can take up to a minute; the page updates by itself.

Check it worked: **Connected**. If not, see [docs/29, "The runner stays Offline"](29-tune-and-troubleshoot.md#the-runner-stays-offline-or-never-says-connected).

## 9. Wizard steps "Claude" and "A git token"

Make each secret on your own computer, then paste it into the form. Boss Man encrypts it and never shows it again. Paste a token only into these forms, never into a chat or a ticket.

**Claude.** One box, **Claude setup token**. On your own computer:

```sh
claude setup-token
```

Sign in with your Claude Pro or Max account. It prints a long-lived token. Paste it into the box and choose **Save the token**. Boss Man refuses a token with stray spaces or quotes and says why. Saving also makes the funding source and sets the CEO to run on it, so you skip "What pays for the CEO". The step then shows **Connected**; to change it later, use **Settings → Money and access → Secrets**, in the section named after your company (for example "Acme's variables"). If you use an API key instead, open **Use an API key instead** and choose **Anthropic API key**. Codex or OpenCode agents use **OpenAI API key**, **OpenRouter API key**, **Ollama Cloud API key** or **Synthetic API key** from the same list.

**A git token.** Choose **Git token (GitHub or Gitea)** under **Add**. Boss Man's runner uses it as `GIT_TOKEN` for git; agents' own sessions never see it.
- **GitHub:** create a fine-grained personal access token. Repository access: only the repos the company works on. Permissions: Contents, Pull requests and Workflows, read and write (Workflows lets agents change the repo's CI files under `.github/workflows/`). The wizard's **How do I get a token?** also lists Actions read-only, so Boss Man can read CI runs.
- **Gitea:** Settings > Applications > Generate New Token, with repository scope **Read and Write** (`write:repository`).

Paste it and save. Then choose **Check the token against <project>**.

Check it worked: the message says "The token can read and push to the repo." If it says it can read but not push, add write permission to the token.

**Optional: a second account for the merge gate's CI branches.** GitHub emails the account that pushed a branch whenever a GitHub Actions run on it fails. Boss Man's merge gate pushes a `bossman-ci/<ticket>` branch for every merge, so with one token a failed run there emails the token's owner. To send those emails elsewhere, use a second (bot) account:
1. Create the account (or use a teammate's) and add it as a collaborator with write access to the repo.
2. As that account, create a fine-grained token with Contents read and write (and Workflows read and write if the repo's workflows change).
3. In Boss Man, add a secret named `GIT_CI_TOKEN` with that token and grant it to the company. Add `GIT_CI_USERNAME` only if your git host needs a user name (GitHub does not).

Only the two pushes to `bossman-ci/*` use it; everything else keeps `GIT_TOKEN`. Without it nothing changes: the pushes use `GIT_TOKEN` and its owner gets the emails. Agents never see either token. The other way is to mute those emails on the owner's account: GitHub, Settings > Notifications > System > Actions, choose "Don't notify". That also mutes real failures of the owner's own pushes.

## 10. Wizard steps "Checks before merging" and "What pays for the CEO"

**Checks before merging.** Boss Man looks at the repo through the runner and proposes what runs before work merges. Under **Before merging, Boss Man will**, choose one. If the list is the standard one, choose **Re-detect** now that the runner and git token work.

**What pays for the CEO.** If you saved a Claude setup token in step 9, the wizard skips this step: the token already made the funding source. If you used an API key instead, this tracks cost and quota:
1. Under **Funding sources**, name it (for example "Claude Max") and choose a **Kind**: **Subscription (setup-token)** for a Pro or Max plan, or **API credit, monthly grant** for an API key (then give the monthly grant in USD).
2. Choose **Add**.
3. Under "The CEO runs on", pick that source.

Check it worked: the step shows a tick. Funding sources also live under **Settings > Funding**. Paying with a Synthetic plan? See [docs/29, "Synthetic"](29-tune-and-troubleshoot.md#synthetic-opencode).

## 11. Hire a first agent

The CEO already exists. Now hire someone for it to hand work to.

1. In the sidebar, open **Agents**. (You can do this before or after the wizard's last step.)
2. Choose **Hire**.
3. Under **Start from**, pick a role. The templates include Engineer, Researcher, Designer, QA, Writer, Scrum Master, Assistant, Senior Developer and Security Reviewer.
4. Give it a **Name**. Under **Agent**, choose **Claude Code**, **Codex** or **OpenCode**. Leave **Model** blank to use the agent's default, or pick one. Under **Paid from**, pick your funding source.
5. Read the **Instructions** and tailor them to your company.
6. Choose **Hire <name>**.

Check it worked: the agent appears on the **Agents** page. Each row has a **Pause** or **Start** button, and **Edit** to change the agent later.

## 12. Make a first ticket

Either use the wizard's last step, **A first task**, or do it from the project.

From the wizard:
1. Type a **Title**, for example "Read the repo and propose a roadmap".
2. Add a **Description** if you like.
3. Tick **Give it to <CEO name> now (it starts straight away)**.
4. Choose **Add the task to <project>**. Choose **Finish** when you're done with the wizard.

From the board: open **Projects**, open your project, choose **Add task**, fill in **Title** and **Description**, pick an agent under **Assign to**, and choose **Add and start**. **Add to backlog** adds it without starting it.

Check it worked: the ticket shows on the board and the page says "Added".

## 13. Watch it run

- **Runs** shows each agent run, running and recent.
- Open the ticket (from the board, or `#/tickets/<id>`) to follow its conversation and activity.
- **Decisions** is where Boss Man asks you things: a plan to approve, a review, a question. A run may wait there for you.
- **Notifications** shows what needs your attention.

Check it worked: a run appears under **Runs** within a minute or two and the ticket's state changes on the board. If nothing starts, check that the agent isn't paused and the runner says **Connected** in **Settings > Server and runner**.

## 14. Updating later

Read [docs/23-updating.md](23-updating.md) before each update. In short, from the checkout:

```sh
cd $B/src && scripts/deploy.sh
```

It backs up the database to `<install-dir>`, pulls the code, rebuilds, restarts, waits for the server to be healthy, and offers to update the runners when their code changed. Docs/23 covers the runners, backups and what to do if an update goes wrong.

To update from the web page instead, with one approval on **Decisions**, set up the host deployer: [docs/30-in-app-updates.md](30-in-app-updates.md).

## Security notes

- **Keep it on your home network.** Never forward the web port (the one in `BOSSMAN_HOST_PORT`) on your router. `BOSSMAN_INSECURE_COOKIES=1` is for a trusted home network only. For access from outside, use HTTPS in front (for example Tailscale Serve) and remove that setting.
- **The only port that may ever face the internet is the feedback portal's own port**, and only if you choose to share it ([docs/06, section 11](06-install-truenas.md#11-feedback-portal-optional)). By default it is bound to the host itself.
- **Runners need no open ports.** They connect out to the server.
- **Secrets live in Boss Man's secrets.** They're encrypted with the master key, shown once and never again. Agents get them as environment variables for their runs only. Add them only through the credentials form or the **Secrets** page.
- **Never paste tokens into chats, tickets or wiki pages.** Anything an agent can read, it may repeat.
- **Back up `secrets/master.key` off the host.** Without it, stored secrets can't be decrypted.
- **Give git tokens the least access needed:** only the repos the company works on.
- **Protect your default branch** so agents can only land reviewed pull requests, especially if you set up updates from the web page.

## Next steps

- [docs/29-tune-and-troubleshoot.md](29-tune-and-troubleshoot.md): memory limits, reserved threads, Synthetic, backups, and fixes for common problems.
- [docs/30-in-app-updates.md](30-in-app-updates.md): update from the web page (the host deployer).
- [docs/31-phone-notifications.md](31-phone-notifications.md): pages and asks on your phone, with Approve buttons.
- [docs/20-https-tailscale.md](20-https-tailscale.md): HTTPS through Tailscale, for access away from home.
- [docs/32-proxmox.md](32-proxmox.md): running Boss Man on Proxmox (use a VM).
- [docs/21-move-to-new-host.md](21-move-to-new-host.md): moving Boss Man to another Docker host.
- [docs/06-install-truenas.md](06-install-truenas.md): TrueNAS SCALE extras: the dataset, snapshots, blue/green and the feedback portal.
- [docs/09-self-deploy.md](09-self-deploy.md): how updates from the web page, the drain and blue/green updates work.
- [docs/12-runner-add-ons.md](12-runner-add-ons.md): optional tools in the runner image, such as a browser for agents.
- [docs/14-paperclip-migration.md](14-paperclip-migration.md): move a company over from Paperclip, as an optional later step.
- [docs/11-import-export.md](11-import-export.md): export a company as a backup or import one (**Settings > Import and export**).
- [docs/07-feature-requests.md](07-feature-requests.md): the feedback portal and what it lets people do.
- [docs/01-scope.md](01-scope.md) and [docs/02-architecture.md](02-architecture.md): what Boss Man is for and how it fits together.
