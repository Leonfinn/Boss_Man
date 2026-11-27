---
title: What keeps agents fenced in
navTitle: Agents fenced in
description: What your agents can and cannot reach on your machine and your network, the two locks that keep them in (the agent fence and the network guard), where to see that both are on, and which machines give the full fence.
group: Set it up your way
order: 6
lead: Your agents run commands on your machine, so Boss Man keeps them in. Two locks do it. The agent fence keeps each agent to its own folders. The network guard keeps agents off your home network. Both are on by default and need nothing from you.
---

## Where agents work

Agents never run on your machine directly. Each company's agents work in its **runner**: a separate, locked-down space on the machine that runs Boss Man. The runner:

- has no special system rights, and cannot gain any
- cannot start or stop other containers, because it has no access to Docker
- sees only its own company's folders, never your machine's files or another company's work
- gets your keys and passwords (secrets) one run at a time, and only the ones granted to that company or that agent

Inside the runner, two locks do the rest.

## The agent fence: each agent keeps to its own folders

The agent fence is a limit, set by the Linux kernel, on which files an agent's commands can touch. It covers everything the agent starts: its shell commands, file edits and browsers.

An agent **can** change:

- the copy of the work for its own task
- its own home folder, kept for that agent
- a temporary folder made fresh for each run

An agent **can only read**:

- the system's programs and libraries
- the project's shared code, which it copies from but cannot change

An agent **cannot reach**:

- other tasks' folders or other agents' home folders
- the runner's own key and your company's git login
- other runs' temporary folders, and the runner's shared temporary folder (`/tmp`)

When the fence refuses something, the agent sees "Permission denied", and Boss Man writes it to the permission log. The fence never asks you anything and does not change which permission cards you get. Permission cards are a separate check: see [Permissions and the CEO-first rule](/guides/permissions).

### Where to see it

Open **Settings > Permissions** and find **Agent fence**. A line says how well this machine fences agents:

- "This host fences agents fully": every protection is on.
- "This host fences agents partly", with what is not covered.
- "This host can't fence agents": see [If a lock can't be proven](#if-a-lock-can-t-be-proven) below.

The **Fence** setting below it starts on **Watch** for a new company: agents run inside the fence, and every refusal is logged. **Off** runs agents without the fence, and then they can read the runner's key and your company's git login. A stricter **Enforce** setting is listed but not available yet.

## The network guard: agents stay off your home network

The network guard sits on the runner's connection and refuses addresses agents must not reach. Agents can reach:

- the public internet
- the Boss Man server, on its own port only
- the name servers your machine uses to look up web addresses
- each project's git host, and each tool server you added, at its exact address only

The guard refuses everything else on a private network at once, including:

- other machines at home or in the office, such as your router, printer or storage box
- the Boss Man database
- the cloud provider's private settings address, if Boss Man runs on a rented server

Boss Man also refuses any request an agent makes to fetch a page or call a tool on a private address, before any permission rule, so no rule can lift it.

Two gaps are known. A port that your machine publishes on its own public address is not blocked. Nor is a Docker network with public IPv6 addresses.

### Where to see it

- **Settings > Permissions > Agent fence** has a line that should say "Network guard: on. The runner tried to reach its own gateway and was refused at once."
- **Settings > Server and runner > This server > Network guard** lists every address Boss Man opens for your agents, under **Allowed automatically**, and the extra lines you added, under **Extra lines from your .env**.

### Letting agents reach something on your network

Sometimes agents need a service at home, such as a design tool. Boss Man opens each project's git host and each tool server by itself. For anything else, add its address and port to `BOSSMAN_NETGUARD_ALLOW` in your `.env` file, for example `BOSSMAN_NETGUARD_ALLOW="192.168.1.20:9001"`. The full steps are in [`docs/27-netguard.md`](@repo/blob/main/docs/27-netguard.md).

## If a lock can't be proven

The runner tests both locks each time it starts. If either one can't be proven on your machine, Boss Man holds agent work: no task starts. Chat with the CEO still works, because it cannot run commands or touch files.

A card on **Decisions** asks what to do:

- **Keep agents stopped** (recommended): fix the machine first, then restart the runner.
- **Run agents without the fence**, or **Run agents without the network guard**: agents work, without that lock.

Your choice is kept for this machine. A new machine or kernel asks again.

## Which machines give the full fence

Both locks need Linux. The agent fence needs a Linux kernel with Landlock, version 5.19 or newer. A kernel of 6.12 or newer gives the full fence. On older kernels, one run can still send signals to another run's programs, and some kernels also miss a few file limits.

| Machine | Agent fence | Network guard |
|---|---|---|
| 64-bit Linux, on a VM or on bare metal, kernel 6.12 or newer | full | yes |
| 64-bit Linux, kernel 5.19 to 6.11 | partly | yes |
| TrueNAS SCALE, or a Proxmox virtual machine | if its kernel has it (see above) | yes |
| Docker Desktop on a Mac with Apple silicon (preview) | yes | not proven yet |
| Docker Desktop on Windows (preview) | not tested yet | not proven yet |
| Proxmox LXC container | not supported yet | usually no |
| 32-bit ARM, Podman, rootless Docker | not supported yet | not supported yet |

To check your own machine, look at **Settings > Permissions > Agent fence** after the runner has started. For the full platform list, see [Which platforms work](/guides/install-boss-man#which-platforms-work).

## What the locks don't cover

The locks limit where an agent can go. They don't judge what it does there. An agent with a git token can still push to that repository, and an agent with an API key can still spend on it. Those are covered by reviews, permission cards and spending limits. See [Permissions and the CEO-first rule](/guides/permissions), [Reviews and the merge queue](/guides/reviews-and-merge-queue) and [What agents cost](/guides/what-agents-cost). For a wider look at the risks, see [What can go wrong with AI agent teams](/what-can-go-wrong).
