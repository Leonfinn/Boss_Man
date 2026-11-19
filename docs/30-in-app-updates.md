# 30 — Update from the web page (the host deployer)

This page is for owners who want to update Boss Man from its own web page, rather than by typing `scripts/deploy.sh` on the host. It works on any Linux host that runs Docker. A short section at the end covers TrueNAS SCALE.

Once it is set up, Boss Man asks "Deploy <commit>?" on **Decisions** when `main` moves. You approve it, and a root script on the host (the **host deployer**) runs `scripts/deploy.sh` for you. **Settings → Server and runner → Updates** shows the same offer (**Review and deploy**, or **Check for updates now** when there is none), and gains **Build and update runners** and **Restart the server**.

It is optional. Without it you update by hand, as [docs/23-updating.md](23-updating.md) says. How it works and what it refuses is in [docs/09-self-deploy.md](09-self-deploy.md). Nothing here gives a container the Docker socket: the server only drops request files in a folder, and the host script decides.

## What you need first

- Boss Man installed with [docs/00-first-time-install.md](00-first-time-install.md), with the layout it uses: the code in `<install-dir>/src` and the deployer in `<install-dir>/deployer`.
- A **root shell** on the host. On a normal Linux host, run the commands as root (`sudo -i`). On TrueNAS, use System > Shell or `su -` over SSH.
- On the host: `bash`, `git`, `docker`, `flock` and `curl`, and a way to run a command every minute (cron or a systemd timer).
- **`main` protected on your git host,** so agents can only land reviewed pull requests. On GitHub: the repo's Settings > Branches > add a rule for `main` that requires a pull request. The deployer treats the tip of `main` as approved code.
- The `src` checkout on `main`, clean, and able to read the remote (https for a public repo, the deploy key for a private one).

## The short way: one script

As root, in the checkout (`<install-dir>/src`), after step 1 below:

```sh
scripts/setup-host-deployer.sh
```

It does steps 2, 3, 6 (the `.env` lines) and 7 for you: the folders with the right owners and modes, the script copy, `BOSSMAN_DEPLOYER` and `COMPOSE_FILE` in `.env` (a dated backup of `.env` first), and a one-minute timer (systemd timer, or `/etc/cron.d`; on TrueNAS it prints the Cron Jobs form values). It ends with a trial run of the deployer and tells you the one command that restarts the server so it sees the folders (add `--recreate-server` to run it). A second run changes nothing, so it is safe to repeat. `--dry-run` shows what it would do, `--dir` names an install folder other than the one above the checkout, `--timer cron|systemd|none` picks the timer. Step 4 (the webhook) and step 5 (testing) stay as written, and nothing in the script writes a secret. Later copies of a changed script are made by `scripts/install-deployer.sh` (the same step a hand deploy runs, and the "deployer script is behind" card shows it); this script hands the refresh to it. The steps below are what the script does, for anyone who prefers to do them by hand or wants to check its work.

Set two shell variables first. Replace the install folder if yours differs. If you open a new shell, set them again.

```sh
B=/opt/boss-man
```

```sh
D=$B/deployer
```

Check that the host sees the tip of `main`:

```sh
git -C $B/src ls-remote origin refs/heads/main
```

It should print one line: a hash and `refs/heads/main`.

## 1. Bring the code up to date by hand

The deployer refuses to deploy changes to `scripts/` and `deploy/`, so the first update is yours:

```sh
cd $B/src && scripts/deploy.sh
```

Nothing changes for Boss Man yet. The deployer is switched on in step 6.

## 2. Make the folders

The server (user ID 1000) may write only `inbox`. It reads `outbox`.

```sh
mkdir -p $D/inbox $D/outbox $D/state
```

```sh
chown root:root $D $D/outbox $D/state && chmod 755 $D $D/outbox && chmod 700 $D/state
```

```sh
chown 1000:1000 $D/inbox && chmod 750 $D/inbox
```

Check it worked:

```sh
ls -ldn $D $D/inbox $D/outbox $D/state
```

`inbox` should show owner `1000`, and the other three owner `0` (root).

## 3. Install the script as a copy

Read it first (`less $B/src/scripts/host-deployer.sh`). Copy it. Do not link to the file in the checkout: a link would let a merged pull request change what root runs.

```sh
cp $B/src/scripts/host-deployer.sh $D/host-deployer.sh && chown root:root $D/host-deployer.sh && chmod 750 $D/host-deployer.sh
```

A change to `scripts/host-deployer.sh` is refused by the panel (it is what root runs). Apply it by hand with `scripts/deploy.sh` as the card shows; that deploy runs `scripts/install-deployer.sh`, which replaces this copy by itself (atomically; the new version runs from the next minute), so no separate copy step is needed. [docs/23-updating.md, step 3](23-updating.md#3-the-deployer-script-copies-itself) says when a hand copy is still needed.

## 4. Add an alert webhook (optional)

Skip this step if you want no alerts outside Boss Man. The webhook lives only on the host, so it still works when Boss Man is down. Any service that accepts a JSON `POST` works.

Create `$D/host.conf` with your editor, with these two lines. Keep the single quotes (a URL can contain `?` and `&`):

```sh
WEBHOOK_URL='https://webhook.example.com/your-path'
WEBHOOK_ON_SUCCESS=1
```

Then lock it down. The script refuses to start if this file is not owned by root with mode 600:

```sh
chown root:root $D/host.conf && chmod 600 $D/host.conf
```

- `WEBHOOK_ON_SUCCESS=1` also posts when a deploy works. `0` (the default) posts only failures (`failed`, `partial`, `rolled_back`, `rejected`).
- Other optional lines: `REPO=` (the checkout; default `$D/../src`) and `RATE_LIMIT_SECONDS=600`. The full list is at the top of `scripts/host-deployer.sh`.
- The body looks like `{"result":"failed","message":"...","from_commit":"...","to_commit":"...","at":"2026-10-20T12:03:00Z"}`. ntfy needs a `topic` field this body does not have, so it would need a small relay in between. That is untested.

Test the webhook:

```sh
. $D/host.conf && curl -fsS -X POST -H 'Content-Type: application/json' -d '{"result":"failed","message":"Test from the host","from_commit":"aaaaaaaa","to_commit":"bbbbbbbb","at":"2026-10-20T12:00:00Z"}' "$WEBHOOK_URL" && echo sent
```

`sent` only means the service accepted the request. Check that the alert really arrives.

## 5. Test the script

First with no request. It reads `main` and writes what is waiting:

```sh
$D/host-deployer.sh && cat $D/outbox/available.json
```

You should see a short block of JSON.

Optional: rehearse a request without running anything. `--dry-run` runs every check and changes nothing. Skip to step 6 if you would rather see the first real update in step 8:

```sh
TIP=$(git -C $B/src ls-remote origin refs/heads/main | cut -f1)
```

```sh
printf '{"id":"00000000-0000-4000-8000-000000000001","target":"server","commit":"%s","requestedAt":"2026-10-20T12:00:00Z","approvedBy":"me"}\n' "$TIP" > $D/inbox/request.json
```

```sh
$D/host-deployer.sh --dry-run
```

```sh
rm -f $D/inbox/request.json
```

You should see either `nothing_new: Nothing new: ... already deployed` (you are up to date) or `[dry-run] checks passed: would run: scripts/deploy.sh --yes --no-runner --commit ...`. A `rejected:` line says why.

## 6. Let the server see the folders

This adds one compose file, `deploy/truenas-deployer.yml`. Despite its name it works on any host: it only mounts the two folders into the server.

Open `$B/src/.env` in your editor and make two changes:

1. Check there is a line `BOSSMAN_DEPLOYER=` with your deployer folder (for example `BOSSMAN_DEPLOYER=/opt/boss-man/deployer`). The install guide's `.env` already has it.
2. Add the compose file to `COMPOSE_FILE`:
   - If there is no `COMPOSE_FILE` line, add `COMPOSE_FILE=docker-compose.yml:deploy/truenas-deployer.yml`.
   - If there is one (TrueNAS, Tailscale), add `:deploy/truenas-deployer.yml` to the end of it.

Check the two lines:

```sh
grep -E '^(COMPOSE_FILE|BOSSMAN_DEPLOYER)=' $B/src/.env
```

Recreate the server and check it sees the folders:

```sh
cd $B/src && docker compose up -d server
```

```sh
cd $B/src && docker compose exec server ls /run/deployer
```

The last command should list `inbox` and `outbox`. Reload Boss Man: **Settings → Server and runner** now has an **Updates** section.

## 7. Run the script every minute

The script must run as root once a minute. Every minute matters: an hourly job makes an approved deploy wait up to an hour. The script keeps its own log, so hide its normal output but keep its errors.

**On a host with cron** (most Linux distributions; check with `command -v crontab`), create the file `/etc/cron.d/boss-man-deployer` with your editor, with this one line. Use your own deployer folder:

```
* * * * * root /opt/boss-man/deployer/host-deployer.sh > /dev/null
```

Cron reads files in `/etc/cron.d` by itself. The file must belong to root and must not be writable by others (`chmod 644`). The user field (`root`) is part of this file format. Not tested by the project on every distribution: check after a few minutes, as below.

**On a host without cron,** use a systemd timer that runs the same command every minute (check with `systemctl --version`). `scripts/setup-host-deployer.sh --timer systemd` writes `boss-man-deployer.service` and `.timer` for you.

**On TrueNAS,** use its web page instead: see "TrueNAS SCALE" below.

Check it worked: a few minutes later, `$D/outbox/available.json` has a newer `checkedAt`:

```sh
grep -o '"checkedAt": *"[^"]*"' $D/outbox/available.json
```

The log is `$D/deployer.log`.

## 8. Try it

When `main` is ahead, a "Deploy abc1234?" decision appears, with a notification. **Settings → Server and runner → Updates → Check for updates now** asks the host to look at once. Approve it (on Decisions, or **Review and deploy** on Updates). Within a minute the host starts the update, Boss Man restarts for a minute or two, and when it is back you get a notification and **Updates** shows the result. Watch it on the host with `tail -f $D/deployer.log`.

A server deploy updates the server only. When an update changes the runners' code, a second decision "Update the runners?" appears after the server is deployed. Approving it builds the new runner image, then drains: runs in progress finish and each runner is swapped when its company is idle. Anything under `packages/shared/` counts as runner code, even text the runner never reads; when the change is only that, **Not now** is fine.

## What you may see instead of a deploy

- **"Rejected: this change touches deployment files"**: run `scripts/deploy.sh` yourself in `$B/src`. The deployer refuses changes to files such as `scripts/`, `deploy/`, compose files and Dockerfiles.
- **"Rejected: only one server deploy every 10 minutes"**: wait, then press **Try again** on Updates.
- **`main` moved after you approved:** nothing to do. The approval deploys the newest checked commit on `main`. Only if `main` was rewritten so the approved commit is gone do you see "is not on main any more"; a new question for `main` follows within a few minutes.
- **A to-do about deployment files you have already applied by hand**: it was written before you did. Answer **Done, it's applied**. It also closes by itself once the host reports the new commit running.
- **Updates stuck behind an infra change.** The deployer offers only the tip of `main`. While an unapplied infra change is in that range, every later update waits behind it until you apply it by hand. Merge infra changes on their own, after the app changes before them are deployed.
- **The update waits for free memory.** The deployer holds a request while the host is short of memory and tries again each minute. [docs/09-self-deploy.md](09-self-deploy.md#the-hosts-memory-floor-scriptshost-deployersh) explains the numbers.

## Turn it off

Remove the cron line (or disable the timer or TrueNAS cron job), or remove `:deploy/truenas-deployer.yml` from `COMPOSE_FILE` and run `docker compose up -d server`.

## TrueNAS SCALE

The steps are the same, with these differences:
- Use the TrueNAS paths. In the worked example of [docs/06](06-install-truenas.md) the install folder is `/mnt/tank/apps/boss-man`, so set `B=/mnt/tank/apps/boss-man`.
- `ls -l` may show `inbox` as owned by another name, such as an app user: TrueNAS shows user ID 1000 by the name of whichever app user has it. What matters is the number (`ls -ldn`).
- `COMPOSE_FILE` already exists (`docker-compose.yml:deploy/truenas.yml`), so step 6 adds `:deploy/truenas-deployer.yml` to its end.
- Step 7 is a cron job in the TrueNAS web page: **System > Advanced > Cron Jobs > Add** (field names as of 25.10, unverified on other versions):
  - **Description:** `Boss Man host deployer`
  - **Command:** the full path of your copy, for example `/mnt/tank/apps/boss-man/deployer/host-deployer.sh`
  - **Run As User:** `root`
  - **Schedule:** choose **Custom** and put `*` in every field (Minutes, Hours, Days of month, Months, Days of week). The **Hourly** preset is not enough.
  - **Hide Standard Output:** ticked. Leave **Hide Standard Error** unticked.
  - **Enabled:** ticked.

## Blue/green

Blue/green swaps the server without downtime and builds on this page. It needs Docker Compose 2.24 or newer. The steps are in [docs/06, 9d](06-install-truenas.md#9d-switch-to-bluegreen-optional).

## Related pages

- [docs/23-updating.md](23-updating.md): read before you update.
- [docs/09-self-deploy.md](09-self-deploy.md): how the deployer, the runner drain and blue/green work.
- [docs/29-tune-and-troubleshoot.md](29-tune-and-troubleshoot.md): tuning and troubleshooting.
