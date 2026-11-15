# 32 — Running Boss Man on Proxmox

This page is for owners who want to run Boss Man on a Proxmox VE server.

**Use a VM, not an LXC container.** Make a Linux VM, install Docker in it, then follow [docs/00-first-time-install.md](00-first-time-install.md) inside the VM as on any Linux host.

## Why a VM

Boss Man mounts the Docker socket and starts runner containers that run agent code. In a VM:
- **The network guard works.** It stops runners reaching your home network. It needs nftables in the kernel, which a VM has. Most LXC containers have no nftables, so there the guard is "unavailable" and runners run **without that protection** (see [docs/27-netguard.md](27-netguard.md)). Settings → Server and runner shows a warning when that happens.
- **Docker works as normal.** A VM has its own kernel, so Docker uses its normal storage, and nothing depends on LXC nesting, AppArmor or user ID mapping.
- **Agent code stays behind a hardware boundary,** not just a shared kernel.

## What to give the VM

The repo does not state a minimum. As a guide from the code:
- **Memory:** each runner is sized from "Agents at once" and "Checks at once" (2 GB, plus 1 GB per agent, plus 3 GB per check: 11 GB with the defaults), and Boss Man keeps it within the host's memory less 2 GB for the server. A smaller VM gets a smaller runner. More on this in [docs/29-tune-and-troubleshoot.md](29-tune-and-troubleshoot.md#memory-limits).
- **CPU threads:** the optional reserved threads setting needs 6 or more threads to do anything.
- **Disk:** each company has a 20 GB workspace cap by default, plus the database, images and backups.

How to create the VM, and which Proxmox options to pick, is not covered here. See the Proxmox documentation (the **Help** button in its web interface).

## Backups

A Proxmox backup of the VM is a useful extra safety net. It does not replace Boss Man's own database backups (`scripts/deploy.sh` makes one before every update), because a copy of a running database may not restore cleanly. Keep both, and keep `secrets/master.key` off the host.

## If you use an LXC container anyway

It is not supported, and runners will most likely run without the network guard. Prove each of these before you rely on it:
- nesting turned on in the container's options (and usually keyctl), so Docker runs: `docker run --rm hello-world` must work inside it;
- a working Docker storage driver on the backing store;
- user ID mapping that lets bind mounts owned by user ID 1000 work;
- what the network guard reports: Settings → Server and runner → **Network guard**. If it says unavailable, runners can reach your home network.

Tailscale (for HTTPS and phone notifications) needs nothing extra in either a VM or an LXC: Boss Man runs it in userspace mode, so no `/dev/net/tun` is needed.

## Related pages

- [docs/00-first-time-install.md](00-first-time-install.md): the install steps.
- [docs/21-move-to-new-host.md](21-move-to-new-host.md): moving an existing Boss Man to a Proxmox VM.
- [docs/27-netguard.md](27-netguard.md): the network guard.
- [docs/20-https-tailscale.md](20-https-tailscale.md): HTTPS through Tailscale, with Proxmox notes.
