# HTTPS through Tailscale Serve (any Docker host)

Gives Boss Man an `https://boss-man.<your-tailnet>.ts.net` address with a valid certificate, reachable only from devices signed in to your tailnet. It uses Tailscale **Serve**, not Funnel, so nothing is on the public internet. It fronts the owner's web/login port (3100) only, never the feedback portal. The plain LAN address keeps working. The installable web app and phone notifications need this address.

Works on a plain Linux Docker host, a Proxmox VM running Docker, and a Proxmox LXC container running Docker. Host-specific notes are at the end.

## How it works

A small Tailscale container (`deploy/tailscale.yml`) sits on a private Docker network called `edge`. Only it and the server are on that network. Boss Man believes the forwarded address and "https" markers only from one address, `BOSSMAN_EDGE_IP` (passed to the server as `BOSSMAN_TRUSTED_PROXIES`). LAN requests arrive through the published port on the default network, so they can never come from that address. Cookies are marked Secure only on requests that came through it. The login limit counts each phone separately.

Settings in `.env` (all optional; the defaults are used if absent):

| Setting | Default | Meaning |
| --- | --- | --- |
| `BOSSMAN_EDGE_SUBNET` | `172.30.0.0/29` | Address range of the private `edge` network |
| `BOSSMAN_EDGE_IP` | `172.30.0.2` | The Tailscale container's address. It must sit inside the subnet and not be the first address (`.1` is the gateway) |
| `BOSSMAN_EDGE_SERVER_IP` | `172.30.0.3` | The Boss Man server's own address on `edge`. Same subnet, not `.1`, and different from `BOSSMAN_EDGE_IP`. It is pinned so Docker cannot give the Tailscale container's address to the server first |
| `BOSSMAN_DATA` | `/srv/boss-man/data` | Tailscale's state lives in `$BOSSMAN_DATA/tailscale` |
| `TS_HOSTNAME` | `boss-man` | The machine name, so the address is `<TS_HOSTNAME>.<tailnet>.ts.net` |

If the default range clashes with a network the host already uses (your LAN, a VPN, other Docker networks), pick another private range, for example `BOSSMAN_EDGE_SUBNET=10.99.88.0/29`, `BOSSMAN_EDGE_IP=10.99.88.2` and `BOSSMAN_EDGE_SERVER_IP=10.99.88.3`. Step 3 shows how to check.

## What each host needs

The container runs in Tailscale's **userspace mode** (`TS_USERSPACE=true`). It needs no `/dev/net/tun`, no `NET_ADMIN` and no extra capabilities, so the same file works on all three hosts. In this mode Tailscale reaches the server over the ordinary Docker network, so the server still sees each request arrive from `BOSSMAN_EDGE_IP` and the trusted-proxy check holds unchanged. (The connection to the server is opened by the Tailscale container itself, so its source is that container's `edge` address; the client's tailnet address only appears in the forwarded header. Step 8's Secure-cookie check proves this on your host.) The cost: this container serves Boss Man but is not a general tailnet router (not needed here).

- **Plain Linux Docker host:** nothing extra.
- **Proxmox VM running Docker:** nothing extra.
- **Proxmox LXC running Docker:** Docker itself needs the LXC's *nesting* option on (and usually *keyctl*). The Tailscale container needs nothing more, because it does not use TUN. Kernel mode (not used here) would need `/dev/net/tun` passed into the LXC and `NET_ADMIN` on the container. Unknown: whether your LXC template runs Docker without further changes; find out with `docker run --rm hello-world` inside it.

## Steps

1. Open the Tailscale admin console, **DNS** page. Turn on **MagicDNS**, then under **HTTPS Certificates** click **Enable HTTPS**. Note your tailnet name (it ends in `.ts.net`).
2. On the **Settings > Keys** page, click **Generate auth key**. Leave **Reusable** off and **Ephemeral** off (an ephemeral machine disappears when it goes offline), set a short expiry, and copy the key. Do not paste it anywhere except step 4. **Use a key, not the interactive login link:** the Tailscale container gives up on a pending login link after about a minute and restarts, which discards the link, so a login you approve a little late never completes (see "Troubleshooting").
3. On the Docker host, check the default private range is free (Docker creates the Tailscale state folder under your `BOSSMAN_DATA` itself on first start, so there is nothing to make by hand):

   ```sh
   docker network ls -q | xargs docker network inspect --format "{{.Name}} {{range .IPAM.Config}}{{.Subnet}} {{end}}" | grep 172.30.0 || echo free
   ```

   If it prints a network instead of `free`, or `ip -4 route` shows 172.30.0.x in use, set `BOSSMAN_EDGE_SUBNET`, `BOSSMAN_EDGE_IP` and `BOSSMAN_EDGE_SERVER_IP` in `.env` (see above) before step 5.
4. Back up `.env`, then add the key and the extra compose file (use your own key):

   ```sh
   cp .env .env.bak
   sed -i "s#^COMPOSE_FILE=.*#&:deploy/tailscale.yml#" .env
   # the leading space keeps this line out of shell history in bash by default (zsh needs HIST_IGNORE_SPACE; or edit .env in an editor instead)
    echo "TS_AUTHKEY=tskey-auth-PASTE-YOUR-KEY" >> .env
   chmod 600 .env
   ```

   If `.env` has no `COMPOSE_FILE` line, add `COMPOSE_FILE=docker-compose.yml:deploy/tailscale.yml`.
   You do not need to touch `BOSSMAN_INSECURE_COOKIES`: once the sidecar file is in use, Boss Man chooses Secure per request and ignores that line. The feedback portal port is plain http, so its cookie stays non-Secure.
5. Start it: `docker compose up -d tailscale server`. Then `docker compose logs tailscale | tail` should say it is logged in. Then run the check in step 5a.

   **Remove the key from `.env` once it is logged in:** delete the `TS_AUTHKEY=` line (`sed -i '/^TS_AUTHKEY=/d' .env`), then `docker compose up -d tailscale`. The login is kept in the state folder, so an empty key is fine. A spent one-time key does no harm, but it should not sit in a file.

5a. Check it is stable. Run these from the Boss Man folder (the one with `docker-compose.yml`); they need nothing from your `.env` (the first line only sets a helper variable). `RestartCount` must stay at 0 (or stop growing), `BackendState` must say `"Running"` (not `"NeedsLogin"`), and the state file must be well over 1000 bytes (a login that never completed leaves about 120 bytes):

   ```sh
   C=$(docker compose ps -q tailscale)
   docker inspect --format 'RestartCount={{.RestartCount}} Status={{.State.Status}} ExitCode={{.State.ExitCode}}' "$C"
   docker compose exec tailscale stat -c "tailscaled.state: %s bytes" /var/lib/tailscale/tailscaled.state
   docker compose exec tailscale tailscale status --json | grep -m1 BackendState
   ```

   Run it again after two minutes; `RestartCount` must not have gone up. Then prove the login survives a restart: run `docker compose restart tailscale`, wait 30 seconds, and run the block again. `BackendState` must still be `"Running"` with no new login link in `docker compose logs tailscale`.
6. In the Tailscale admin console the machine `boss-man` appears. Check Serve is on and Funnel is off:

   ```sh
   docker compose exec tailscale tailscale serve status
   ```

   It must show `https://boss-man.<tailnet>.ts.net` proxying to `http://server:3100` and say "(tailnet only)", not "Funnel on". Use the address this prints, not one guessed from the example.
7. Prove the trusted address is not shared with LAN traffic. This lists everything on `edge`; it must be only the `tailscale` and `server` containers:

   ```sh
   docker network inspect $(docker network ls -q --filter name=edge) --format '{{.Name}}: {{range .Containers}}{{.Name}} {{.IPv4Address}}; {{end}}'
   ```
8. From your phone, on the tailnet, open the address. The padlock should be valid and login should work. After logging in, open the browser developer tools (Application or Storage > Cookies) and check the `bm_session` cookie is marked **Secure**. If it is not, Serve is not passing the HTTPS marker on; logins still work but tell Boss Man's engineer rather than guessing. Off the tailnet (mobile data with Tailscale turned off) it must not load.
9. In Boss Man, open **Notifications** and set **Boss Man's address on your phone** to the ts.net address, so notification links open it.

To undo: `docker compose stop tailscale`, remove `:deploy/tailscale.yml` from `COMPOSE_FILE` (or restore `.env.bak`), then `docker compose up -d server`. The LAN address is unaffected throughout.

## Troubleshooting

- **The Tailscale container restarts every ~2 minutes (exit code 0), `RestartCount` keeps rising, `tailscaled.state` stays about 120 bytes, and every start logs `NeedsLogin` with a new login link.** Cause: no auth key was set, so the container waits for an interactive login. Tailscale's start-up script allows about 60 seconds for the whole start, including that wait; when it runs out, the container exits cleanly and Docker restarts it with a fresh, different login link. A link opened from an earlier start is dead, and the machine shows in the admin console as approved but disconnected. Fix: delete that machine in the admin console, do steps 2 to 5 with an auth key, and re-run step 5a. (Source: `cmd/containerboot` in the Tailscale repository, which applies a 60-second `bootCtx` to the login step; reproduced by the CI rehearsal `scripts/rehearse/tailscale.sh`, which sees a clean exit and restart about every 60 seconds with no key; confirm on your host with step 5a.)
- `failed to symlink socket: file exists` in the log on every restart is harmless: it is left over from the previous start.
- **Interactive login as a fallback (no key available):** run `docker compose up -d tailscale && docker compose logs -f tailscale`, open the newest `https://login.tailscale.com/a/...` link within about 50 seconds and approve it straight away. If the container restarts first, the link is dead; use the newest one. Prefer a key.

## Backing up and moving to a new host

Tailscale's login is kept in `$BOSSMAN_DATA/tailscale`. Include that folder in your backup and copy it with the rest of `$BOSSMAN_DATA` when you move.

- **State kept** (folder copied to the new host, same `.env` settings, then `docker compose up -d`): the machine keeps its name, so the address stays the same, and you need no new auth key. Stop the old host's container first: two copies of one machine fight over the name.
- **State lost:** Tailscale registers a new machine, named `boss-man-1` or similar while the old one is still listed. Delete the old machine in the admin console, repeat steps 2 to 6, then update **Notifications > Boss Man's address on your phone** and the address saved on your phone (bookmark or installed app) to the new name.

## Blue/green installs

For blue/green (the Caddy front door in `deploy/truenas-bluegreen.yml`) add a second file after `deploy/tailscale.yml`. The path is tailnet, then Tailscale, then Caddy port 3100, then the live colour. Caddy believes forwarded headers only from the Tailscale container, and each colour believes them only from Caddy. The feedback portal (3101) is never reachable through Tailscale.

1. Do steps 1 to 6 above, but in step 4 use this line in `.env` (swap the host file for yours; the blue/green file must come first):

   ```
   COMPOSE_FILE=docker-compose.yml:deploy/truenas-bluegreen.yml:deploy/tailscale.yml:deploy/tailscale-bluegreen.yml
   ```

2. Two private networks are used: `edge` (Tailscale and Caddy) and `front` (Caddy and the two colours). Defaults are `172.30.0.0/29` and `172.30.0.16/28`. If either clashes with a network on your host, compose stops with "Pool overlaps". Check what is used:

   ```
   docker network inspect $(docker network ls -q) --format '{{range .IPAM.Config}}{{.Subnet}} {{end}}'
   ```

   To change them, set `BOSSMAN_EDGE_SUBNET`, `BOSSMAN_EDGE_IP`, `BOSSMAN_EDGE_PROXY_IP`, `BOSSMAN_FRONT_SUBNET`, `BOSSMAN_FRONT_PROXY_IP` and `BOSSMAN_FRONT_RANGE` in `.env`; every address must sit inside its subnet.
3. Apply it (this restarts Caddy and the colours for a few seconds; it is a deployment-file change, so do it by hand, not through the self-update):

   ```
   docker compose up -d
   ```

4. Check: `docker compose exec tailscale tailscale serve status` shows `http://server:3100` and no `3101`. `docker network inspect` for `front` lists only the proxy and the two colours. Log in over `https://<your machine>.<tailnet>.ts.net` and confirm the session cookie is Secure; over the LAN address it stays plain.
5. Undo: remove the two Tailscale files from `COMPOSE_FILE`, run `docker compose up -d`, and rewrite `active.caddy` in the old form if you rolled back the deployment files (see `docs/06-install-truenas.md`).

Behaviour change: the colours now see real client addresses, so the login limit counts each device separately, where before all devices looked like Caddy.

## Host notes

### TrueNAS
- Use `COMPOSE_FILE=docker-compose.yml:deploy/truenas.yml:deploy/tailscale.yml`, with `BOSSMAN_DATA` under your apps dataset (for example `/mnt/<pool>/boss-man/data`; see `docs/06-install-truenas.md`).
- Do not use the TrueNAS Tailscale app: it cannot show that LAN traffic is kept apart from the trusted address.
- Keep the `tailscale` folder in a dataset your snapshots and replication cover.

### Proxmox
- A VM is the same as a plain Linux host. For an LXC, see "What each host needs".
- Back up the VM or container with Proxmox backup, and also keep `$BOSSMAN_DATA/tailscale` in your own file-level backup. Unknown: where your Proxmox backups are stored; find out in **Datacenter > Backup**.

## The Tailscale image

`deploy/tailscale.yml` pins `tailscale/tailscale` by version and digest (v1.104.4 at the time of writing). It was not run on a host before this change, so the first start is the test: check `docker compose logs tailscale`. To update: pick a new release on Docker Hub, copy its multi-arch digest into the `image:` line, run `docker compose pull tailscale && docker compose up -d tailscale`; the state folder keeps the login. Check the Tailscale security bulletins when you do.
