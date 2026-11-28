---
title: Install a release by hand (older image installs)
description: Your Updates page says "This server was made before the Install button existed". These steps install the new release from the machine's command line, once. After that the Install button works.
group: Set it up your way
order: 12
lead: If you installed Boss Man from the ready-made images before the Install button existed, your first update is done by hand on the machine. You do this once. The server it makes has the button, so later updates are one click.
---

**Not yet confirmed.** These steps are written from the install files and the updater's code. They have not yet been run on a real install. Do them on a quiet day, when no agent is working.

## Is this for you

Follow this guide only if both are true:

- You installed Boss Man from the ready-made images (`docker-compose.images.yml` and `images.env`), for example 0.1.0-beta.3.
- **Settings → Server and runner → Updates** names a new version and says "This server was made before the Install button existed".

If the Updates page shows an **Install** button instead, use it: see [How updates work](/guides/how-updates-work#on-an-image-install). If you built Boss Man from the source code, see [Updating and backups](/guides/updates-and-backups).

## Why it can't be done from the page

On an image install a small helper called the **updater** installs new versions. It backs up the database, starts the new server beside the old one and switches over. A server made before the Install button has no link to the updater, so the button can't ask it. You ask the updater yourself instead, with one command on the machine.

Downloading the new files and running the start command again is not enough on its own. It updates the updater, but the server stays on the old version until the updater is asked to move it.

## What you need

- A terminal on the machine that runs Boss Man, as a user who can run `docker`.
- The folder with your `docker-compose.images.yml` and `images.env`. The commands below are run in that folder.
- The new release's version number, from the Updates page or the [releases page](@repo/releases). The examples use 0.2.0.
- About 30 minutes, most of it waiting.

The commands are for a Linux shell. On Docker Desktop for macOS they work in Terminal. On Windows, run them in WSL.

## 1. Keep a copy of your current files

```sh Run in your Boss Man folder
cp images.env images.env.old
cp docker-compose.images.yml docker-compose.images.yml.old
```

**Success:** `ls` shows both `.old` files. You use them only if you need to go back (see [If something goes wrong](#if-something-goes-wrong)).

## 2. Download the new release's two files

Open the [releases page](@repo/releases), find the new version (for example `v0.2.0`), and download these two files into your Boss Man folder, replacing the old ones:

- `docker-compose.images.yml`
- `images.env`

Do not edit the digests in the new `images.env`. To check the files' signatures first, follow [Get the files](/guides/install-boss-man#1-get-the-files) in the install guide.

**Then copy your own settings across.** If you added lines to your old `images.env`, such as `BOSSMAN_BIND` or `BOSSMAN_INSECURE_COOKIES`, add them to the new one. To see the differences:

```sh Run in your Boss Man folder
diff images.env.old images.env
```

Lines starting with `<` are only in your old file. Copy each one that is your own setting into the new `images.env`. Leave out `BOSSMAN_VERSION` and the `_DIGEST` lines: the new file has its own. Write each value without quotes (`BOSSMAN_BIND=0.0.0.0`, not `BOSSMAN_BIND="0.0.0.0"`): step 4 reads the file as it is, so quotes would be sent as part of the value.

**Success:** `grep BOSSMAN_VERSION images.env` shows the new version, for example `BOSSMAN_VERSION=0.2.0`.

## 3. Start the new updater

```sh Run in your Boss Man folder
docker compose --env-file images.env -f docker-compose.images.yml up -d
```

Docker downloads the new updater and starts it. Your server keeps running on the old version, and the pages keep working. If the new release adds a service, such as the daily backup, it starts too.

**Success:** after a minute, this shows a line ending in "running release" and your **old** version number:

```sh Run in your Boss Man folder
docker logs --tail 20 updater
```

The old number is expected: the updater counts from the server that is running now.

The commands in steps 3 to 5 use the container name `updater`, which the install file sets today. If `docker logs updater` says "No such container", run `docker ps` and use the name in the list that ends in `updater` instead.

## 4. Ask the updater to install the release

This command runs inside the updater. It reads the new version and server digest from your new `images.env`, reads the updater's key from the updater's own folder, and sends the install request. The key never appears on the screen or on the command line.

```sh Run in your Boss Man folder (copy all of it)
docker exec -i -u 1000 updater node -e '
const fs = require("fs");
const env = Object.fromEntries(fs.readFileSync(0, "utf8").split("\n").filter((l) => /^BOSSMAN_[A-Z_]+=/.test(l)).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1).trim()]));
const key = fs.readFileSync("/run/updater/key", "utf8").trim();
fetch("http://127.0.0.1:3106/move", { method: "POST", headers: { authorization: "Bearer " + key, "content-type": "application/json" }, body: JSON.stringify({ version: env.BOSSMAN_VERSION, serverDigest: env.BOSSMAN_SERVER_DIGEST }) }).then(async (r) => console.log(r.status, await r.text()));
' < images.env
```

**Success:** the answer starts with `202` and contains `"accepted":true`. The install now runs by itself, as if you had pressed the Install button: the updater checks the release's signature, downloads it, backs up the database, starts the new server beside the old one and switches over. You can close the terminal.

The answers you might see instead:

- `400` with a message: the new `images.env` is missing `BOSSMAN_VERSION` or `BOSSMAN_SERVER_DIGEST`, or one was edited. Download it again (step 2).
- `401`: the command did not read the key. Check that you copied the whole command, including `-u 1000`.
- `409` with "busy": an install is already running. Wait for it (step 5).
- "No such container: updater": step 3 did not start the updater. Run `docker compose --env-file images.env -f docker-compose.images.yml ps` and read `docker logs updater`.

## 5. Watch it finish

The Updates page shows each step, such as "Backing up the database". The new server then has a 15-minute trial, and switches back to the old one by itself if anything fails. To follow it from the terminal instead:

```sh Run in your Boss Man folder (shows where the install is)
docker exec -u 1000 updater node -e '
const key = require("fs").readFileSync("/run/updater/key", "utf8").trim();
fetch("http://127.0.0.1:3106/status", { headers: { authorization: "Bearer " + key } }).then(async (r) => console.log(r.status, await r.text()));
'
```

The `stage` value moves through steps such as `pulling`, `backing-up`, `starting-colour` and `soaking`. It ends at `done` ("Updated to 0.2.0"), or at `rolled-back` or `failed` with the reason.

**Success:** **Settings → Server and runner → Updates** says the server is on the new version. Choose **Got it** to clear the message. From now on the page offers an **Install** button for each new release.

## If something goes wrong

- **It went back by itself** (`rolled-back`, or "went back" on the Updates page). Your server is on the old version and your data is unchanged. Tell the CEO in chat and give them the reason shown.
- **It failed before switching** (`failed`). Nothing live changed. Read the reason. A download failure can be retried by running step 4 again.
- **The updater does not start after step 3.** Put your old files back and start again:

  ```sh Run in your Boss Man folder
  cp images.env.old images.env
  cp docker-compose.images.yml.old docker-compose.images.yml
  docker compose --env-file images.env -f docker-compose.images.yml up -d
  ```

  Then tell the CEO in chat what `docker logs updater` says.

Never run `docker compose down -v`: `-v` deletes the volumes that hold your database and keys.

## Related

- [How updates work](/guides/how-updates-work): what an update changes, and the Install button.
- [Updating and backups](/guides/updates-and-backups): where backups are kept, and how to restore one.
- [Install Boss Man](/guides/install-boss-man): the image install from the start.
