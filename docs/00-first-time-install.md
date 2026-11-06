# 00 — First-time install

This is the short path from nothing to a working Boss Man on a Linux host with Docker. For a worked example on TrueNAS SCALE, with backups, the host deployer and more, see [docs/06-install-truenas.md](06-install-truenas.md).

> **Verification:** every file name, setting and button label in this guide was checked against the code. The full install was **not** re-run on a fresh machine for this edit, so treat the exact command output as unverified.

## What you'll end up with

- Boss Man running on a machine you own, with its web page open on your home network.
- One company, with a CEO agent already in it, and one more agent you hire.
- One project (a git repo) and a first ticket that an agent runs.

## What you need first

- **A 64-bit Linux host** with **Docker Engine** and **Docker Compose v2** (the `docker compose` command). Check with `docker compose version`. The compose files use secrets, profiles and the top-level `name:` setting. The repo doesn't state an exact minimum Compose version, except that the optional blue/green setup needs 2.24 or newer. It doesn't state a minimum amount of RAM or disk either. Each runner is limited to 4 GB of memory by default (`BOSSMAN_RUNNER_MEMORY`; see "Memory limits" below for the server, database and tool servers) and 4096 processes and threads (`BOSSMAN_RUNNER_PIDS`); raise the second if parallel test runs fail with `spawn EAGAIN`.
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
- turns on the **launcher**, which starts each company's runner for you (details in [docs/06, step 7b](06-install-truenas.md#7b-let-the-launcher-run-the-runners-recommended));
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
- `BOSSMAN_HOST_PORT` is the port you type in the browser. The compose file's default is 3100. If something else uses it, pick another free port (see Troubleshooting).
- `BOSSMAN_INSECURE_COOKIES=1` lets you log in over plain `http://` on your home network. Without it, login needs HTTPS.
- `BOSSMAN_DEPLOYER` is the optional host deployer's folder (step 14). The runner update script and the deployer's compose files read it from here.

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

Build the server (it includes the web page), the launcher and netguard. The launcher starts netguard beside every runner, so it must be built too:

```sh
docker compose build server launcher netguard
```

Using the optional blue/green setup? Build both server copies instead:

```sh
docker compose build server-blue server-green launcher netguard
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
curl -s http://<host-ip>:3100/api/health
```

You should get a short line of JSON. The database tables are created by themselves when the server starts.

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

It prints a long-lived token for your subscription. Paste it into **Value**, leave **Variable name** as `CLAUDE_CODE_OAUTH_TOKEN`, then choose **Check** and save. Boss Man refuses a token with stray spaces or quotes and says why. In the table, choose **Check with Claude**: it runs one tiny prompt on the runner and uses a little of your allowance. If you use an API key instead, choose **Anthropic API key**. Codex or OpenCode agents use **OpenAI API key**, **OpenRouter API key**, **Ollama Cloud API key** or **Synthetic API key** from the same list.

**A git token.** Choose **Git token (GitHub or Gitea)** under **Add**. Boss Man's runner uses it as `GIT_TOKEN` for git; agents' own sessions never see it.
- **GitHub:** create a fine-grained personal access token. Repository access: only the repos the company works on. Permissions: Contents, Pull requests and Workflows, read and write (Workflows lets agents change the repo's CI files under `.github/workflows/`). The wizard's **How do I get a token?** also lists Checks read, so Boss Man can read CI results.
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

### Synthetic (OpenCode)

Synthetic (synthetic.new) is an OpenCode provider. Add its key under **Settings > Secrets > Add** as **Synthetic API key**; it reaches agents as `SYNTHETIC_API_KEY`, and OpenCode lists the models as `synthetic/<model>` (for example `synthetic/hf:deepseek-ai/DeepSeek-V4.1-Flash-1017`). Under **Settings > Funding**, add a source with kind **Subscription (setup-token)** and provider **Synthetic** for a standard plan. The Funding page reads the Synthetic key you granted to the company and shows requests used of the plan's limit, the percentage, when it renews, and how use has moved within the current period.

Boss Man checks the plan at most every 5 minutes, and again right after a run on an agent paid from Synthetic ends, then keeps the reading. The Funding page shows the stored reading rather than asking Synthetic every time you open it. If Synthetic can't be reached, the card keeps the last good reading and says how old it is (or says the quota is unknown if there has never been one); it never stops a run. Readings are kept for 30 days, so the card can show the trend for the period, then older ones are dropped.

When use passes 80% of the limit you get one notification, and another when it reaches 100%. Each names when the plan renews and which agents are paid from Synthetic, and each is sent only once per period; the period is the renewal time rounded down to the hour, so if Synthetic reports a renewal time that shifts by a few minutes between readings you still get one warning, not two. Boss Man does not pause or slow any runs when the plan runs out: move less urgent work or wait for the renewal. The CEO can read the same numbers (used, limit, renewal, the reading's age, recent readings and the agents on it) from its server status in chats and runs; it sees only its own company's agents named, and any other company's agents on the same plan are counted but never named. Keys are never logged or shown after saving.

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

Set `B` first if this is a new shell (step 1).

**The server and web page.** The deploy script backs up the database to `<install-dir>`, pulls the code, rebuilds, restarts, waits for the server to be healthy, and updates runners only if their code changed:

```sh
cd $B/src && scripts/deploy.sh
```

Add `--dry-run` to see the steps without running them. It stops if the checkout has uncommitted changes or isn't on the default branch, and says so. If the health check fails it prints the rollback commands and changes nothing by itself.

**The runner** (roughly weekly, for new Claude Code releases, and after any change under `apps/runner`, `apps/launcher` or `packages/shared`). It builds a new image and checks it. With the launcher on, Boss Man then drains (nothing new starts, runs finish) and swaps each runner when its company is idle. It doesn't back up anything.

```sh
cd $B/src && scripts/update-runner.sh
```

Follow it under **Settings > Server and runner**, in **Runner update**, which also has **Cancel the update**. The script asks Boss Man to drain through the folder in `BOSSMAN_DEPLOYER`. If that folder has no `inbox` (you haven't set up the host deployer), it tells you to start the swap in Boss Man with **Update runners (finish runs first)**. To undo, run `scripts/update-runner.sh --rollback`.

**Deploy latest** is optional. It needs the host deployer, a root script run by a one-minute cron job. [docs/06, 9a](06-install-truenas.md#9a-install-the-host-deployer-optional) is a worked example, and its paths are the TrueNAS ones: use `<install-dir>/deployer` in their place. Install the deployer's copy in `<install-dir>/deployer`: it uses the folder it sits in, and finds the code in `<install-dir>/src` beside it. Once it works, Boss Man asks "Deploy <commit>?" on **Decisions** when `main` moves, and **Settings > Server and runner > Updates > Deploy latest** asks on demand. The **Updates** section only appears once the deployer is set up. The deployer refuses changes to files like `scripts/`, `deploy/`, compose files and Dockerfiles. Apply those by hand with `scripts/deploy.sh`.

**Compression.** The web build writes brotli and gzip copies next to every built asset, and the server sends those, so the page's JavaScript, CSS and fonts arrive compressed on every kind of install, with no per-page CPU cost. This plain install has no proxy, so the API's JSON is sent uncompressed; the blue/green setup (docs/06, 9d) compresses it at the Caddy front door.

**The infra rebuild script.** `scripts/rebuild-live.sh` is only for the optional blue/green setup ([docs/06, 9d](06-install-truenas.md#9d-switch-to-bluegreen-optional)), which needs Docker Compose 2.24 or newer. It rebuilds the live copy in place after a change the deployer refuses, and the page is down for about 20 to 30 seconds. On a plain install, use `scripts/deploy.sh` instead. How it all fits together: [docs/09-self-deploy.md](09-self-deploy.md).

## Memory limits (so one container can't take the whole host)

On 3 Nov 2026 a headless browser with no memory limit used up the whole host's memory; the kernel then killed other things, including the proxy (BOS-392). Every container Boss Man starts now has a limit and a kill priority, set in `.env`. All of these are optional; the defaults are below.

| Setting in `.env` | What it limits | Default |
| --- | --- | --- |
| `BOSSMAN_RUNNER_MEMORY` | each runner, including the browsers and test runs inside it (no swap on top) | `4g` |
| `BOSSMAN_RUNNER_PIDS` | processes and threads per runner | `4096` |
| `BOSSMAN_RUNNER_CPU_SHARES` | CPU priority of each runner against the server, database and proxy (1024 each, proxy 2048). Not a cap: only matters when the host is busy, and an idle host still lets runners use every core | `512` |
| `BOSSMAN_RUNNER_CPUS` | optional hard CPU cap per runner (e.g. `4`). Leave empty unless the host is shared with other workloads: one runner hosts all of a company's agents and the merge check, so a low cap slows them all even when the host is idle | none |
| `BOSSMAN_SERVER_MEMORY` / `BOSSMAN_SERVER_MEMORY_RESERVED` | the server (single, or each blue/green colour): limit / amount kept for it. No cap by default (`0`), because the server currently uses 10-13 GiB; set a value only once measured | `0` / `512m` |
| `BOSSMAN_DB_MEMORY` / `BOSSMAN_DB_MEMORY_RESERVED` | Postgres: limit / amount kept for it | `0` (no cap) / `256m` |
| `BOSSMAN_TOOLSERVER_MEMORY`, `BOSSMAN_TOOLSERVER_PIDS`, `BOSSMAN_TOOLSERVER_SHM` | tool servers that run a browser (crawl4ai, scrapling), see below | `2g`, `512`, `512m` |

- **Priority.** If the host runs out anyway, Linux stops runners and tool servers first (`oom_score_adj` 500) and the database, server and proxy last (-500, -500 and -900). A runaway browser hits its own limit first and only that container is stopped and restarted.
- **CPU.** On a Proxmox LXC (or any VM or container host) the container's own CPU limit applies on top of these settings. The weights only decide who wins when the CPUs are all busy.
- **Choose numbers for your host.** Add up the limits of everything that can run at once (every runner plus tool servers); keep that below the host's RAM with room for the server, database and proxy. Limits are ceilings, not reservations, so they can add up to more than the RAM, but then one busy moment can still run the host out.
- **Tool servers are yours.** Boss Man does not start crawl4ai, scrapling or other tool servers you register in Settings, so it cannot limit them for you. Put them in compose with limits: [deploy/tool-servers.yml](../deploy/tool-servers.yml) is a commented example. One already running by hand: `docker update --memory 2g --memory-swap 2g --pids-limit 512 <container>` (lost if the container is recreated).
- **Check it took effect.** `docker stats --no-stream` should show a number after the slash for each Boss Man container, not your whole RAM. `docker inspect -f '{{.HostConfig.Memory}} {{.HostConfig.OomScoreAdj}}' <container>` prints the limit in bytes and the priority (0 bytes = no limit).
- **Applying a change.** `docker compose up -d` recreates the containers whose limits changed (the server and database restart for a few seconds). Runners started by the launcher pick up a new `BOSSMAN_RUNNER_MEMORY` when the launcher is recreated and the runner is next restarted.
- **A test keeps this in place:** `apps/server/test/compose-memory-limits.test.ts` fails if a service loses its `mem_limit`.

Per host:
- **Plain Linux or a Proxmox VM:** nothing extra. If `docker info` warns "No swap limit support", the swap setting is ignored but the memory limit still works; to enable it, add `cgroup_enable=memory swapaccount=1` to the kernel command line and reboot.
- **Proxmox LXC running Docker:** limits apply inside the LXC's own memory setting, so size the LXC first. Whether your LXC enforces swap limits is unknown; find out with the `docker inspect` line above and `docker stats` after starting.
- **TrueNAS SCALE:** nothing extra; the same settings go in the `.env` from docs/06 step 4.

## Troubleshooting

The commands below use `$B` from step 1. If you opened a new shell, set it again first.

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

Use the new port in the browser.

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
- "can read the repo but not push to it": give the token write permission (Contents, Pull requests and Workflows on GitHub, `write:repository` on Gitea).
- For a Gitea on your network, check the address is reachable from the host.

**The Claude token is refused.**
Boss Man rejects a token with stray spaces or quotes. Paste only the token. Then choose **Check with Claude** in the credentials table. A setup-token can only be fully proved by Claude Code on the runner, so the runner must be **Connected** first.

**The server doesn't start, or the page says offline (migrations).**
Database changes apply by themselves when the server starts. Check:

```sh
cd $B/src && docker compose logs --tail 100 server
```

If a migration failed, don't edit the database by hand. Keep the log. Restore from a backup if you have one (`scripts/deploy.sh` keeps them in `$B`). Also check Postgres is healthy with `docker compose ps`.

**Where Boss Man backups are saved.**
Every script that makes a backup writes it straight into your backup folder, which is `<install-dir>` (`$B` in this guide), next to `src`. The file names tell you which script made them:
- `bossman-YYYY-MM-DD-HHMM.sql.gz`: made before each update (`scripts/deploy.sh`) and by the host deployer.
- `rebuild-YYYY-MM-DD-HHMM.sql.gz`: made by `scripts/rebuild-live.sh`.
- `restore-test-*.sql.gz`: made by `scripts/restore-test.sh --fresh-backup`.
- `penpot-YYYY-MM-DD-HHMM.tar`: made by `scripts/backup-penpot.sh`, if you use Penpot.

If you set `BOSSMAN_BACKUP_DIR`, they go there instead. Backups made by current scripts are readable by their owner only (mode 600).

**Lock down backups made before this fix.**
Older backups may be readable by every user on the host and hold password hashes and sessions. To list the ones that are not owner-only, run:

```sh
find $B -maxdepth 1 -type f \( -name 'bossman-*.sql.gz' -o -name 'rebuild-*.sql.gz' -o -name 'restore-test-*.sql.gz' -o -name 'penpot-*.tar' \) -perm /077 -print
```

To lock them all down, run this once. It is safe to run again, and it only changes files in that folder (not folders below it). If you set `BOSSMAN_BACKUP_DIR`, put that folder in place of `$B`:

```sh
find $B -maxdepth 1 -type f \( -name 'bossman-*.sql.gz' -o -name 'rebuild-*.sql.gz' -o -name 'restore-test-*.sql.gz' -o -name 'penpot-*.tar' \) -exec chmod 600 {} +
```

Run the first command again: it should print nothing.

**The disk is filling up.**
Check the host and Docker:

```sh
df -h $B
```

```sh
docker system df
```

**Settings > Server and runner** shows the runner's **Workspaces** size. Each company has a disk cap (20 GB by default); Boss Man tells you once a day when a company is over it, and it releases the workspaces of tickets that were finished a while ago (7 days by default). Builds of the runner image also use space. Check `docker system df` before removing anything.

## Security notes

- **Keep it on your home network.** Never forward the web port (the one in `BOSSMAN_HOST_PORT`) on your router. `BOSSMAN_INSECURE_COOKIES=1` is for a trusted home network only. For access from outside, use HTTPS in front (for example Tailscale Serve) and remove that setting.
- **The only port that may ever face the internet is the feedback portal's own port**, and only if you choose to share it ([docs/06, section 11](06-install-truenas.md#11-feedback-portal-optional)). By default it is bound to the host itself.
- **Runners need no open ports.** They connect out to the server.
- **Secrets live in Boss Man's secrets.** They're encrypted with the master key, shown once and never again. Agents get them as environment variables for their runs only. Add them only through the credentials form or the **Secrets** page.
- **Never paste tokens into chats, tickets or wiki pages.** Anything an agent can read, it may repeat.
- **Back up `secrets/master.key` off the host.** Without it, stored secrets can't be decrypted.
- **Give git tokens the least access needed:** only the repos the company works on.
- **Protect your default branch** so agents can only land reviewed pull requests, especially if you set up Deploy latest.

## Next steps

- [docs/06-install-truenas.md](06-install-truenas.md): a worked example on TrueNAS SCALE, with backups, the host deployer, blue/green, phone notifications and the feedback portal.
- [docs/09-self-deploy.md](09-self-deploy.md): how "Deploy latest", the drain and blue/green updates work.
- [docs/12-runner-add-ons.md](12-runner-add-ons.md): optional tools in the runner image, such as a browser for agents.
- [docs/14-paperclip-migration.md](14-paperclip-migration.md): move a company over from Paperclip, as an optional later step.
- [docs/11-import-export.md](11-import-export.md): export a company as a backup or import one (**Settings > Import and export**).
- [docs/07-feature-requests.md](07-feature-requests.md): the feedback portal and what it lets people do.
- [docs/01-scope.md](01-scope.md) and [docs/02-architecture.md](02-architecture.md): what Boss Man is for and how it fits together.
