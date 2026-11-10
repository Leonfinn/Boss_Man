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

You need Tailscale set up first (see [Add-ons](/guides/add-ons)), because your phone reaches ntfy over your tailnet. The full steps are in [`docs/06-install-truenas.md`](@repo/blob/main/docs/06-install-truenas.md), section "Phone notifications", and work on any Linux host.

1. Add `NTFY_BASE_URL=https://<host-name>.<tailnet>.ts.net:8443` to `.env`.
2. Start ntfy as its own Compose project with `docker compose -p boss-man-ntfy --env-file .env -f deploy/ntfy.yml --profile ntfy up -d`.
3. Make a user that can publish, a user your phone reads with, and a publish token, as the repository doc shows. The token starts with `tk_`.
4. In Boss Man, open **Notifications**. Under **How you're told**, tick **Send to my phone through my own ntfy server**. Set **ntfy server** to `http://ntfy:80`, choose a hard-to-guess **Topic**, paste the publish token into **Access token**, and save. Boss Man stores the token encrypted.
5. Set **Boss Man's address on your phone, so a tap opens the evidence** to Boss Man's Tailscale address.
6. On your phone, install the ntfy app, add your server's Tailscale address, log in as the reading user, and subscribe to your topic.
7. Choose **Send a test to my phone**. It appears after you save. The test should arrive within seconds.

## Which cards reach your phone

Under **Send to my phone**, choose **Urgent only (default)** or **All decisions**.

- **Urgent only** sends a decision that holds up work only you can answer, a deploy that carries the fix for a live problem, a "server unusable" page, and the test button. Urgent pushes go at the top priority (5), which breaks through Do Not Disturb on Android.
- **All decisions** also sends routine cards, such as plans, hires and ordinary deploys, at the normal priority (3).
- Everything stays on the Decisions and Notifications pages either way.
- Tick **Also send flags (normal priority)** if you want flags on your phone too.

## iPhone

iPhones need a wake-up sent through ntfy.sh for instant delivery. Add `NTFY_UPSTREAM_BASE_URL=https://ntfy.sh` to `.env` and run the start command again. ntfy.sh receives only the message ID, not the text. Android does not need this.

## If the test fails

Check that ntfy is running with `docker compose -p boss-man-ntfy ps`, and that Boss Man's server is on the `edge` network that Tailscale set up.
