# Runner network guard (netguard, BOS-324)

A runner container can no longer reach private networks. Agents run shell commands in the runner, and before this they could open the database (`db:5432`) or any machine on the home network. DR-004 (the wiki) explains why this is done per container and not per agent session: Landlock filters ports, never addresses.

## What it does
- The launcher starts a second small container, `boss-man-netguard-<company>`, **inside each runner's network namespace** (`network_mode: container:<runner>`). It has `NET_ADMIN` and nothing else; the runner keeps no capability (`CapAdd: []`).
- It installs one nftables table, `inet bossman_netguard` (covers IPv4 and IPv6), on the runner's outbound traffic:
  - allowed: loopback (this is also Docker's DNS at 127.0.0.11), replies to allowed connections, and TCP to the Boss Man server's addresses on the server's port (taken from `BOSSMAN_RUNNER_URL`, looked up again every 15 s by the guard);
  - refused with "administratively prohibited" (so it fails fast, not by timeout): 10/8, 172.16/12, 192.168/16, 100.64/10, 169.254/16, 0/8, 192.0.0/24, 198.18/15, `fc00::/7`, `fe80::/10`, IPv4-mapped `::ffff:0:0/96`, NAT64 `64:ff9b::/96`, documentation ranges.
  - everything else (the public internet) is untouched.
- The rules are reapplied atomically (add, delete, add in one `nft -f`), so running the script twice is safe.
- No guard, no runner: if the guard can't start (for example the image is missing), the launcher removes the runner it just made and reports the error.
- A runner that restarts by itself gets a new network namespace. The launcher checks every 5 s and starts the guard again. **There can be up to 5 s between such a restart and the guard being back.** Follow-up: have the runner refuse to connect until it has tested that the gateway is blocked.

## Build and update
`docker compose build` (profile `launcher`) builds `boss-man-netguard:current`; `scripts/update-runner.sh` rebuilds it on every runner update, and a change under `apps/netguard/` counts as a runner change in `deploy.sh` and the host deployer. CI builds it and `scripts/ci-launcher.sh` proves the behaviour against real Docker: the server answers; the database (IPv4 and IPv6), the network gateway, 192.168.1.1, 169.254.169.254 and `fd00::1` are refused; and the guard returns after the runner restarts.

## Check it by hand
```sh
docker exec boss-man-runner-<slug> curl -s -m 8 -o /dev/null http://db:5432/; echo $?   # 7 means blocked
docker logs boss-man-netguard-<slug>
docker run --rm --cap-add NET_ADMIN --net container:boss-man-runner-<slug> boss-man-netguard:current --print   # needs NETGUARD_ALLOW; prints the rules
```

## Roll back
Turn it off for one company: `docker rm -f boss-man-netguard-<slug>` (the rules vanish with nothing else changed; the launcher will start it again within 5 s, so stop the launcher first for a lasting change). To go back to the previous behaviour for good, deploy the commit before this one.

## Known limits
- Published host ports reached through a public address of the host are not blocked (only private ranges are).
- Not covered: a runner using `network_mode: host` (the launcher refuses it).
