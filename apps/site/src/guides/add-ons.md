---
title: Add-ons
description: The optional extras for Boss Man: Tailscale, ntfy, Penpot and runner add-ons, and how to turn each one on.
group: Set it up your way
order: 9
lead: Boss Man works without any add-ons. Each one below is optional and off until you turn it on.
---

![Three kinds of extra for agents: skills come from a link, a draft or an upload, are checked by the Security Reviewer and approved by you, and run in the agent's session; tool servers are servers you add yourself and run elsewhere; runner add-ons come from Boss Man's short list, you turn them on in .env, and they are built into the runner. A skill that needs an add-on waits until it shows Working.](/img/three-kinds-of-add-on.svg =1160x460 narrow=/img/three-kinds-of-add-on-narrow.svg:360x1160 "Skills, tool servers and runner add-ons: where each comes from, who approves it and where it runs.")

## Tailscale: HTTPS from anywhere on your tailnet

Tailscale gives Boss Man an address such as `https://boss-man.<tailnet>.ts.net` with a real certificate. Only devices on your tailnet can reach it. Your home network address keeps working. You need it for phone notifications and to install Boss Man as an app on your phone.

1. In the Tailscale admin console, turn on MagicDNS and HTTPS Certificates.
2. Generate an auth key that is not reusable and not ephemeral.
3. In `.env`, add `:deploy/tailscale.yml` to the end of `COMPOSE_FILE`, and add `TS_AUTHKEY=` with the key.
4. Run `docker compose up -d tailscale server`.
5. Once it has logged in, remove the `TS_AUTHKEY` line from `.env`.
6. Open Boss Man at the new address, then open **Notifications**: **Boss Man's address on your phone** is already filled in with it if it was empty. Check it and save.

Back up `$BOSSMAN_DATA/tailscale` with your other backups. The full steps are in [`docs/20-https-tailscale.md`](@repo/blob/main/docs/20-https-tailscale.md).

## ntfy: notifications on your phone

See [Phone notifications](/guides/phone-notifications).

## Penpot: a design tool for your designer agents

Penpot is an open-source design tool. Boss Man runs it as a separate Compose project, `boss-man-penpot`, on your home network only.

1. In `.env`, set `PENPOT_BIND` to the machine's home network address (never `0.0.0.0`), `PENPOT_PUBLIC_URI` to `http://<that address>:9001`, `PENPOT_SECRET_KEY` (make it with `openssl rand -base64 48`) and `PENPOT_DB_PASSWORD` (make it with `openssl rand -hex 24`).
2. Start it with `docker compose -p boss-man-penpot --env-file .env -f deploy/penpot.yml --profile penpot up -d`.
3. Sign-up is off. To make accounts, add `PENPOT_REGISTRATION=enable` to `.env`, start it again, make the accounts, then delete the line and start it again.

To give agents access, open **Settings → Tools and deploys → Penpot** and save its address and the agent account's access token. Boss Man opens that address in the network guard by itself, so there is no `.env` line to add. Back it up with `scripts/backup-penpot.sh`. The full steps, including giving agents access, are in [`docs/15-penpot.md`](@repo/blob/main/docs/15-penpot.md) and [`docs/16-penpot-agent-setup.md`](@repo/blob/main/docs/16-penpot-agent-setup.md).

## Runner add-ons: extra tools for agents

Runner add-ons are tools built into the runner image, such as a browser agents can drive. Two exist: `agent-browser` and `webkit`.

1. Add `RUNNER_ADDONS=agent-browser` to `.env`. List several with commas, for example `RUNNER_ADDONS=agent-browser,webkit`.
2. Choose **Settings > Server and runner > Updates > Build and update runners** (with the host deployer), or run `scripts/update-runner.sh` as root.
3. Check under **Settings > Server and runner > Runner > Add-ons**. Each add-on says Working, Not working or Not installed.

Skills that need an add-on are left out of agents' runs until it works. Details: [`docs/12-runner-add-ons.md`](@repo/blob/main/docs/12-runner-add-ons.md).
