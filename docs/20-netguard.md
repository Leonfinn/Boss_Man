# Runner network guard (netguard, BOS-324)

A runner container can no longer reach private networks. Agents run shell commands in the runner, and before this they could open the database (`db:5432`) or any machine on the home network. DR-004 (the wiki) explains why this is done per container and not per agent session: Landlock filters ports, never addresses.

## What it does
- The launcher starts a second small container, `boss-man-netguard-<company>`, **inside each runner's network namespace** (`network_mode: container:<runner>`). It has `NET_ADMIN` and nothing else; the runner keeps no capability (`CapAdd: []`).
- It installs one nftables table, `inet bossman_netguard` (covers IPv4 and IPv6), on the runner's outbound traffic:
  - allowed, in this order: loopback (this is also Docker's DNS at 127.0.0.11); TCP to the Boss Man server's addresses on the server's port (from `BOSSMAN_RUNNER_URL`); TCP to the company's **tool servers** and to any owner-listed host:port (below); port 53 to the DNS resolvers the host uses (read from the runner's `resolv.conf`, including a router or Pi-hole on the home network). Addresses are looked up again every 15 s by the guard;
  - refused with "administratively prohibited" (so it fails fast, not by timeout): 10/8, 172.16/12, 192.168/16, 100.64/10, 169.254/16, 0/8, 192.0.0/24, 198.18/15, `fc00::/7`, `fe80::/10`, IPv4-mapped `::ffff:0:0/96`, NAT64 `64:ff9b::/96`, documentation ranges.
  - everything else (the public internet) is untouched.
- There is no "established connections stay" rule: a connection opened while no guard was up (a runner restart leaves a short gap) is cut off the moment the rules load.
- The rules are reapplied atomically (add, delete, add in one `nft -f`), so running the script twice is safe.
- **Tool servers stay reachable.** The server tells the launcher each company's registered tool servers (crawl4ai, scrapling, Penpot, …) as host:port, when a runner starts and whenever one is added or removed. The launcher keeps them in `companies/<slug>/netguard/allow`, a folder only the guard mounts (read-only), never the runner. Only those host:ports open, not whole networks. For other things agents must reach on the LAN or tailnet, set `BOSSMAN_NETGUARD_ALLOW="host:port host:port"` on the launcher (compose passes it through).
- **Git hosts stay reachable.** Each project's repo address (`projects.repoUrl`) gives a host:port (http 80, https 443, ssh 22 or the port in the address) that goes in the same allow file, so a company's runner can clone from its own LAN git server. Only that host and port open, only for that company; changing the repo address or archiving the project updates the list within 15 s, no restart. Nothing is hardcoded. Only the owner can set a repo address, and whatever host:port it names (even an internal service) opens to that company's runner, so set it only to the real git server. Entries the launcher would refuse (an underscore in the host, port 0, IPv6 literals) are left out so one odd address can't break the company's list. When the server starts it sends every runner its list once, so a deploy needs no reconnect.
- **No guard, no runner (by default).** The launcher waits until the guard's rules are loaded (its healthcheck) before it counts a runner as guarded. If the guard can't start, the launcher removes the runner it just made and reports the error.
- **Hosts that can't run it.** If this host can't load nftables rules (some Proxmox LXC containers, kernels without nf_tables), a probe table can't be created and the guard stops with exit code 3 (only then) and says so in `docker logs boss-man-netguard-<slug>`. `BOSSMAN_NETGUARD` then decides: `auto` (default) means **no guard on hosts without nftables**: it keeps the runner running unprotected and shows `guard: "unavailable"` in the launcher's runner list and a log line; `enforce` refuses to start runners; `off` never starts a guard (`guard: "off"`). Every other failure (missing image, rules not loading in time, a ruleset nft refuses, which exits 4) means no runner, on create, restart and the background reconcile alike: no guard, no runner.
- A runner that restarts by itself gets a new network namespace. The launcher watches Docker's container events, so it starts the guard again at once (well under a second) rather than waiting for its 5 s check; the 5 s check stays as the backstop for anything the event stream misses (a reconnect, a Docker restart). Between such a restart and the guard being back, new connections to private addresses are possible for that moment, and a connection opened in the gap is cut when the rules load (BOS-335). Settings → Server and runner shows a warning when a runner's guard is `off` or `unavailable`.
- Guard work for one company is done one step at a time (start, restart, recreate, remove and the 5 s check never overlap).

## Build and update
`docker compose build` (profile `launcher`) builds `boss-man-netguard:current`; `scripts/update-runner.sh` rebuilds it on every runner update, and a change under `apps/netguard/` counts as a runner change in `deploy.sh` and the host deployer. Since BOS-335 that script also rebuilds and recreates the launcher when one is running, so Settings → Server and runner → Updates → **Build and update runners** puts a launcher change live too; it restarts only the launcher, never the runners. CI builds it and `scripts/ci-launcher.sh` proves the behaviour against real Docker: the server answers; the database (IPv4 and IPv6), the network gateway, 192.168.1.1, 169.254.169.254 and `fd00::1` are refused; and the guard returns after the runner restarts.

## Check it by hand
```sh
docker exec boss-man-runner-<slug> curl -s -m 8 -o /dev/null http://db:5432/; echo $?   # 7 means blocked
docker logs boss-man-netguard-<slug>
docker run --rm --cap-add NET_ADMIN --net container:boss-man-runner-<slug> -e NETGUARD_ALLOW=server:3100 boss-man-netguard:current --print   # prints the rules
```

## Roll back
- Stop guarding for good: set `BOSSMAN_NETGUARD=off` in the launcher's environment and recreate the launcher (`docker compose up -d launcher`), then recreate the runners (Settings → Server and runner → Updates, or `scripts/update-runner.sh --now`). New runner namespaces then start with no rules.
- Removing the guard container with `docker rm -f boss-man-netguard-<slug>` does **not** lift the rules: the table lives in the runner's network namespace and stays until the runner restarts. The launcher also starts a new guard within 5 s.
- To go back to the code before this change, deploy the commit before it.

## Known limits

- If a host gives Docker networks global unicast IPv6 addresses (not ULA), services on them stay reachable over IPv6: only fc00::/7 and the other special ranges are blocked.
- Tool servers from an imported company package are allowed through the guard as they are; the import preview shows only their number (follow-up).
- Published host ports reached through a public address of the host are not blocked (only private ranges are).
- Not covered: a runner using `network_mode: host` (the launcher refuses it).

## When a runner is removed because its guard failed (BOS-467)

"No guard, no runner": if the guard doesn't load its rules (for example 20 s is not enough while a deploy has the host busy), the launcher removes that runner. Before BOS-467 it stayed gone until the owner started it by hand.

- **Self-heal.** A company with a `runner.token` file but no runner container is one the launcher removed and the owner did not stop (Stop deletes the token). Every 5 s the launcher makes it again, waiting 10 s, 20 s, 40 s … up to 5 min between failed tries. Look for `runner made again after it was removed` and `could not make runner again; will retry` in the launcher log.
- **Never retried:** a company whose guard exits with code 3 in `enforce` mode (this host can't load the rules; retrying cannot help), and any runner the owner stopped.
- **Telling people.** The server's runner watch (`services/runner-watch.ts`) pages the owner and raises a card in that company when a runner is offline for 3 minutes, and withdraws both when it reconnects. After a server restart it says once whether every runner came back within 5 minutes.
- **Watch details (BOS-497).** A runner registered by hand on a server that also has a launcher still pages: its company is counted as wanted when the launcher was never given it, or when its runner was seen connected while the launcher didn't run it (kept as a `runner-hand:<company>` setting; Stop through the launcher removes it). An offline runner the launcher doesn't want and that was never seen running by hand is an old stop: its last-seen time is cleared, so it stays quiet even when the launcher can't be reached later. After an update hold lifts, runners get the usual 3 minutes from the lift, and the 5-minute deploy check also counts from the lift. The owner is paged once per outage, even across a server restart (a `runner-offline-paged:<runner>` setting, removed on reconnect); the company's card is tried again every pass until it is raised. At server start the launcher's runner and token for a company that no longer exists are removed, so its self-heal stops retrying them.
- **Roll back:** revert the commits for BOS-467; the launcher goes back to remove-and-stay-down. No data or migration is involved.

### Per host

The mechanism is the same on every host: the launcher, Docker and the token files. Only whether the guard exists differs.

- **TrueNAS (Docker/Apps), plain Linux, Proxmox VM:** the guard loads (nftables in the kernel), so self-heal applies.
- **Proxmox LXC:** usually has no nftables inside the container. In `auto` mode the guard is "unavailable", the runner starts unguarded and is never removed for a guard failure, so there is nothing to heal. A runner that is offline there is a stopped container: use Settings → Server and runner → that company's runner → Start / Reconnect, or have the container set to restart on boot (`docker update --restart unless-stopped <container>`, name from `docker ps`).
- After a host or VM reboot, runners come back with Docker's restart policy and the guard is added again by the launcher within 5 s.
