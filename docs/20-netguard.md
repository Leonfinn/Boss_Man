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
- **No guard, no runner (by default).** The launcher waits until the guard's rules are loaded (its healthcheck) before it counts a runner as guarded. If the guard can't start for a runner it has just made (which holds no work yet), the launcher removes that runner and reports the error.
- **Hosts that can't run it.** If this host can't load nftables rules (some Proxmox LXC containers, kernels without nf_tables), a probe table can't be created and the guard stops with exit code 3 (only then) and says so in `docker logs boss-man-netguard-<slug>`. `BOSSMAN_NETGUARD` then decides: `auto` (default) means **no guard on hosts without nftables**: it keeps the runner running unprotected and shows `guard: "unavailable"` in the launcher's runner list and a log line; `enforce` refuses to start runners; `off` never starts a guard (`guard: "off"`). Every other failure (missing image, rules not loading in time, a ruleset nft refuses, which exits 4) means no runner, on create, restart and the background reconcile alike: no guard, no runner.
- A runner that restarts by itself gets a new network namespace. The launcher checks every 5 s and starts the guard again. **There can be up to 5 s between such a restart and the guard being back** for new connections. Follow-up ticket: "Netguard follow-up: close the gap after a runner restarts itself, and show the guard status in Settings" (c6601a3e-9969-43ff-8573-a68d8719ee97).
- **A running runner is never removed because of its guard (DR-007).** If the guard stops but the runner didn't restart, its rules are still in force: the launcher restarts the guard only, with backoff, and reports `retrying`. If the runner restarted (new namespace, no rules) or the owner's Restart left it without a guard, the launcher pauses it (its work and files stay), retries the guard and unpauses it once the rules are loaded. After 2 minutes without a guard it reports `frozen` with the reason. A host that can't pause containers gets the runner stopped instead, kept, and reported `frozen`. The guard image is checked before the old guard is removed. The launcher records which runner start the rules belong to in `netguard/guarded-for` beside the allow list.
- Guard work for one company is done one step at a time (start, restart, recreate, remove and the 5 s check never overlap).

## Build and update
`docker compose build` (profile `launcher`) builds `boss-man-netguard:current`; `scripts/update-runner.sh` rebuilds it on every runner update, and a change under `apps/netguard/` counts as a runner change in `deploy.sh` and the host deployer. CI builds it and `scripts/ci-launcher.sh` proves the behaviour against real Docker: the server answers; the database (IPv4 and IPv6), the network gateway, 192.168.1.1, 169.254.169.254 and `fd00::1` are refused; and the guard returns after the runner restarts.

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
