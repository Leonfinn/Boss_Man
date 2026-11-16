# 31 — Phone notifications

This page is for owners who want Boss Man's pages and asks on their phone, with Approve buttons. It works on any Linux host that runs Docker: plain Linux, a VM (such as a Proxmox VM) or TrueNAS SCALE.

Boss Man sends them through your own [ntfy](https://github.com/binwiederhier/ntfy) server, which runs on the same host from `deploy/ntfy.yml`. Your phone reaches it over your Tailscale network (your **tailnet**). Boss Man only makes outbound requests to it. Nothing is opened at the router and nothing is exposed on your home network.

It is optional. Without it, Boss Man's **Notifications** page still shows everything.

## What you need first

- Boss Man installed ([docs/00-first-time-install.md](00-first-time-install.md)).
- **HTTPS through Tailscale Serve set up first,** as [docs/20-https-tailscale.md](20-https-tailscale.md) describes. This page builds on it and doesn't work without it.
- The ntfy app on your phone, and the phone on your tailnet.
- A root shell on the host, in the repo folder (`<install-dir>/src`). Run every `docker compose` command from there.

How ntfy is set up (all in `deploy/ntfy.yml`):
- **Off by default,** as its own Compose project. A normal `docker compose up -d` never starts it.
- **Tailnet and https only.** No port is opened on the host. ntfy joins the private `edge` network of the Tailscale container, and that container publishes it to your tailnet over https on port 8443. Boss Man's own address stays on 443. Funnel stays off.
- **Deny-all access.** Nobody can publish or read without a user. There is no sign-up and no web page.
- **Short memory.** Messages are kept for 1 hour (`NTFY_CACHE_DURATION`), then dropped.
- **No relay.** No upstream server is set, so nothing leaves your network (iPhones are the exception, see below).

Treat the topic name and the passwords as secrets: notifications carry Approve links. Don't paste them into tickets, chat or the repository.

## Steps

1. **Nothing to make by hand: the data folder.** It goes in your Boss Man data folder (`BOSSMAN_DATA` in `.env`; `<install-dir>/data` if you followed the install guide), so your usual backup and move steps already cover it. A one-off `ntfy-init` step in `deploy/ntfy.yml` creates it and hands it to ntfy's user (ID 1000) each time ntfy starts, on any Docker host, so there is no `mkdir` or `chown` to run. (Only if you set `NTFY_DATA` to a folder on a share that refuses ownership changes, make that folder writable by user ID 1000 yourself.)
   It holds the users, tokens and cache. Keep it in your backup: restoring it on a new host keeps the tokens and the phone subscription working.

2. **Add one line to `.env`.** Back up `.env` first. The address is the same ts.net name as your Tailscale Serve address, with port 8443:
   ```
   NTFY_BASE_URL=https://<host-name>.<tailnet>.ts.net:8443
   ```
   Nothing else is needed. ntfy finds the `edge` network by its default name (`boss-man_edge`). Only if you changed the Compose project name, or want a different data folder, set `NTFY_EDGE_NETWORK` (the network's name, which `docker network ls` lists; it ends in `_edge`) or `NTFY_DATA`.

3. **Start it.** Tailscale Serve already publishes port 8443 (it is in `deploy/tailscale/serve.json`). Start ntfy:
   ```sh
   docker compose -p boss-man-ntfy --env-file .env -f deploy/ntfy.yml --profile ntfy up -d
   ```
   Check what Tailscale publishes. Use the Tailscale container's name from `docker ps`:
   ```sh
   docker exec <tailscale-container> tailscale serve status
   ```
   It should list `https://<host-name>.<tailnet>.ts.net:8443` as **tailnet only** and must not mention Funnel. If it mentions Funnel, stop and run the rollback below.

4. **Set ntfy up from Boss Man.** Open **Notifications** in the side menu and choose **Set up ntfy for me** under **How you're told** (it needs `openssl` on the host, and the page says if that or the add-on is missing). Within a minute it makes the `bossman-publish` user, gives it write-only access to your topic, makes its **publish token**, and saves the token encrypted as "ntfy access token". If you have not chosen a topic it picks 20 random letters and digits (the topic is a password, so keep it out of tickets and chat) and fills in **ntfy server** as `http://ntfy:80` (Boss Man and ntfy share the private `edge` network, so no tailnet name is needed). The token is never shown, so there is nothing to copy. Pressing the button again finds all three and changes nothing, so it is safe after an update or a move to a new host.

5. **Check and save the rest.** In the same **How you're told** box:
   - **Boss Man's address on your phone, so a tap opens the evidence:** Boss Man's https Tailscale address.
   - Choose **Save**.
   - Prefer a topic or server address of your own? Type them before you press the button (and Save): the button keeps what you chose.

   Then the **Create phone login** button under **Set up your phone** makes the `phone-read` user and its read-only access for you and shows the password once (it needs `openssl` on the host; the page says if it is missing). If you try the button after making the user by hand, it says the user exists and offers **Reset password**.

6. **Set up the phone.** In the ntfy app, choose **Use another server** and enter exactly the `NTFY_BASE_URL` value from step 2, with its port. Log in as `phone-read` with its password and subscribe to your topic. **Do not use Boss Man's own address** (the same name without `:8443`): it opens Boss Man, not ntfy, and the app cannot subscribe there. The **Notifications** page shows the right address under **Set up your phone**, with a link to check from the phone's browser: `<ntfy address>/v1/health` should show `{"healthy":true}`. If it does not load, the phone is not on your tailnet.

7. **Send a test.** On the **Notifications** page, choose **Send a test to my phone** (it only appears after you Save). It should arrive within seconds. A test that says "accepted" only proves Boss Man reached ntfy, not that the phone is subscribed at the right address.

**Check it is locked down.** Both commands must print `401` or `403` (the first tries to read, the second to publish, with no login):
```sh
curl -s -o /dev/null -w '%{http_code}\n' https://<host-name>.<tailnet>.ts.net:8443/<topic>/json?poll=1
```
```sh
curl -s -o /dev/null -w '%{http_code}\n' -d probe https://<host-name>.<tailnet>.ts.net:8443/<topic>
```
From a device that is not on your tailnet the address must not answer at all.

## If the test fails

- **Send a test fails:** check that ntfy is running (`docker compose -p boss-man-ntfy ps`) and that the server is on the `edge` network.
- **The phone gets nothing but the test was accepted:** the phone is subscribed at the wrong address (often Boss Man's own, without `:8443`), or to another topic. Check step 6.

## iPhone

iPhones only get instant delivery from a self-hosted server if the server forwards a wake-up through ntfy.sh. If you use an iPhone, add `NTFY_UPSTREAM_BASE_URL=https://ntfy.sh` to `.env` and run step 3's `docker compose` command again. ntfy sends ntfy.sh only a poll request containing the message ID, never the title, text or buttons ([iOS instant notifications](https://docs.ntfy.sh/config/#ios-instant-notifications)). Android doesn't need this: leave it unset.

## After you restart ntfy (Android)

The Android app does not use Google's push service with a self-hosted server. It keeps its own long connection open to your ntfy address (the "Listening for instant notifications" entry in the notification shade) and only fetches by hand when you open it. Restarting ntfy (an update, or adding `deploy/ntfy-bluegreen.yml`) most likely cuts that connection. If the app does not reconnect by itself, messages wait on the server and show only when you open the app, even though Boss Man reports the push as accepted. This happened on 14 Nov (BOS-1481): fully closing and reopening the app fixed it. That is the only evidence so far. The ntfy server log from that restart was not read, so the cause is not proven; the `deploy/ntfy-bluegreen.yml` file does not change the route from the phone to ntfy. An automatic check is planned in a follow-up (BOS-1481 comments).

The step is the same however ntfy was restarted (the deployer, the blue/green switch, or by hand). An iPhone that uses `NTFY_UPSTREAM_BASE_URL` is woken through ntfy.sh instead, so it should not need it, but the test in step 2 is worth sending there too.

After every ntfy restart:
1. On the phone, open the ntfy app, then swipe it away from recent apps and open it again.
2. In Boss Man, open Notifications and choose **Send a test to my phone**, with the app closed and the screen off. It should pop up without you opening the app.
3. If it only appears when you open the app: in the app's Settings turn on "Instant delivery in doze mode", turn on "Instant delivery" on that subscription, and in Android Settings → Apps → ntfy → Battery choose "Unrestricted".

## Approve buttons

The buttons make your phone call Boss Man directly, over Boss Man's https address on your tailnet. The Approve button only turns on when all of these hold:
- the ntfy server has a publish token;
- the **ntfy server** address is `https://...` or exactly the bundled `http://ntfy:80` (any other `http://` address is refused, so the token never crosses an untrusted network in clear text);
- Boss Man's public URL is https;
- **Approve buttons** haven't been switched off in Notifications.

If one fails, Notifications says which.

## Blue/green installs

With blue/green the two Boss Man copies are not on the `edge` network, so they can't reach `http://ntfy:80`. Add `-f deploy/ntfy-bluegreen.yml` after `-f deploy/ntfy.yml` in step 3's `docker compose` command, and in the rollback command. It also puts ntfy on the internal `front` network, under the same name `ntfy`, so the settings in step 5 stay as they are. Use the same two `-f` files every time you start, stop or change ntfy.

## Per host

ntfy rides on the Tailscale container, which runs in Tailscale's userspace mode and needs no `/dev/net/tun`, so the steps are the same on every Docker host. Host differences for Tailscale itself are in [docs/20-https-tailscale.md](20-https-tailscale.md).

- **TrueNAS SCALE:** use the data folder under your dataset, for example `/mnt/tank/apps/boss-man/data/ntfy` in the worked example of [docs/06](06-install-truenas.md).
- **Proxmox:** use a VM ([docs/32-proxmox.md](32-proxmox.md)). Inside the VM, the steps are as written.
- **Moving to a new host:** copy the data folder (it includes `ntfy` and `tailscale`), bring up Tailscale Serve, then run step 3 again. Users, tokens and the phone subscription carry over.

## Rolling back

```sh
docker compose -p boss-man-ntfy --env-file .env -f deploy/ntfy.yml --profile ntfy down
```

Port 8443 then answers with an error until you start it again. That is harmless. Do not edit `deploy/tailscale/serve.json` to remove it: it is part of the checkout, and a changed file makes `scripts/deploy.sh` refuse to run. Messages are only kept for an hour and are not worth restoring. The users and tokens live in `user.db` in the ntfy data folder; copy that file first if you want to keep them.

## Related pages

- [docs/20-https-tailscale.md](20-https-tailscale.md): HTTPS through Tailscale Serve (needed first).
- [docs/29-tune-and-troubleshoot.md](29-tune-and-troubleshoot.md): tuning and troubleshooting.
