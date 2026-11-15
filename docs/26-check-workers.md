# Check workers: more machines for checks

A **check worker** is a small container on another Docker host that takes check jobs (quick checks and merge checks) from your Boss Man server when the check line is long. It runs no agents and never merges anything. Design: DR-060. The variable names below match the worker code (BOS-1435 identity and slots, BOS-1436 code bundles).

## What it is, and what it can reach

- It **dials out only**: a `wss://` connection to your server's HTTPS address (or a Tailscale address). No port is published on the worker host, so nothing needs opening in a firewall or router.
- It holds **no GitHub, AI or deploy credentials**. Its one secret is the worker token. It gets code as git bundles through your server, so it needs no GitHub login.
- It **runs agent-written tests**, so give it a host you trust with your source code, as you trust the main runner host.
- A remote host has **no Boss Man network guard**. While a check runs, the worker can reach the **npm registry** (pnpm installs), **your Boss Man server**, and whatever else that host's network allows. If that matters, put the host on a network that allows only those two.
- Jobs run behind the same **Landlock** file fence as on the runner, where the host kernel has it (Linux 5.13 or newer; the worker's `agent fence:` log line says whether it is active). Without it jobs run unfenced inside the container: only use such a host if you accept that.
- Image commit match: a worker takes jobs only when its image is built from the same commit as your runner. After "Build and update runners" an old worker sits **idle** and the Checks panel says so. Update it (below).

## Add a worker (any Docker host)

You need Docker with the compose plugin on the second host, and the repository's `deploy/check-worker.yml` there.

1. In Boss Man: Settings → Server and runner → Checks → Add a check worker. Give it a name and the number of checks at once. Copy the token: it is shown once.
2. On the worker host, save the token alone in a file (for example `worker-token`, owned by user id 1000 with permission 600, outside any repository: Compose keeps the file's owner and mode, so a root-owned 600 file is unreadable to the worker and it exits at start). The worker reads it from a file and refuses a token placed in the environment, because a check could read the environment.
3. Make an env file `check-worker.env` (permission 600) next to the compose file. Never commit it. It holds no secret, only the address, the token file's path and the image:
   ```
   BOSSMAN_WORKER_URL=wss://boss.example.com/api/check-worker/connect
   BOSSMAN_WORKER_TOKEN_FILE=/srv/check-worker/worker-token
   BOSSMAN_WORKER_IMAGE=<the worker image, see "The image" below>
   ```
   The address must end in `/api/check-worker/connect`: a runner address is refused.
4. Start it: `docker compose -p boss-man-check-worker --env-file check-worker.env -f deploy/check-worker.yml up -d`
5. In Boss Man, Checks shows the worker as connected within a minute. Queue a check and watch it take a job.

Remove one: `docker compose -p boss-man-check-worker -f deploy/check-worker.yml down -v` on the host, then revoke the token in Boss Man. Nothing on your main server changes.

Repos live in a **named Docker volume** (`check-worker-repos`), not a host folder. The first job per project downloads the whole repository (about 190 MB for a repository this size) through the server; after that each job is usually under 1 MB. Deleting the volume only costs that first download again.

## The image

The worker image is the runner image built without Claude Code and OpenCode (`--build-arg WITH_HARNESS=0`), because a worker never runs an agent. It holds no Anthropic code. Build it where you build the runner, or pull the published one when images are published (docs/25-published-images.md):

```
docker build -f apps/runner/Dockerfile --build-arg WITH_HARNESS=0 --build-arg RUNNER_ADDONS=agent-browser --build-arg BOSSMAN_IMAGE_COMMIT=$(git rev-parse HEAD) -t boss-man-check-worker:current .
```

`RUNNER_ADDONS=agent-browser` puts Chromium in the image. The project's own tests paint pages in a browser and fail, not skip, in a full check when none is there, so a worker that runs full checks needs it. CI builds the worker image the same way and runs the typecheck and tests inside it.

## Update a worker

When "Build and update runners" finishes, its card lists each worker with the steps. In short, on each worker host: pull or build the new image, set `BOSSMAN_WORKER_IMAGE` to it, and run the `up -d` command from step 4. Running checks on that worker are re-queued. Do this soon: until then the worker is idle.

## Settings and example values

Optional lines in the env file: `BOSSMAN_CHECK_SLOTS` (checks at once), `BOSSMAN_CHECK_WORKER_CPUSET` (pin to CPU threads, such as `8-15`; preferred to a CPU cap because test tools then size themselves to those threads), `BOSSMAN_CHECK_WORKER_CPUS` (a hard CPU cap), `BOSSMAN_CHECK_WORKER_MEMORY`. Test workers per check and a memory hint per check are set per worker in the Add a check worker form in Boss Man, not in the env file. The server's per-worker slot setting can lower `BOSSMAN_CHECK_SLOTS`, never raise it. None of these have a host-specific default in the code. Sizing rule of thumb: a check wants about 4 threads and 4 GB when it is busy; leave the host enough to do its own job.

## Per-host notes

### Plain Linux (VM or bare metal)
Install Docker Engine and the compose plugin from Docker's own repository, copy `deploy/check-worker.yml`, follow "Add a worker". Landlock needs kernel 5.13 or newer (`uname -r`).

### Proxmox (VM or LXC)
Prefer a **VM**: Docker works in it without special settings and the guest has its own kernel, so Landlock follows the guest kernel. In an **LXC** container Docker needs *nesting* turned on (and for unprivileged containers `keyctl`), and Landlock follows the Proxmox host's kernel. Give the guest the CPU and memory you want checks to use, rather than limiting the container afterwards, then follow "Add a worker".

### TrueNAS
Example values for a box with an 8-core, 16-thread CPU at a 15 W limit (measured by Brains; see the wiki page on this box). They are examples for that host, never defaults:

| Setting | Example |
|---|---|
| Checks at once (`BOSSMAN_CHECK_SLOTS`) | 2 |
| `BOSSMAN_CHECK_WORKER_CPUSET` | `8-15` (cores 4 to 7, both threads each) |
| `BOSSMAN_CHECK_WORKER_MEMORY` | `14g` |
| Repos | the named volume, with Docker's storage on an SSD pool if the box has one (confirm on the TrueNAS Storage page) |

Expect each check to run about 40% slower than on the main server when the box is busy, and 35 to 45% extra load on the NAS while checks are queued. Run the compose file as a TrueNAS custom app or from a shell on the box, with the env file kept on a dataset that is not shared.

## Troubleshooting

- **Worker not connected:** `docker compose -p boss-man-check-worker logs --tail 50`. A wrong token or address is named there. A wrong `wss://` address looks like repeated connection errors.
- **Connected but takes no jobs:** the Checks panel says "out of date" when the image commit differs; update it. Otherwise the line may simply be short: your main runner takes jobs first.
- **Fence not active:** the worker logs `agent fence: <level>` at start; `unavailable` means the kernel lacks it.
