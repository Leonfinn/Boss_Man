---
title: Add-ons
description: The optional extras for Boss Man: Tailscale, ntfy, Penpot and runner add-ons, and how to turn each one on.
group: Set it up your way
order: 9
lead: Boss Man works without any add-ons. Each one below is optional and off until you turn it on.
---

![Three kinds of extra for agents: skills come from a link, a draft or an upload, are checked by the Security Reviewer and approved by you, and run in the agent's session; tool servers are servers you add yourself and run elsewhere; runner add-ons come from Boss Man's short list, you turn them on in .env, and they are built into the runner. A skill that needs an add-on waits until it shows Working.](/img/three-kinds-of-add-on.svg =1160x460 narrow=/img/three-kinds-of-add-on-narrow.svg:360x1160 "Skills, tool servers and runner add-ons: where each comes from, who approves it and where it runs.")

**Image install or build-from-source?** On an image install (your folder holds `images.env` and `docker-compose.images.yml`), these add-ons work, because they are set up inside Boss Man: [tool servers](#tool-servers-extra-tools-from-servers-you-run), [check workers](#check-workers-more-machines-for-checks), [outgoing email](#outgoing-email), and a Penpot server you already run elsewhere. Tailscale, ntfy, starting Penpot, runner add-ons and the public portal need files and scripts from the source code. An image install does not have them, so their steps below are for a build-from-source install only. There are no steps for an image install yet.

## Tailscale: HTTPS from anywhere on your tailnet

Build-from-source install only.

Tailscale gives Boss Man an address such as `https://boss-man.<tailnet>.ts.net` with a real certificate. Only devices on your tailnet can reach it. Your home network address keeps working. You need it for phone notifications and to install Boss Man as an app on your phone.

1. In the Tailscale admin console, turn on MagicDNS and HTTPS Certificates.
2. Generate an auth key that is not reusable and not ephemeral.
3. In `.env`, add `:deploy/tailscale.yml` to the end of `COMPOSE_FILE`, and add `TS_AUTHKEY=` with the key.
4. Run `docker compose up -d tailscale server`.
5. Once it has logged in, remove the `TS_AUTHKEY` line from `.env`. Then run `docker compose up -d tailscale`.
6. In Boss Man, open **Notifications**, type the new address into **Boss Man's address on your phone** and save. Boss Man does not fill in a ts.net address for you.

Back up `$BOSSMAN_DATA/tailscale` with your other backups. The full steps are in [`docs/20-https-tailscale.md`](@repo/blob/main/docs/20-https-tailscale.md).

## ntfy: notifications on your phone

See [Phone notifications](/guides/phone-notifications).

## Penpot: a design tool for your designer agents

Penpot is an open-source design tool. Boss Man runs it as a separate Compose project, `boss-man-penpot`, on your home network only. Starting it this way (steps 1 to 3) needs a build-from-source install. On an image install, skip to giving agents access below, with a Penpot server you run yourself. Not yet confirmed on a real image install.

1. In `.env`, set `PENPOT_BIND` to the machine's home network address (never `0.0.0.0`), `PENPOT_PUBLIC_URI` to `http://<that address>:9001`, `PENPOT_SECRET_KEY` (make it with `openssl rand -base64 48`) and `PENPOT_DB_PASSWORD` (make it with `openssl rand -hex 24`).
2. Start it with `docker compose -p boss-man-penpot --env-file .env -f deploy/penpot.yml --profile penpot up -d`.
3. Sign-up is off. To make accounts, add `PENPOT_REGISTRATION=enable` to `.env`, start it again, make the accounts, then delete the line and start it again.

To give agents access, open **Settings → Tools and deploys → Penpot** and save its address and the agent account's access token. Boss Man opens that address in the network guard by itself, so there is no `.env` line to add. Back it up with `scripts/backup-penpot.sh`. The full steps, including giving agents access, are in [`docs/15-penpot.md`](@repo/blob/main/docs/15-penpot.md) and [`docs/16-penpot-agent-setup.md`](@repo/blob/main/docs/16-penpot-agent-setup.md).

## Runner add-ons: extra tools for agents

Runner add-ons are tools built into the runner image, such as a browser agents can drive. Two exist: `agent-browser` and `webkit`.

Build-from-source install only. An image install downloads a ready-made runner image with no add-ons in it, and it cannot build its own, so **Build and update runners** does not apply there.

1. Open **Settings > Server and runner > Runner > Add-ons**, tick the add-ons you want and press **Save add-ons**. Boss Man keeps your choice, so every later runner update builds the same set.
2. Press **Build and update runners** (Settings > Server and runner > Updates).
3. Check the same panel again. Each add-on says Working, Not working or Not installed.

An install that listed add-ons in `.env` before this panel existed needs nothing: those add-ons start ticked, and the first save keeps them. If the runner is offline and nothing has been built or saved yet, the boxes are locked and say **Can't tell which add-ons are on yet**: wait for the runner to connect, and they unlock. Without self-deploy, the panel can't save, and `RUNNER_ADDONS` in `.env` still works with `scripts/update-runner.sh`.

Skills that need an add-on are left out of agents' runs until it works. Details: [`docs/12-runner-add-ons.md`](@repo/blob/main/docs/12-runner-add-ons.md).

## Tool servers: extra tools from servers you run

A tool server (MCP) gives agents extra tools, such as reading web pages. Add one under **Settings > Tools and deploys**.

## A public feedback portal

Build-from-source install only, because the tunnel is started from a file in the code. To let anyone reach your feedback portal from the internet, put it behind a Cloudflare Tunnel. Only the portal is published, never the rest of Boss Man. The steps are in [`docs/33-public-portal-cloudflare.md`](@repo/blob/main/docs/33-public-portal-cloudflare.md).

## Check workers: more machines for checks

A check worker is a small container on another Docker host that runs checks when the check line is long. It runs no agents. Add one under **Settings > Server and runner > Limits and checks**, with **Add a check worker**. The steps are in [`docs/34-check-workers.md`](@repo/blob/main/docs/34-check-workers.md).

## Outgoing email

Boss Man can send email, for example to let portal visitors confirm their posts. See [Outgoing email](/guides/outgoing-email).
