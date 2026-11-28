# The feedback portal on a public address (Cloudflare Tunnel)

Works on any Docker host (plain Linux, a Proxmox VM or LXC, TrueNAS). Nothing here depends on the host.

## How it fits together

- A `cloudflared` container (`deploy/cloudflared.yml`) dials out to Cloudflare. No router port is opened and no reverse proxy is needed.
- In the Cloudflare dashboard the tunnel has one public hostname, for example `roadmap.example.com`, pointing at `http://server:3101`.
- `server:3101` is the portal listener. It serves only the portal page (`/` redirects to it), the email-confirmation page `/confirm.html`, their assets and `/api/portal/...`; everything else is a 404 (`apps/server/src/portal.ts`). The owner's app (3100: login, API, MCP, runners) is never named in the tunnel.
- The name `server` resolves on the default network in a single-server install and in blue/green (Caddy's alias).

## Settings in the .env file

| Line | Value | Why |
|---|---|---|
| `COMPOSE_FILE` | add `:deploy/cloudflared.yml` at the end | starts the tunnel container |
| `CLOUDFLARE_TUNNEL_TOKEN` | the token from the dashboard | secret: edit it in by hand, never paste it into a ticket |
| `BOSSMAN_PORTAL_URL` | `https://roadmap.example.com` | the share link and emails use it |
| `BOSSMAN_PORTAL_CLIENT_HEADER` | `cf-connecting-ip` | Cloudflare sets this header and removes any copy a visitor sent |
| `BOSSMAN_PORTAL_TRUSTED_PROXY` | `172.16.0.0/12` | the Docker networks the tunnel container and Caddy sit on, so real visitor addresses are used for rate limits |

Keep `BOSSMAN_PORTAL_BIND` at its default (`127.0.0.1`): the portal port is then reachable only from the host and from the Docker networks, never from the LAN. `172.16.0.0/12` is Docker's default address range; if your Docker uses another range (`docker network ls`, then `docker network inspect <name>`), list that instead. Never list a range that includes the internet. `172.16.0.0/12` is wide: it covers every Docker network on the host, so another container there could present its own `cf-connecting-ip` and get a fresh rate-limit key. Once you know the real subnet of the network the tunnel and the server share (the `Subnet` line in `docker network inspect`), narrow the value to it. The subnet of your host is not known in advance; find it with that command, do not guess.

## Updating cloudflared

The image in `deploy/cloudflared.yml` is pinned by version and digest. To bump it, pick the new release tag on Docker Hub (`cloudflare/cloudflared`), copy the digest of its multi-arch index, put both into the `image:` line, and run `scripts/check-compose.sh`.

## Cloudflare dashboard (Zero Trust)

Create a tunnel (Networks, then Tunnels, then Create a tunnel, type Cloudflared), copy its token, then add a public hostname: your portal host name, service type HTTP, URL `server:3101`. Cloudflare creates the DNS record itself. Cloudflare's own page: https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/get-started/create-remote-tunnel/

## Check

- The portal's secret link from the Feedback page (`https://roadmap.example.com/portal.html#<secret>`) shows the public roadmap.
- `https://roadmap.example.com/` shows it too only if you ticked **Open this portal at the public address itself** under **Short public address** on the Feedback page (off by default). Without the tick it opens the portal page with "This link is incomplete. Ask for the full portal link."
- `https://roadmap.example.com/api/health` and any other owner-app route answer 404.
- Roll back: remove `:deploy/cloudflared.yml` from `COMPOSE_FILE`, restart the stack, delete the tunnel in the dashboard.

## Image install (no source folder)

Status: **not yet confirmed on a real host** (the file passes Compose's own validation; nobody has run these steps against a real Cloudflare tunnel yet, 28 Nov 2026). For an install made from ready-made images ([docs/35](35-install-from-images.md)). There is no `deploy/` folder, so the tunnel comes as a release file, `docker-compose.cloudflared.images.yml`, next to `docker-compose.images.yml`. It is its own Compose project (`boss-man-portal`) and is off until you start it; updates and "Start again from nothing" do not touch it. Run everything in the folder with `images.env`.

1. Make the tunnel and its public hostname in the Cloudflare dashboard (section "Cloudflare dashboard" above; the URL is `server:3101`). Copy the token.
2. Download the file of the same release you installed (the same `$V` as in docs/35, section 1):

   ```
   V=$(curl -fsS https://api.github.com/repos/Leonfinn/Boss_Man/releases | grep -m1 '"tag_name"' | cut -d '"' -f 4) && curl -fsSLO https://github.com/Leonfinn/Boss_Man/releases/download/$V/docker-compose.cloudflared.images.yml
   ```

3. Add these lines to `images.env`. Edit the file by hand: the token is a secret, so never paste it anywhere else. `172.30.0.18` is the install's proxy; use your `BOSSMAN_FRONT_PROXY_IP` instead if you set one:

   ```
   CLOUDFLARE_TUNNEL_TOKEN=<the token>
   BOSSMAN_PORTAL_URL=https://roadmap.example.com
   BOSSMAN_PORTAL_CLIENT_HEADER=cf-connecting-ip
   BOSSMAN_PORTAL_TRUSTED_PROXY=172.30.0.18
   ```

4. Run the install's start command again, so the server learns the three portal lines (it is remade with them at the next update):

   ```
   docker compose --env-file images.env -f docker-compose.images.yml up -d
   ```

5. Start the tunnel:

   ```
   docker compose -p boss-man-portal --env-file images.env -f docker-compose.cloudflared.images.yml --profile portal up -d
   ```

6. Check as in "Check" above. `docker compose -p boss-man-portal --env-file images.env -f docker-compose.cloudflared.images.yml --profile portal ps` shows `healthy` once the tunnel is connected. If Docker says the network `boss-man_default` is not found, your install uses another project name: set `BOSSMAN_DEFAULT_NETWORK=<project>_default` in `images.env` (`docker network ls` lists it).

**A week on.** Nothing to repeat: the tunnel restarts with Docker and the lines stay in `images.env`. To update the tunnel, download the new release's file (step 2) and run step 5 again. Stop it with the step 5 command ending `--profile portal down`, and delete the tunnel in the dashboard.
