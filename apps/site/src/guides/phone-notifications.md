---
title: Phone notifications
description: How Boss Man tells you about things, and how to send the urgent ones to your phone through your own ntfy server.
group: Everyday use
order: 8
lead: Boss Man tells you about things at four levels. You can have the urgent ones sent to your phone through your own ntfy server. ntfy is a free, open-source notification service.
---

**Image install or build-from-source?** The levels, browser notifications, quiet hours and the choice of which cards reach your phone are settings in Boss Man, and work on both installs. Sending to your phone needs your own ntfy server, reached over Tailscale. The steps differ by install. On an image install (your folder holds `images.env` and `docker-compose.images.yml`), follow [On an image install](#on-an-image-install). On a build-from-source install, follow [Send notifications to your phone](#send-notifications-to-your-phone).

## Notification levels

![How Boss Man tells you: four levels, from a note in the Notifications page, to a flag as a browser notification, to a page and an ask that also reach your phone.](/img/how-youre-told.svg =1160x800 narrow=/img/how-youre-told-narrow.svg:360x1330 "The four levels and the three places they can show up.")

- **Note**: shown in the Notifications page only
- **Flag**: also shown as a browser notification
- **Page**: also sent to your phone
- **Ask**: needs your answer. It goes to your phone only when it is urgent, unless you choose to send all decisions (see below)

You get a page when, for example, a runner goes offline or a runner update is stuck. Cards on Decisions that need your answer arrive as asks.

## Browser notifications

Choose **Turn on browser notifications** at the top of the Notifications page. They show while Boss Man is open in a browser tab, including a background tab.

## Quiet hours and limits

Open **Notifications** in the sidebar and find **How you're told**.

- Tick **Quiet hours** and set **From**, **Until** and **Time zone**. During quiet hours, pages and asks become flags, and flags become notes.
- **Per agent, per hour** caps how many flags and pages one agent can send in an hour. The rest become notes. The default is 6.

## Send notifications to your phone

Build-from-source install only. You need Tailscale set up first (see [Add-ons](/guides/add-ons)), because your phone reaches ntfy over your tailnet. The full steps are in [`docs/31-phone-notifications.md`](@repo/blob/main/docs/31-phone-notifications.md), and work on any Linux host.

1. Add `NTFY_BASE_URL=https://<host-name>.<tailnet>.ts.net:8443` to `.env`.
2. Start ntfy as its own Compose project with `docker compose -p boss-man-ntfy --env-file .env -f deploy/ntfy.yml --profile ntfy up -d`.
3. In Boss Man, open **Notifications**. Under **How you're told**, choose **Set up ntfy for me**. Within a minute it makes the publish user and its token, saves the token encrypted, and fills in the **ntfy server** and a **Topic** if you have not chosen them. If you type your own topic, use only letters, digits, `-` and `_`, up to 64 characters. Boss Man refuses any other topic and leaves the saved token as it was.
4. Set **Boss Man's address on your phone, so a tap opens the evidence** to Boss Man's Tailscale address, and choose **Save**.
5. Under **Set up your phone**, choose **Create phone login** and copy the password. It is shown only once.
6. On your phone, install the ntfy app. Add the exact `NTFY_BASE_URL` address from step 1, including `:8443`. Do not use Boss Man's own address. Log in as the phone user with that password, and subscribe to your topic.
7. Choose **Send a test to my phone**. It appears after you save. The test should arrive within seconds.

## On an image install

Not yet confirmed on a real host (28 Nov 2026). The file passes Docker Compose's own check, but nobody has run these steps with a phone yet.

ntfy comes as one more release file, `docker-compose.ntfy.images.yml`. It runs as its own Compose project, `boss-man-ntfy`, with its own Tailscale device, `boss-man-ntfy`. That device publishes only ntfy, not Boss Man's page. Boss Man updates never touch it. The two **Set up for me** buttons on the Notifications page do not work here, so you make the ntfy users with commands and type the values in yourself.

You need:

- a release that has the file. It was added on 28 Nov 2026. If your release's page on GitHub does not list `docker-compose.ntfy.images.yml`, update Boss Man first.
- Docker Compose 2.23 or newer (`docker compose version` shows yours).
- HTTPS Certificates turned on in the Tailscale admin console (DNS tab), and a one-time auth key (Settings → Keys).

The steps, with every command in full, are in [`docs/31-phone-notifications.md`, "Image install"](@repo/blob/main/docs/31-phone-notifications.md#image-install-no-source-folder). Run them in the folder with `images.env`. In short:

1. Download `docker-compose.ntfy.images.yml` from the release you installed.
2. Add `NTFY_BASE_URL=https://boss-man-ntfy.<tailnet>.ts.net:8443` and `TS_AUTHKEY=<one-time key>` to `images.env`.
3. Start it with `docker compose -p boss-man-ntfy --env-file images.env -f docker-compose.ntfy.images.yml --profile ntfy up -d`. Then delete the `TS_AUTHKEY` line. **It worked if** the same command with `ps` in place of `up -d` shows `ntfy` and `tailscale` as `healthy` within a minute.
4. Make a publish user for Boss Man and a read-only user for your phone, give them your topic, and make Boss Man's token.
5. In Boss Man, open **Notifications**. Under **How you're told**, set **ntfy server** to `http://ntfy:80`, then fill in your **Topic**, the **Access token** and **Boss Man's address on your phone**, and choose **Save**.
6. On your phone, add your `NTFY_BASE_URL` address in the ntfy app, log in as the phone user and subscribe to your topic. Then choose **Send a test to my phone**.

Later on:

- **After a reboot** it starts by itself.
- **After a Boss Man update** you need to do nothing. If the release notes say the ntfy file changed, download the new one and run the start command again. Your users and the Tailscale login are kept.
- **To stop it**, run the start command with `down` in place of `up -d`. Never add `-v`: that deletes the users and the Tailscale login.
- **Back up** the volumes `boss-man-ntfy_ntfy-data` and `boss-man-ntfy_tailscale-state` with your other backups.

## Which cards reach your phone

Under **Send to my phone**, choose **Urgent only (default)** or **All decisions**.

- **Urgent only** sends a deploy that carries the fix for a live problem, Priority 1 work that has merged and is ready to go live, a page such as "server unusable", a card the CEO has marked urgent because you must act now, and the test button. A card that merely holds up a ticket (plans, merge sign-offs, after-merge checks) does not push, and a card still with the CEO never does. Urgent pushes go at the top priority (5). On Android, it breaks through Do Not Disturb only after you turn on one switch in the ntfy app: see [Urgent pushes on Android](#urgent-pushes-on-android). On an iPhone, you cannot rely on it to break through a Focus with the current ntfy app: see [Urgent pushes on iPhone](#urgent-pushes-on-iphone). When a pushed card is answered or withdrawn, Boss Man removes it from your phone (needs ntfy 2.14 or newer), and **Notifications → Recent phone pushes** lists the last 20 with why each was sent.
- **All decisions** also sends routine cards, such as plans, hires and ordinary deploys, at the normal priority (3).
- Everything stays on the Decisions and Notifications pages either way.
- Tick **Also send flags (normal priority)** if you want flags on your phone too.

## Android

### Urgent pushes on Android

The ntfy app asks Android to let its max priority pushes through Do Not Disturb, but Android ignores the request until you turn on the switch yourself. You do this once.

1. In the ntfy app, open **Settings**. Under **Notifications**, choose **Channel settings**. This opens Android's notification settings for ntfy.
2. Choose the **Max priority** channel.
3. Turn on **Override Do Not Disturb**.
4. Turn on Do Not Disturb and choose **Send a test to my phone** in Boss Man. The test is sent as urgent, so it should sound.

Samsung phones may name these menus differently, and some may not have the switch for each channel. If you cannot find it, allow ntfy as an exception in the phone's Do Not Disturb settings instead.

### After an ntfy restart

If pushes only show when you open the app after an ntfy restart, close the app fully and open it again.

## iPhone

iPhones need a wake-up sent through ntfy.sh for instant delivery. Without it, a push can take hours to arrive. Add `NTFY_UPSTREAM_BASE_URL=https://ntfy.sh` to `.env` (or to `images.env` on an image install) and run the ntfy start command again. ntfy.sh receives only the message ID, not the text. Android does not need this.

The ntfy.sh wake-up is about speed only. It does not help a push break through a Focus or Do Not Disturb.

### Urgent pushes on iPhone

On the current ntfy app for iPhone (version 1.7.0), an urgent push may or may not break through a Focus. It depends on the app build. To give it the best chance:

1. On your iPhone, open **Settings → Notifications → ntfy**. Check that **Allow Notifications** is on.
2. Turn on **Time Sensitive Notifications**. If you do not see this switch, your build of the app cannot break through a Focus, and nothing you set will change that.
3. Open **Settings → Focus**. For each Focus you use, such as Sleep or Do Not Disturb, add ntfy to the apps allowed to notify you. This is the safest setting, even if the Time Sensitive switch is on.
4. Turn on a Focus and choose **Send a test to my phone** in Boss Man. The test is sent as urgent, so it shows you what a real urgent push will do.

The silent switch still silences ntfy. An urgent push still appears on the screen, but it makes no sound while the phone is on silent.

ntfy plans Critical alerts, which sound even on silent, for a later app version. It is not released yet, so do not rely on it.

## If the test fails

Check that ntfy is running with `docker compose -p boss-man-ntfy ps`. On a build-from-source install, also check that Boss Man's server is on the `edge` network that Tailscale set up. On an image install, ntfy waits for Boss Man's private network: start Boss Man first, then the ntfy start command again. If your install uses a Compose project name other than `boss-man`, add `BOSSMAN_FRONT_NETWORK=<project>_front` to `images.env`.

## Urgent pushes are silent at night on Android

Do Not Disturb is holding them back. Turn on **Override Do Not Disturb** for ntfy's **Max priority** channel, then test with Do Not Disturb on. See [Urgent pushes on Android](#urgent-pushes-on-android).
