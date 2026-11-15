---
title: Troubleshooting
navTitle: Troubleshooting
description: Fixes for the things that most often go wrong when you install, run and update Boss Man, each with the guide it comes from.
group: Questions
order: 11
lead: Find what you see in the list below. Each entry gives the fix and the guide it comes from.
---

This page is for you if something in Boss Man is not working and you want the fix without reading every guide.

The commands use `$B`, the install folder from [Guide 2](/guides/install-boss-man), step 1. If you opened a new shell, set it again first, for example `B=/opt/boss-man`. Run every `docker compose` command from `$B/src`.

If your problem is not here, open an issue on GitHub and say which step of which guide you are on.

## Installing

### Docker Compose says "Set POSTGRES_PASSWORD in .env", or that a file is missing.

You are not in `$B/src`, or [Guide 2](/guides/install-boss-man) step 3 or 4 is not finished. Run `cd $B/src && ls -a . secrets`. You need `.env`, `secrets/master.key` and `secrets/runner-app-co.token`. Also check `.env` has a `BOSSMAN_DATA` line: without one, Compose gives no error and uses `/srv/boss-man/data` instead.

From: [Guide 2](/guides/install-boss-man).

### The port is already in use.

Run `ss -tlnp | grep -E ':3100\b'`. If it prints nothing, the port is free. If it prints a line, change `BOSSMAN_HOST_PORT` in `$B/src/.env` to a free port, run `docker compose up -d`, and use the new port in your browser.

From: [Guide 2](/guides/install-boss-man).

### The server does not start, or the page says Boss Man is offline.

Boss Man updates its database by itself when the server starts. Read the server's log with `docker compose logs --tail 100 server`, and check the database is healthy with `docker compose ps`. If the log shows a database update failed, do not edit the database by hand. Keep the log, and restore the backup from before the update (see "An update damaged my data" below).

From: [Guide 10](/guides/updates-and-backups).

## Logging in

### The login page reloads, or I cannot log in.

On plain `http://`, Boss Man needs `BOSSMAN_INSECURE_COOKIES=1` in `.env`. Check with `grep BOSSMAN_INSECURE_COOKIES $B/src/.env`. Add the line if it is missing, then run `docker compose up -d`. Open the page with the same address every time, because the login only works on the address you logged in with.

From: [Guide 2](/guides/install-boss-man).

### I want to reach Boss Man from outside my home.

Do not forward the web port on your router. Use the Tailscale add-on, which gives Boss Man an HTTPS address that only your own devices can reach.

From: [Guide 2](/guides/install-boss-man) and [Guide 9](/guides/add-ons).

## The runner

### The runner says Offline or Not started, or never says Connected.

Open **Settings > Server and runner** and find **Runner**.

1. If it says **Not started**, choose **Start runner**. It can take up to a minute.
2. If an error shows under the runner, Boss Man could not start it. Check that `BOSSMAN_DOCKER_GID` in `.env` matches the output of `stat -c %g /var/run/docker.sock`, then run `docker compose up -d`.
3. If the runner image was never built, or its safety check failed during the install, run `scripts/update-runner.sh` again, then choose **Start runner**.
4. Choose **Reconnect runner** to give the runner a new token and a new container. Work in progress carries on afterwards.

To see what the runner says, run `docker ps -a --filter name=boss-man-runner` and then `docker logs --tail 50 boss-man-runner-<slug>`. The settings page shows the full container name.

From: [Guide 3](/guides/first-company-and-ticket).

### The runner's log says `getaddrinfo ENOTFOUND server`.

The runner could not reach the server, usually because the server was restarting. You do not need to do anything. The runner keeps trying, waiting up to 30 seconds between tries. If it never connects, check the server is running with `docker compose ps`.

From: [Guide 3](/guides/first-company-and-ticket).

### A runner add-on says Not installed or Not working.

Check **Settings > Server and runner > Runner > Add-ons**. For Not installed, add the add-on to `RUNNER_ADDONS` in `.env`, for example `RUNNER_ADDONS=agent-browser`, then run `scripts/update-runner.sh` as root. Skills that need an add-on are left out of agents' runs until it says Working.

From: [Guide 9](/guides/add-ons).

### The runner stops with "Set BOSSMAN_RUNNER_TOKEN_FILE...".

This only happens if you run the runner without the launcher, which the guides do not do. The runner's token file is empty. Follow [`docs/06-install-truenas.md`](@repo/blob/main/docs/06-install-truenas.md), step 7, "The runner token". With the launcher (`BOSSMAN_LAUNCHER=1` in `.env`, as [Guide 2](/guides/install-boss-man) sets), Boss Man fills in the token for you.

From: [`docs/00-first-time-install.md`](@repo/blob/main/docs/00-first-time-install.md), Troubleshooting.

## Agents not starting

### My Synthetic account has top-up credit: should I untick "Weekly credit allowance" or use "I have top-up credit"?

Use **I have top-up credit**. Leave **Can trigger the hold: Weekly credit allowance** ticked. Unticking it removes the hold completely: Boss Man then never pauses that plan, and there's no notification when work starts spending top-up credit. With **I have top-up credit** you choose how far work carries on (urgent only, or all work), you're told once a week when top-up credit starts being used, and you can switch back to **Hold everything at the limit** in one step when the credit is gone. Untick the trigger only if you never want Synthetic's reading to pause anything.

From: [Guide 5](/guides/agents-and-models).

### OpenCode agents on Synthetic stop starting, and I got "Routine work paused".

The plan's weekly credits reached your hold level (95% unless you changed it). Chats, reviews and Infinite-mode agents still run, and so do urgent tickets until the limit. Routine work starts again by itself once credits come back (2% at a time). If your Synthetic account has paid top-up credit, open **Funding** and set **I have top-up credit** on the plan's card to **Keep all work running on top-up credit**. To pause later instead, raise **Hold routine work at**.

From: [Guide 5](/guides/agents-and-models).

### OpenCode agents on Synthetic fail even though Boss Man didn't pause them.

The weekly credits are used up and either the account has no top-up credit or it has run out. Boss Man can't see the top-up balance, so check it at synthetic.new. If the account has no top-up credit, set **I have top-up credit** back to **Hold everything at the limit**.

From: [Guide 5](/guides/agents-and-models).

### I gave the CEO a ticket and nothing happens.

Open **Agents** and check the agent is not paused. Then check that **Settings > Server and runner** says the runner is **Connected**. When it works, a run shows under **Runs** in the sidebar within a minute or two.

From: [Guide 3](/guides/first-company-and-ticket).

### The git token is refused.

Choose **Check the token against** your project. It tells you what your git host said:

- "The host refused the token (HTTP 401)." or "The host refused the token (HTTP 403).": the token is wrong, has expired or lacks permission. Make a new one.
- "The token can't see the repo": check the owner and name in **Git repo**, and that the token can reach that repository.
- "The token can read the repo but not push to it": give the token write permission. On GitHub that is Contents, Pull requests and Workflows set to read and write, and Checks set to read so Boss Man can read CI results. On Gitea it is repository Read and Write.

For a Gitea server on your own network, also check the Boss Man machine can reach it.

From: [Guide 3](/guides/first-company-and-ticket).

### The Claude token is refused.

Boss Man removes any spaces and line breaks from the token by itself, but it refuses a token with quote marks in it ("paste the token without quotes"). Run `claude setup-token` again and paste only the token, with no quote marks. Then choose **Check with Claude**. This needs the runner to be **Connected**, because Claude Code on the runner makes the check.

From: [Guide 3](/guides/first-company-and-ticket).

### The Model list is empty.

Choose **Refresh models**. You can also choose **Other…** and type the model name yourself.

From: [Guide 5](/guides/agents-and-models).

## Reviews and merging

### A ticket came back from the merge queue to In progress.

Boss Man's check failed before merging. The agent is told which command failed and fixes it by itself. Boss Man also sends a ticket back if it has merge conflicts, or if it changed nothing and is not marked **Doesn't need code changes**. For research, wiki or docs work, tick that box on the ticket page.

From: [Guide 4](/guides/board-and-decisions) and [Guide 7](/guides/reviews-and-merge-queue).

### Boss Man stopped a ticket and asks me what to do.

The ticket went round in circles: the same review finding came back three times, it had more than three review rounds, or the same failure happened three times in two hours. Read the card on **Decisions** and choose an option, such as **Send it back anyway** or **Stop work on it**.

From: [Guide 7](/guides/reviews-and-merge-queue).

## Notifications

### The test notification does not reach my phone.

- If you cannot see **Send a test to my phone**, save the ntfy settings first. The button shows after you save.
- Check ntfy is running with `docker compose -p boss-man-ntfy ps`.
- Check Boss Man's server is on the `edge` network that the Tailscale add-on set up. Phone notifications need Tailscale first.

From: [Guide 8](/guides/phone-notifications).

### Notifications reach my iPhone late.

This fix is only for iPhones. Android phones do not need it. iPhones need a wake-up sent through ntfy.sh. Add `NTFY_UPSTREAM_BASE_URL=https://ntfy.sh` to `.env` and run the ntfy start command from [Guide 8](/guides/phone-notifications) again. ntfy.sh only receives the message ID, not the text.

From: [Guide 8](/guides/phone-notifications).

### An urgent push didn't break through Focus.

On an iPhone, the current ntfy app may not break through a Focus, even for urgent pushes. The ntfy.sh wake-up above makes pushes arrive quickly, but it does not help them break through.

- Open **Settings → Notifications → ntfy** and turn on **Time Sensitive Notifications**. If the switch is not there, your app build cannot break through a Focus.
- Open **Settings → Focus** and add ntfy to the allowed apps of each Focus you use.
- Check the silent switch. It silences ntfy even when a push gets through.
- Turn on a Focus and choose **Send a test to my phone** to see what happens.

The full steps are in [Urgent pushes on iPhone](/guides/phone-notifications#urgent-pushes-on-iphone).

From: [Guide 8](/guides/phone-notifications).

### Some notifications never reach my phone.

Check **Notifications > How you're told**. During **Quiet hours**, pages and asks become flags, which do not go to your phone. **Per agent, per hour** turns an agent's flags and pages into notes after 6 in an hour. **To the phone** sets which levels are sent (pages and asks by default).

From: [Guide 8](/guides/phone-notifications).

## Updates and backups

### `scripts/deploy.sh` says the server is not healthy.

The script stops and prints the commands to go back. Run `scripts/deploy.sh --rollback` to put the previous code back. This does not touch the database. To see why, run `docker compose logs --tail 100 server`.

From: [Guide 10](/guides/updates-and-backups).

### The runner update seems to take a long time.

Boss Man waits for the current runs to finish, then swaps each company's runner when it is idle. Follow it under **Settings > Server and runner**, in **Updates**. If you ran `scripts/update-runner.sh` yourself, nothing moves until you choose **Update runners (finish runs first)** there. With the host deployer set up, that button is under **For a hand-built runner image**. To stop, choose **Cancel the update**. To undo a finished update, run `scripts/update-runner.sh --rollback`.

From: [Guide 10](/guides/updates-and-backups).

### Deploy latest on the web page does not apply a change.

**Deploy latest** updates the server only, never the runners. To update them, choose **Build and update runners**. The host deployer also will not apply changes to Compose files, `deploy/`, Dockerfiles, `.env` files, `.npmrc`, `.dockerignore` or the deploy scripts (`deploy.sh`, `rebuild-live.sh`, `update-runner.sh` and `host-deployer.sh`). Apply those by hand with `cd $B/src && scripts/deploy.sh`. The add-on files `deploy/penpot.yml`, `deploy/ntfy.yml` and `deploy/ntfy-bluegreen.yml` are the exception: a change to them does not stop Deploy latest, but Boss Man does not restart Penpot or ntfy either. To apply one, run that add-on's start command again ([Guide 8](/guides/phone-notifications) for ntfy, [Guide 9](/guides/add-ons) for Penpot).

From: [Guide 10](/guides/updates-and-backups).

### An update damaged my data.

If only the code is wrong, run `scripts/deploy.sh --rollback`, which keeps your data. If the data itself is damaged, follow "Restore the live database" in [Guide 10](/guides/updates-and-backups#restore-the-live-database). Test the backup first with `scripts/restore-test.sh <backup file>`. The last line must start with `OK:`.

From: [Guide 10](/guides/updates-and-backups).

### The restore says the database is "being accessed by other users".

The server is still running. Run `docker compose stop server`, then run the restore step again.

From: [Guide 10](/guides/updates-and-backups).

### The disk is filling up.

Check with `df -h $B` and `docker system df`. **Settings > Server and runner** shows the size of the runner's **Workspaces**. Each company has a disk limit, 20 GB by default. Boss Man tells you at most once a day while a company is over it. This is only a warning: nothing is stopped. To raise the limit, open **Settings > Server and runner > Workspace disk** and set **Most disk to use (GB)** higher. Boss Man also clears the workspaces of tickets that finished more than 7 days ago. Before it clears one, it keeps any uncommitted work as a patch, and the ticket's branch stays. Building runner images also uses space, so check `docker system df` before you remove anything.

From: [`docs/00-first-time-install.md`](@repo/blob/main/docs/00-first-time-install.md), Troubleshooting.

### I cannot find my backups.

They are in the install folder, `$B`, next to `src`, unless you set `BOSSMAN_BACKUP_DIR` in `.env`. The start of each file name says which script made it: `bossman-` (before each update), `rebuild-`, `restore-test-` or `penpot-`.

From: [Guide 10](/guides/updates-and-backups).

### Older backups can be read by every user on the machine.

Backups made before Boss Man locked them down may be readable by everyone, and they hold password hashes and logins. List them with:

```sh
find $B -maxdepth 1 -type f \( -name 'bossman-*.sql.gz' -o -name 'rebuild-*.sql.gz' -o -name 'restore-test-*.sql.gz' -o -name 'penpot-*.tar' \) -perm /077 -print
```

Lock them down by running the same command with `-exec chmod 600 {} +` in place of `-print`. Then run the first command again: it should print nothing. If you set `BOSSMAN_BACKUP_DIR`, use that folder in place of `$B`.

From: [`docs/00-first-time-install.md`](@repo/blob/main/docs/00-first-time-install.md), Troubleshooting.

## Add-ons

### I cannot make a Penpot account.

Sign-up is off. Add `PENPOT_REGISTRATION=enable` to `.env`, start Penpot again with the command in [Guide 9](/guides/add-ons), and make the accounts. Then delete the line and start Penpot again, so nobody else can sign up.

From: [Guide 9](/guides/add-ons).
