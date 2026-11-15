---
title: Phone notifications
description: How Boss Man tells you about things, and how to send the urgent ones to your phone through your own ntfy server.
group: Everyday use
order: 8
lead: Boss Man tells you about things at four levels. You can have the urgent ones sent to your phone through your own ntfy server. ntfy is a free, open-source notification service.
---

## Notification levels

![How Boss Man tells you: four levels, from a note in the Notifications page, to a flag as a browser notification, to a page and an ask that also reach your phone.](/img/how-youre-told.svg =1160x800 narrow=/img/how-youre-told-narrow.svg:360x1330 "The four levels and the three places they can show up.")

- **Note**: shown in the Notifications page only
- **Flag**: also shown as a browser notification
- **Page**: also sent to your phone
- **Ask**: needs your answer. It goes to your phone only when it is urgent, unless you choose to send all decisions (see below)

You get a page when, for example, a runner goes offline or a runner update is stuck. Cards on Decisions that need your answer arrive as asks.

## Browser notifications

Choose **Turn on browser notifications** in the sidebar. They show while Boss Man is open in a browser tab, including a background tab.

## Quiet hours and limits

Open **Notifications** in the sidebar and find **How you're told**.

- Tick **Quiet hours** and set **From**, **Until** and **Time zone**. During quiet hours, pages and asks become flags, and flags become notes.
- **Per agent, per hour** caps how many flags and pages one agent can send in an hour. The rest become notes. The default is 6.

## Send notifications to your phone

You need Tailscale set up first (see [Add-ons](/guides/add-ons)), because your phone reaches ntfy over your tailnet. The full steps are in [`docs/31-phone-notifications.md`](@repo/blob/main/docs/31-phone-notifications.md), and work on any Linux host.

1. Add `NTFY_BASE_URL=https://<host-name>.<tailnet>.ts.net:8443` to `.env`.
2. Start ntfy as its own Compose project with `docker compose -p boss-man-ntfy --env-file .env -f deploy/ntfy.yml --profile ntfy up -d`.
3. Make a user that can publish, a user your phone reads with, and a publish token, as the repository doc shows. The token starts with `tk_`.
4. In Boss Man, open **Notifications**. Under **How you're told**, tick **Send to my phone through my own ntfy server**. Set **ntfy server** to `http://ntfy:80`, choose a hard-to-guess **Topic**, paste the publish token into **Access token**, and save. Boss Man stores the token encrypted.
5. Set **Boss Man's address on your phone, so a tap opens the evidence** to Boss Man's Tailscale address.
6. On your phone, install the ntfy app, add your server's Tailscale address, log in as the reading user, and subscribe to your topic.
7. Choose **Send a test to my phone**. It appears after you save. The test should arrive within seconds.

## Which cards reach your phone

Under **Send to my phone**, choose **Urgent only (default)** or **All decisions**.

- **Urgent only** sends a deploy that carries the fix for a live problem, a page such as "server unusable", a card the CEO has marked urgent because you must act now, and the test button. A card that merely holds up a ticket (plans, merge sign-offs, after-merge checks) does not push, and a card still with the CEO never does. Urgent pushes go at the top priority (5). On Android, it breaks through Do Not Disturb only after you turn on one switch in the ntfy app: see [Urgent pushes on Android](#urgent-pushes-on-android). On an iPhone, you cannot rely on it to break through a Focus with the current ntfy app: see [Urgent pushes on iPhone](#urgent-pushes-on-iphone). When a pushed card is answered or withdrawn, Boss Man removes it from your phone (needs ntfy 2.14 or newer), and **Notifications → Recent phone pushes** lists the last 20 with why each was sent.
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

## iPhone

iPhones need a wake-up sent through ntfy.sh for instant delivery. Without it, a push can take hours to arrive. Add `NTFY_UPSTREAM_BASE_URL=https://ntfy.sh` to `.env` and run the start command again. ntfy.sh receives only the message ID, not the text. Android does not need this.

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

Check that ntfy is running with `docker compose -p boss-man-ntfy ps`, and that Boss Man's server is on the `edge` network that Tailscale set up.

## Urgent pushes are silent at night on Android

Do Not Disturb is holding them back. Turn on **Override Do Not Disturb** for ntfy's **Max priority** channel, then test with Do Not Disturb on. See [Urgent pushes on Android](#urgent-pushes-on-android).
