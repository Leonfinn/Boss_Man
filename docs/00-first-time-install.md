# 00 — First-time install

This is the short path from nothing to a working Boss Man. For the full detail behind any step, follow the links to [docs/06-install-truenas.md](06-install-truenas.md).

## What you'll end up with

- Boss Man running on your own box, with its web page open on your home network.
- One company, with a CEO agent already in it, and one more agent you hire.
- One project (a git repo) and a first ticket that an agent runs.

## What you need first

- **A TrueNAS SCALE box**, version 24.10 or later, with an apps pool chosen (Apps > Configuration > Choose Pool). Docker only runs once a pool is chosen. The repo doesn't state a minimum amount of RAM or disk. Each runner is limited to 4 GB of memory by default (`BOSSMAN_RUNNER_MEMORY`).
- **A plain Linux box with Docker** also works for the server and database: `docker-compose.yml` says it "runs on any Docker host". But the update scripts assume TrueNAS folder names, and this guide's commands are written for TrueNAS. If you use plain Linux, use the commands in the header of `docker-compose.yml`, and set `BOSSMAN_BACKUP_DIR` when you run `scripts/deploy.sh`.
- **A git host account and token.** GitHub (a fine-grained token) or Gitea. You make the token in step 9.
- **An AI provider for at least one agent program.** The runner supports three:
  - **Claude Code**: a Claude Pro or Max subscription, or an Anthropic API key.
  - **Codex**: an OpenAI API key, or a ChatGPT plan.
  - **OpenCode**: an OpenRouter or Ollama Cloud key (or an OpenAI or Anthropic key).

  The CEO is a Claude Code agent unless you change it, so the easiest start is a Claude subscription.
- **A second computer** (your Mac or PC) with a web browser. It is also where you make the Claude token in step 9.
- **Access to the repo's code.** The guide uses a read-only deploy key on GitHub, as `docs/06` does. If you can't use one, check how you can get the code onto the box (`git --version` must work on the TrueNAS host).

## A note on commands

- On TrueNAS SCALE you work in a **root shell**: TrueNAS UI > System > Shell, or `su -` over SSH. So there is no `sudo` in any command here.
- Each command is in its own box. Copy it whole.
- Where you see something in `<angle brackets>`, replace it, brackets and all.

## 1. Choose where Boss Man lives

What you do: pick a folder on your apps pool. `docs/06` makes it a dataset so you can snapshot it ([step 1 there](06-install-truenas.md#1-create-a-dataset)). A plain folder works too.

Set a shell variable for it. Replace `<your-pool>` with your pool name. Use the same shell for the next steps. If you close it, run this line again.

```sh
B=/mnt/<your-pool>/boss-man
```

Make the folder:

```sh
mkdir -p $B
```

Check it worked:

```sh
ls -ld $B
```

You should see the folder listed.

## 2. Get the code onto the box

The repo is private, so the box reads it with a **deploy key**: an SSH key for this one repo, read-only. It has no passphrase, so updates can run unattended. The full reasoning is in [docs/06, step 2](06-install-truenas.md#2-get-the-code).

Make the key:

```sh
ssh-keygen -t ed25519 -N "" -C "truenas-boss-man" -f $B/deploy_key
```

Show the public half. It's safe to copy. Never copy the file without `.pub`.

```sh
cat $B/deploy_key.pub
```

On your own computer, open `https://github.com/Leonfinn/Boss_Man/settings/keys`, choose **Add deploy key**, call it `TrueNAS`, paste the line, and leave **Allow write access** unticked.

Clone the code into `$B/src`:

```sh
GIT_SSH_COMMAND="ssh -i $B/deploy_key -o IdentitiesOnly=yes -o UserKnownHostsFile=$B/known_hosts" git clone git@github.com:Leonfinn/Boss_Man.git $B/src
```

The first time, ssh asks whether to trust github.com. Type `yes` only if the fingerprint matches the one on GitHub's [SSH key fingerprints](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/githubs-ssh-key-fingerprints) page.

Make later updates use the same key:

```sh
git -C $B/src config core.sshCommand "ssh -i $B/deploy_key -o IdentitiesOnly=yes -o UserKnownHostsFile=$B/known_hosts"
```

Check it worked:

```sh
git -C $B/src log --oneline -1
```

You should see one commit line. If the clone hangs, port 22 may be blocked on your router.

## 3. Make the folders, the master key and the token file

The server and runners run as user ID 1000, so the folders they write to must belong to 1000.

```sh
mkdir -p $B/data/postgres $B/data/companies $B/src/secrets
```

```sh
chown 1000:1000 $B/data/companies $B/src/secrets && chmod 700 $B/src/secrets
```

The **master key** encrypts every secret Boss Man stores. Make it:

```sh
openssl rand -base64 32 > $B/src/secrets/master.key && chown 1000:1000 $B/src/secrets/master.key && chmod 600 $B/src/secrets/master.key
```

Copy that file somewhere safe outside the box now. Without it, stored secrets cannot be read again.

Docker Compose refuses to start while a secret file named in the compose file is missing. Make the runner token file empty. The launcher (step 4) doesn't use it:

```sh
touch $B/src/secrets/runner-app-co.token && chown 1000:1000 $B/src/secrets/runner-app-co.token && chmod 600 $B/src/secrets/runner-app-co.token
```

Check it worked:

```sh
ls -l $B/src/secrets
```

You should see `master.key` and `runner-app-co.token`.

## 4. Write the settings file

Boss Man reads a file called `.env` in the repo folder. This one:
- adds the TrueNAS file so your data lives in your own folders;
- turns on the **launcher**, which starts each company's runner for you (details in [docs/06, step 7b](06-install-truenas.md#7b-let-the-launcher-run-the-runners-recommended));
- opens the web page on your box's LAN address only.

Find your box's LAN address first (TrueNAS UI > Network). Replace `<your-truenas-ip>` below with it. The command reads the Docker socket's group number for you.

```sh
cat > $B/src/.env <<EOF
COMPOSE_FILE=docker-compose.yml:deploy/truenas.yml
COMPOSE_PROFILES=launcher
BOSSMAN_LAUNCHER=1
BOSSMAN_DOCKER_GID=$(stat -c %g /var/run/docker.sock)
BOSSMAN_DATA=$B/data
POSTGRES_PASSWORD=$(openssl rand -hex 24)
BOSSMAN_BIND=<your-truenas-ip>
BOSSMAN_HOST_PORT=3100
BOSSMAN_INSECURE_COOKIES=1
EOF
```

```sh
chmod 600 $B/src/.env
```

What the settings mean:
- `BOSSMAN_BIND` publishes the web page on that address only. The default is `127.0.0.1`, which only the box itself can reach.
- `BOSSMAN_HOST_PORT` is the port you type in the browser. The compose file's default is 3100. If something else uses it, pick another free port (see Troubleshooting).
- `BOSSMAN_INSECURE_COOKIES=1` lets you log in over plain `http://` on your home network. Without it, login needs HTTPS.

Check the file:

```sh
cat $B/src/.env
```

`BOSSMAN_DOCKER_GID` should be a number (999 on the box in `docs/06`), and `BOSSMAN_BIND` should be your address.

## 5. Build the images and start Boss Man

Go to the repo folder. Every `docker compose` command must run from here.

```sh
cd $B/src
```

Build the server (it includes the web page) and the launcher:

```sh
docker compose build server launcher
```

Build the runner image. This builds it, runs a safety check (the "canary") with networking off and no credentials, and only then marks it ready. It then starts everything.

```sh
scripts/update-runner.sh
```

Expect a line saying no launcher is running, so it restarts runners at once. That is harmless on a first install: it is how the script brings the stack up. If the canary fails, it says so and leaves the runner image unset.

Check it worked:

```sh
docker compose ps
```

You should see `db` and `server` as running (the server `healthy` after a short wait) and `launcher` running.

Check the server answers:

```sh
curl -s http://<your-truenas-ip>:3100/api/health
```

You should get a short line of JSON. The database tables are created by themselves when the server starts.

## 6. Open the web page and make the owner account

On your own computer, open `http://<your-truenas-ip>:3100` in a browser. Use the port from your `.env`.

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

**The runner.** It's the container where the company's agents work. It connects out to Boss Man, so it needs no open ports.
- With the launcher on, the step shows the container `boss-man-runner-<slug>`. If the connection says **Not started**, choose **Start runner**.
- Wait for the tag to say **Connected**. It goes through **Starting…** first. This can take up to a minute.

Check it worked: **Connected**. If not, see Troubleshooting. To run runners without the launcher instead, see [docs/06, step 7](06-install-truenas.md#7-the-runner-token).

## 9. Wizard steps "Claude" and "A git token"

Make each secret on your own computer, then paste it into the form. Boss Man encrypts it and never shows it again. Paste a token only into these forms, never into a chat or a ticket.

**Claude.** Choose **Claude setup-token** under **Add**. On your own computer:

```sh
claude setup-token
```

It prints a long-lived token for your subscription. Paste it into **Value**, leave **Variable name** as `CLAUDE_CODE_OAUTH_TOKEN`, then choose **Check** and save. Boss Man refuses a token with stray spaces or quotes and says why. In the table, choose **Check with Claude**: it runs one tiny prompt on the runner and uses a little of your allowance. If you use an API key instead, choose **Anthropic API key**. Codex or OpenCode agents use **OpenAI API key**, **OpenRouter API key** or **Ollama Cloud API key** from the same list.

**A git token.** Choose **Git token (GitHub or Gitea)** under **Add**. Agents get it as `GIT_TOKEN`.
- **GitHub:** create a fine-grained personal access token. Repository access: only the repos the company works on. Permissions: Contents and Pull requests, read and write. The wizard's **How do I get a token?** also lists Checks read, so Boss Man can read CI results.
- **Gitea:** Settings > Applications > Generate New Token, with repository scope **Read and Write** (`write:repository`).

Paste it and save. Then choose **Check the token against <project>**.

Check it worked: the message says "The token can read and push to the repo." If it says it can read but not push, add write permission to the token.

## 10. Wizard steps "Checks before merging" and "What pays for the CEO"

**Checks before merging.** Boss Man looks at the repo through the runner and proposes what runs before work merges. Under **Before merging, Boss Man will**, choose one. If the list is the standard one, choose **Re-detect** now that the runner and git token work.

**What pays for the CEO.** This tracks cost and quota.
1. Under **Funding sources**, name it (for example "Claude Max") and choose a **Kind**: **Subscription (setup-token)** for a Pro or Max plan, or **API credit, monthly grant** for an API key (then give the monthly grant in USD).
2. Choose **Add**.
3. Under "The CEO runs on", pick that source.

Check it worked: the step shows a tick. Funding sources also live under **Settings > Funding**.

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

Take a backup first if you can. Both update commands below make a database backup themselves.

**The server and web page.** Run the deploy script from the repo folder. It backs up the database, pulls the code, rebuilds, restarts, waits for the server to be healthy, and updates runners only if their code changed:

```sh
cd $B/src && BOSSMAN_BACKUP_DIR=$B scripts/deploy.sh
```

Add `--dry-run` to see the steps without running them. It stops if the checkout has uncommitted changes or isn't on the default branch, and says so. If the health check fails it prints the rollback commands and changes nothing by itself.

**The runner** (roughly weekly, for new Claude Code releases, and after any change under `apps/runner`, `apps/launcher` or `packages/shared`). It builds a new image, checks it, and with the launcher on, Boss Man drains (nothing new starts, runs finish) and swaps each runner when its company is idle:

```sh
cd $B/src && scripts/update-runner.sh
```

Follow it under **Settings > Server and runner**, in **Runner update**, which also has **Cancel the update**. Without a host deployer folder set up, the script tells you to start the swap there with **Update runners (finish runs first)**. To undo, run `scripts/update-runner.sh --rollback`.

**Deploy latest.** If you set up the optional host deployer ([docs/06, 9a](06-install-truenas.md#9a-install-the-host-deployer-optional)), Boss Man asks "Deploy <commit>?" on **Decisions** when `main` moves. You can also choose **Settings > Server and runner > Updates > Deploy latest**. The **Updates** section only appears once the deployer is set up. The deployer refuses changes to files like `scripts/`, `deploy/`, compose files and Dockerfiles. Apply those by hand with `scripts/deploy.sh`.

**The infra rebuild script.** `scripts/rebuild-live.sh` is only for the optional blue/green setup ([docs/06, 9d](06-install-truenas.md#9d-switch-to-bluegreen-optional)). It rebuilds the live copy in place after a change the deployer refuses. The page is down for about 20 to 30 seconds. On a plain install, use `scripts/deploy.sh` instead. How it all fits together: [docs/09-self-deploy.md](09-self-deploy.md).

## Troubleshooting

**The runner stays Offline, or never says Connected.**
Check the runner's container and log:

```sh
docker ps -a --filter name=boss-man-runner
```

```sh
docker logs --tail 50 boss-man-runner-<slug>
```

`<slug>` is shown in **Settings > Server and runner** under **Runner**. Fixes:
- If the runner image was never built, or the canary failed in step 5, run `scripts/update-runner.sh` again, then choose **Start runner**.
- If **Settings** shows an error under the runner (the launcher couldn't start it), check `BOSSMAN_DOCKER_GID` in `.env` matches `stat -c %g /var/run/docker.sock`, then `docker compose up -d`.
- Choose **Reconnect runner** to give it a fresh token and container.
- A log line `getaddrinfo ENOTFOUND server` means the server wasn't reachable. The runner retries by itself every 30 seconds.
- Running without the launcher? An empty token file makes the runner stop with "Set BOSSMAN_RUNNER_TOKEN_FILE...". Follow [docs/06, step 7](06-install-truenas.md#7-the-runner-token).

**The port is already in use.**
Check:

```sh
ss -tlnp | grep -E ':3100\b'
```

Nothing printed means it's free. If something is listed, change `BOSSMAN_HOST_PORT` in `$B/src/.env` to a free port, then:

```sh
cd $B/src && docker compose up -d
```

Use the new port in the browser. (`docs/06` uses 3101 because another app on that box used 3100.)

**I can't log in, or the login page just reloads.**
Session cookies are Secure by default and need HTTPS. For plain `http://` on a trusted home network, `.env` needs `BOSSMAN_INSECURE_COOKIES=1`. Check:

```sh
grep BOSSMAN_INSECURE_COOKIES $B/src/.env
```

After changing it, run `docker compose up -d` from `$B/src`. Open the page with the same address each time, so the cookie keeps working.

**`docker compose` says something is not set or a file is missing.**
Messages like "Set POSTGRES_PASSWORD in .env" or "Set BOSSMAN_DATA in .env" mean `.env` is missing, or you're not in `$B/src`. A missing secret file means step 3 wasn't finished. Check:

```sh
cd $B/src && ls -a . secrets
```

You need `.env`, `secrets/master.key` and `secrets/runner-app-co.token`.

**The git token is refused.**
**Check the token against <project>** says what the host answered:
- "The host refused the token (HTTP 401 or 403)": the token is wrong, expired or lacks permission. Make a new one.
- "The token can't see the repo": check the repo's owner and name in **Git repo**, and that the token has access to it.
- "can read the repo but not push to it": give the token write permission (Contents and Pull requests on GitHub, `write:repository` on Gitea).
- For a Gitea on your network, check the address is reachable from the box.

**The Claude token is refused.**
Boss Man rejects a token with stray spaces or quotes. Paste only the token. Then choose **Check with Claude** in the credentials table. A setup-token can only be fully proved by Claude Code on the runner, so the runner must be **Connected** first.

**The server doesn't start, or the page says offline (migrations).**
Database changes apply by themselves when the server starts. Check:

```sh
cd $B/src && docker compose logs --tail 100 server
```

If a migration failed, don't edit the database by hand. Keep the log. Restore from a backup if you have one (`scripts/deploy.sh` keeps them in `$B`). Also check Postgres is healthy with `docker compose ps`.

**The disk is filling up.**
Check the box and Docker:

```sh
df -h $B
```

```sh
docker system df
```

**Settings > Server and runner** shows the runner's **Workspaces** size. Each company has a disk cap (20 GB by default); Boss Man tells you once a day when a company is over it, and it releases the workspaces of tickets that were finished a while ago (7 days by default). Builds of the runner image also use space. Check `docker system df` before removing anything.

## Security notes

- **Keep it on your home network.** Never forward the web port (the one in `BOSSMAN_HOST_PORT`) on your router. `BOSSMAN_INSECURE_COOKIES=1` is for a trusted home network only. For access from outside, use HTTPS in front (for example Tailscale Serve) and remove that setting.
- **The only port that may ever face the internet is the feedback portal's own port**, and only if you choose to share it ([docs/06, section 11](06-install-truenas.md#11-feedback-portal-optional)). By default it is bound to the box itself.
- **Runners need no open ports.** They connect out to the server.
- **Secrets live in Boss Man's secrets.** They're encrypted with the master key, shown once and never again. Agents get them as environment variables for their runs only. Add them only through the credentials form or the **Secrets** page.
- **Never paste tokens into chats, tickets or wiki pages.** Anything an agent can read, it may repeat.
- **Back up `secrets/master.key` off the box.** Without it, stored secrets can't be decrypted.
- **Give git tokens the least access needed:** only the repos the company works on.
- **Protect your default branch** so agents can only land reviewed pull requests, especially if you set up Deploy latest.

## Next steps

- [docs/06-install-truenas.md](06-install-truenas.md): the full TrueNAS install, with backups, the host deployer, blue/green, phone notifications and the feedback portal.
- [docs/09-self-deploy.md](09-self-deploy.md): how "Deploy latest", the drain and blue/green updates work.
- [docs/12-runner-add-ons.md](12-runner-add-ons.md): optional tools in the runner image, such as a browser for agents.
- [docs/14-paperclip-migration.md](14-paperclip-migration.md): move a company over from Paperclip, as an optional later step.
- [docs/11-import-export.md](11-import-export.md): export a company as a backup or import one (**Settings > Import and export**).
- [docs/07-feature-requests.md](07-feature-requests.md): the feedback portal and what it lets people do.
- [docs/01-scope.md](01-scope.md) and [docs/02-architecture.md](02-architecture.md): what Boss Man is for and how it fits together.
