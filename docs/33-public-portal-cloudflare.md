# The feedback portal on a public address (Cloudflare Tunnel)

Works on any Docker host (plain Linux, a Proxmox VM or LXC, TrueNAS). Nothing here depends on the host.

## How it fits together

- A `cloudflared` container (`deploy/cloudflared.yml`) dials out to Cloudflare. No router port is opened and no reverse proxy is needed.
- In the Cloudflare dashboard the tunnel has one public hostname, for example `roadmap.example.com`, pointing at `http://server:3101`.
- `server:3101` is the portal listener. It serves only the portal page, its assets and `/api/portal/...`; everything else is a 404 (`apps/server/src/portal.ts`). The owner's app (3100: login, API, MCP, runners) is never named in the tunnel.
- The name `server` resolves on the default network in a single-server install and in blue/green (Caddy's alias).

## Settings in the .env file

| Line | Value | Why |
|---|---|---|
| `COMPOSE_FILE` | add `:deploy/cloudflared.yml` at the end | starts the tunnel container |
| `CLOUDFLARE_TUNNEL_TOKEN` | the token from the dashboard | secret: edit it in by hand, never paste it into a ticket |
| `BOSSMAN_PORTAL_URL` | `https://roadmap.example.com` | the share link and emails use it |
| `BOSSMAN_PORTAL_CLIENT_HEADER` | `cf-connecting-ip` | Cloudflare sets this header and removes any copy a visitor sent |
| `BOSSMAN_PORTAL_TRUSTED_PROXY` | `172.16.0.0/12` | the Docker networks the tunnel container and Caddy sit on, so real visitor addresses are used for rate limits |

Keep `BOSSMAN_PORTAL_BIND` at its default (`127.0.0.1`): the portal port is then reachable only from the host and from the Docker networks, never from the LAN. `172.16.0.0/12` is Docker's default address range; if your Docker uses another range (`docker network ls`, then `docker network inspect <name>`), list that instead. Never list a range that includes the internet.

## Cloudflare dashboard (Zero Trust)

Create a tunnel (Networks, then Tunnels, then Create a tunnel, type Cloudflared), copy its token, then add a public hostname: your portal host name, service type HTTP, URL `server:3101`. Cloudflare creates the DNS record itself. Cloudflare's own page: https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/get-started/create-remote-tunnel/

## Check

- `https://roadmap.example.com/` shows the public roadmap.
- `https://roadmap.example.com/api/health` and any other owner-app route answer 404.
- Roll back: remove `:deploy/cloudflared.yml` from `COMPOSE_FILE`, restart the stack, delete the tunnel in the dashboard.
