# Check workers: more machines for checks

A **check worker** is a small container on another Docker host that takes check jobs (quick checks and merge checks) from your Boss Man server when the check line is long. It runs no agents and never merges anything. Design: DR-060.

## Add a worker (any Docker host)

You need Docker with the compose plugin on the second host (`docker compose version` shows 2.23.1 or newer). Nothing to clone, build or download by hand.

1. In Boss Man: Settings → Server and runner → Checks → **Add a check worker**. Give it a name, choose the company, set the number of checks at once, press **Add**.
2. Boss Man shows a complete compose file with your server's address, the version and the token already filled in. Press **Copy compose file**. The token is inside it and is shown once.
3. On the worker host, put that text in a file called `compose.yaml` in an empty folder, and run:
   ```
   docker compose up -d
   ```
   On TrueNAS (custom app), Portainer or Dockge, paste the same text into their compose editor instead and start it there.
4. In Boss Man, Checks shows the worker as connected within a few minutes (the first start builds the worker image, which takes a few minutes). Queue a check and watch it take a job.

Treat `compose.yaml` as a secret: it holds the token. If it leaks, remove the worker in Boss Man (its token stops at once) and add a new one.

The file is `deploy/check-worker/compose.yaml` in this repository, if you would rather fill it in by hand. The marked values are the server address (`BOSSMAN_URL`, which must end in `/api/check-worker/connect`) and the token. There is no commit to fill in (BOS-1570).

Remove a worker: `docker compose down -v` next to the file, then remove it in Boss Man. Nothing on your main server changes.

### How the image gets there

Compose **builds the worker image itself from Boss Man's source on GitHub** (`build: context: <repo>.git#main`, with `pull_policy: build`, so every `docker compose up -d` or Redeploy looks at the source again and Docker's cache makes it a no-op when nothing changed). This was chosen over a published image because the worker image is not in the published set yet (docs/25-published-images.md: only the server, launcher and netguard images are), and over a clone on the worker host because it needs no git, no clone and no build command. Nothing in the file names a commit, so an update never means editing it (see "Tools match" below). To freeze a worker, put a 40-character commit after `#` instead of `main`. It is the runner image built without Claude Code and OpenCode (`WITH_HARNESS=0`), because a worker never runs an agent. It does include a web browser (`RUNNER_ADDONS=agent-browser`, Chromium), because the project's own tests need one and fail rather than skip in a full check without it (BOS-1553). When a worker image is published, `build:` can become `image:` with no other change.

### The token

The token never goes into the container's environment (a check could read it there). The compose file's `configs:` entry has Compose put it into the container as a file that the worker's user can always read. This replaces the old "save a file owned by user id 1000 with mode 600" step, which could fail silently. If a token file still cannot be read, the worker now logs which file and why, and exits.

## What it is, and what it can reach

- It **dials out only**: a `wss://` connection to your server's HTTPS address (or a Tailscale address). No port is published on the worker host, so nothing needs opening in a firewall or router.
- It holds **no GitHub, AI or deploy credentials**. Its one secret is the worker token. It gets code as git bundles through your server, so it needs no GitHub login.
- It **runs agent-written tests**, so give it a host you trust with your source code, as you trust the main runner host. It has no Docker socket, drops all capabilities, cannot gain new ones, and has a memory limit.
- A remote host has **no Boss Man network guard**. While a check runs, the worker can reach the **npm registry** (pnpm installs), **your Boss Man server**, and whatever else that host's network allows. If that matters, put the host on a network that allows only those two.
- Jobs run behind the same **Landlock** file fence as on the runner, where the host kernel has it (Linux 5.13 or newer; the worker's `agent fence:` log line says whether it is active). Without it jobs run unfenced inside the container: only use such a host if you accept that.
- **Tools match (BOS-1570):** a worker takes jobs when the tools checks run with are the same as on your runner: Node, pnpm, git, ShellCheck, ripgrep, jq, the Docker CLI and compose plugin, actionlint and the Debian release (a browser is shown but not compared). Both sides hash those versions the same way (`apps/runner/src/toolchain.ts`) and send the fingerprint when they connect. The commit does **not** matter: the code under test comes in the job's git bundle, so an ordinary "Build and update runners" leaves every worker working with nothing for you to do. Only a real toolchain change (a new Node, pnpm or tool pin) makes a worker "out of date"; the Checks panel then names the tool (for example "node 22.10.0 here, 22.11.0 on your runner") and you press Redeploy (below). A worker or runner image too old to report its tools falls back to the old commit match, once.
- **What this trades away:** a worker no longer proves it was built from the exact runner commit. It does not need to: checks run the job's bundle, the worker still holds no GitHub, AI or deploy credentials and has no Docker socket, and the fingerprint is self-reported just as the commit was (the worker token is the trust boundary, unchanged). A redeploy builds the current `main`, a build from a public repository you already trust for the old commit pin.
- Repos live in a **named Docker volume**, not a host folder. The first job per project downloads the whole repository (about 190 MB for a repository this size) through the server; after that each job is usually under 1 MB. Deleting the volume only costs that first download again.

## Update a worker

**Day 1:** paste the file once; the worker connects and takes jobs. **After a runner update:** nothing. **After a toolchain change** (the Checks panel says "Out of date" and names the tool): on that worker host press Redeploy in Arcane, Portainer, Dockge or TrueNAS, or run `docker compose up -d` next to the file. It rebuilds the worker and swaps it; running checks on that worker go back in line. You never edit the file.

**One time, for a worker set up before BOS-1570:** its file still pins a commit and its image cannot report its tools, so after the first runner update it sits idle. Replace the file with a fresh one from Add a check worker (or change `#<commit>` to `#main`, delete the `BOSSMAN_IMAGE_COMMIT` line and the commit in `context`) and redeploy once. The Checks panel says so.

## Optional settings

These are lines already in the file; change them in place. None has a host-specific default.

- `BOSSMAN_CHECK_SLOTS`: checks at once. Boss Man's per-worker setting can lower it, never raise it.
- `mem_limit` and `memswap_limit`: memory for the container (8g to start).
- `cpuset` (pin to CPU threads, such as `"8-15"`) or `cpus` (a hard cap): remove the `#` in front. A cpuset is preferred, because test tools then size themselves to those threads.
- Test workers per check and a memory hint per check are set per worker in the Add a check worker form, not in the file.

Sizing rule of thumb: a check wants about 4 threads and 4 GB when it is busy; leave the host enough to do its own job.

## Per-host notes

### Plain Linux (VM or bare metal)
Install Docker Engine and the compose plugin from Docker's own repository, then follow "Add a worker". Landlock needs kernel 5.13 or newer (`uname -r`).

### Proxmox (VM or LXC)
Prefer a **VM**: Docker works in it without special settings and the guest has its own kernel, so Landlock follows the guest kernel. In an **LXC** container Docker needs *nesting* turned on (and for unprivileged containers `keyctl`), and Landlock follows the Proxmox host's kernel. Give the guest the CPU and memory you want checks to use, rather than limiting the container afterwards, then follow "Add a worker". (A Boss Man server on the same Proxmox host can have its worker in a separate VM or LXC; the worker needs only the server's address.)

### TrueNAS
Create a **custom app** from YAML and paste the copied file; no shell is needed. Example values for a box with an 8-core, 16-thread CPU at a 15 W limit (measured by Brains; see the wiki page on this box). They are examples for that host, never defaults:

| Setting | Example |
|---|---|
| Checks at once (`BOSSMAN_CHECK_SLOTS`) | 2 |
| `cpuset` | `"8-15"` (cores 4 to 7, both threads each) |
| `mem_limit` and `memswap_limit` | `14g` |
| Repos | the named volume, with Docker's storage on an SSD pool if the box has one (confirm on the TrueNAS Storage page) |

Expect each check to run about 40% slower than on the main server when the box is busy, and 35 to 45% extra load on the NAS while checks are queued.

## Troubleshooting

- **Worker not connected:** `docker compose logs --tail 50` next to the file (or the app's log view). A wrong token or address is named there. A wrong `wss://` address looks like repeated connection errors.
- **`configs ... content` or an unknown-field error from Compose:** the host's Compose is older than 2.23.1; update the Docker compose plugin.
- **The build fails to fetch the source:** the host must reach github.com. If you froze the worker on a commit, check it is the full 40 characters and exists in the repository.
- **Connected but takes no jobs:** the Checks panel says "Out of date" and names the tool that differs; press Redeploy. Otherwise the line may simply be short: your main runner takes jobs first.
- **Fence not active:** the worker logs `agent fence: <level>` at start; `unavailable` means the kernel lacks it.
