# Staging: a second Boss Man for checking a release first (BOS-69)

Staging is a complete, separate Boss Man (its own server, database, data folder, secrets and runners) that you deploy a chosen commit to before production. Production's files and deploy path are not changed by it. It runs on any Docker host (Linux, a Proxmox VM or LXC, TrueNAS); the owner's own box is only a worked example at the end.

## What is separate

| | Production | Staging |
|---|---|---|
| Install folder | its own checkout | a **second** checkout of this repository |
| Compose project | `boss-man` | `boss-man-staging` (`COMPOSE_PROJECT_NAME`) |
| Database, volumes, networks | `boss-man_*` | `boss-man-staging_*` |
| Secrets | `secrets/master.key`, `.env` | its own, never copied |
| Data folder | `$BOSSMAN_DATA` | a different `$BOSSMAN_DATA` |
| Ports | 3100 / 3101 | 3200 / 3201 (set in `.env`) |
| Runners | `boss-man-runner-<company>` | `boss-man-staging-runner-<company>`, label `boss-man.stack=staging` |
| Images | `boss-man-{runner,launcher,netguard}:current` | `boss-man-staging-*:current` |

The launcher reads `BOSSMAN_STACK`. With it empty (production) names, labels and images are exactly as before. With `staging` it only lists, restarts and removes containers that carry its own stack label, so staging can never see or stop a production runner.

## First-time setup (any Docker host)

Do this on the host that will run staging, with `docker` and `git`. Nothing here touches production.

1. Make a second checkout, next to production (not inside it):
   ```
   git clone <the same repository URL production uses> boss-man-staging
   ```
   For a private repo, production reads it with a deploy key that is set inside production's checkout (`core.sshCommand`, [docs/00, step 2](00-first-time-install.md#2-get-the-code-onto-the-host)), not in your shell's own SSH setup, so a plain clone fails with `Permission denied (publickey)`. Clone with production's setting so staging's later fetches use the same read-only key (the same host, so it is still one key per host):
   ```
   git clone -c core.sshCommand="$(git -C <production folder> config core.sshCommand)" "$(git -C <production folder> remote get-url origin)" boss-man-staging
   ```
2. Make staging's own secrets (new key, new password):
   ```
   cd boss-man-staging && mkdir -p secrets && openssl rand -base64 32 > secrets/master.key
   ```
   ```
   sudo chown 1000:1000 secrets/master.key && chmod 600 secrets/master.key
   ```
3. Make the staging-only data folder (pick a path that is not production's):
   ```
   sudo mkdir -p /srv/boss-man-staging/data/companies && sudo chown 1000:1000 /srv/boss-man-staging/data/companies
   ```
4. Write `.env` in the staging folder. Use a fresh `POSTGRES_PASSWORD`. Find the Docker group id with `stat -c %g /var/run/docker.sock`:
   ```
   COMPOSE_PROJECT_NAME=boss-man-staging
   POSTGRES_PASSWORD=<openssl rand -hex 24>
   BOSSMAN_HOST_PORT=3200
   BOSSMAN_PORTAL_HOST_PORT=3201
   BOSSMAN_BIND=<the LAN or Tailscale address of the host>
   BOSSMAN_DATA=/srv/boss-man-staging/data
   BOSSMAN_LAUNCHER=1
   COMPOSE_PROFILES=launcher
   BOSSMAN_DOCKER_GID=<the group id above>
   BOSSMAN_RUNNER_MEMORY=2g
   COMPOSE_FILE=docker-compose.yml:deploy/staging.yml
   ```
   `BOSSMAN_BIND` is who can reach staging: use the host's LAN or Tailscale address, never `0.0.0.0` on a host that faces the internet. `COMPOSE_FILE` makes every `docker compose` command in this folder use the staging overlay (staging image names, staging launcher stack), so even a hand-typed one can't build production's image tags; `--check` refuses without it. Do not run `scripts/deploy.sh` or `scripts/update-runner.sh` in this folder: they are production's and refuse here.
5. Check the isolation rules without starting anything:
   ```
   scripts/deploy-staging.sh --check
   ```
6. Deploy a commit (below), open `http://<BOSSMAN_BIND>:3200`, create the staging owner account, then create a staging company; the launcher starts its runner.

## Deploy a commit to staging (one step)

From the staging folder:
```
scripts/deploy-staging.sh <commit, branch or tag>
```
It refuses to run if this folder shares anything with another install it can see (project name, ports, `POSTGRES_PASSWORD`, `BOSSMAN_DATA`, `master.key`), checks out exactly that commit, builds, starts the stack, waits for the server to be healthy and prints the address. A branch name means the remote's branch (`origin/<name>`), and the line "Deploying <ref> = <hash>" shows what was picked. Only after the new commit is healthy does it remember the last good commit for rollback. Running it again for the same commit is safe. `--dry-run` shows the steps first. If the runner code changed it builds the staging runner image and has staging's own launcher recreate the staging runners; there is nothing to click in Settings. If production lives in a folder that is not beside this one, the script refuses because it has nothing to compare against; pass `BOSSMAN_PRODUCTION_DIRS=/path/to/production` so a shared password or copied key is caught (or `BOSSMAN_ISOLATION_NO_PEERS=1` if this host truly has no other Boss Man install). Two runs at once are refused: a lock in the folder's `.git` lets only one deploy proceed. `deploy.sh` and `update-runner.sh` also refuse in any folder whose `COMPOSE_FILE` includes `deploy/staging.yml`, even if `.env` sets no project name.

If any image build fails, the script stops before starting anything ("An image build failed ... nothing was started") and the staging that was running, if any, is left as it was. The builds download packages (Debian's apt, npm), so a build error such as `Could not resolve 'deb.debian.org'` means Docker's builds on this host had no working DNS at that moment. To tell a one-off from a standing fault, run this on the host; it does a throwaway build that only looks up that name:
```
printf 'FROM debian:bookworm-slim\nRUN getent hosts deb.debian.org\n' | docker build --no-cache --progress=plain - 2>&1 | tail -n 4
```
An address in the output means DNS works in builds now: run the deploy again. An error every time means Docker's builds can't reach a name server: check `grep nameserver /etc/resolv.conf` on the host (Docker can't use a `127.x` resolver from inside a build) and, if needed, set `"dns"` in `/etc/docker/daemon.json`. Restarting Docker for that restarts production too, so pick a quiet moment.

## Rollback

```
scripts/deploy-staging.sh --rollback
```
puts the last commit that came up healthy back (code only; the staging database is not touched) and waits for health. A commit that failed to start is never the rollback target. To go forward again, deploy the newer commit by hash. If the newer code changed the database schema, the older code may not start on it; and if staging's data itself is damaged, it is disposable: from the staging folder run `docker compose -p boss-man-staging down -v`, which removes only staging's containers and volumes (never run it from the production folder), then deploy again. The staging data folder is under `BOSSMAN_DATA`; delete it only after checking the path.

## Boss Man's staging target

**Not supported yet.** A host deployer runs `scripts/deploy.sh` and `scripts/update-runner.sh`, which are production's and now refuse in a staging folder, so do not point one at the staging checkout. Until a staging-aware deployer exists, deploy to staging with `scripts/deploy-staging.sh` and record the result on the release ticket by hand. A deploy target named `staging` in Settings is follow-up work.

## Smoke checklist (QA, about 10 minutes)

1. Open the staging address. It loads over the LAN or Tailscale and is not reachable from outside.
2. Sign in as the staging owner (create the account the first time).
3. The board loads with no errors, and the side menu opens.
4. Create a ticket and see it on the board.
5. Create or open a staging company, check Settings → Runner shows its runner connected, assign the ticket and see the run start and finish.
6. Open Settings → Server and runner → Updates: the version shown is the commit you deployed.
7. Production check: `docker ps` shows production's containers unchanged, and production's runners are not listed in staging's Settings.

## What staging does not cover

- Production's data size, history and performance: staging starts empty. Never restore a production dump into it without scrubbing secrets; with a different master key stored secrets could not be read anyway.
- Real secrets and integrations (GitHub, Cloudflare, mail): add test ones or leave them out.
- The edge in front of production (HTTPS, Tailscale serve, blue/green swap): staging is a single server on plain http unless you add the same files.
- Load: staging shares the host with production, so timings are not production's. Stop it when idle: `docker compose -p boss-man-staging stop`.
- Isolation of the host: staging's launcher holds the host's Docker socket, so any commit deployed to staging can control the whole host, production included. Deploy only commits you would trust on production's host, never unreviewed agent branches.
- Anything that needs the owner's real accounts or other machines.

## Worked example: TrueNAS and the Minisforum (Proxmox) box

These values are the owner's, not defaults. On TrueNAS SCALE, create the datasets for the staging folder and data in the UI and use their mount paths in `.env`; the checkout lives beside production's. On the Minisforum, a Proxmox VM or LXC with Docker installed is the host: follow the steps above inside it, and bind `BOSSMAN_BIND` to the VM's Tailscale address. Once the new box is the production host, a separate staging VM is the cleaner setup; the same folder works there unchanged.
