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
   BOSSMAN_INSECURE_COOKIES=1
   ```
   `BOSSMAN_BIND` is who can reach staging: use the host's LAN or Tailscale address, never `0.0.0.0` on a host that faces the internet. `BOSSMAN_INSECURE_COOKIES=1` is only for plain-http LAN access; leave it out behind HTTPS.
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
It refuses to run if this folder shares anything with another install it can see (project name, ports, `POSTGRES_PASSWORD`, `BOSSMAN_DATA`, `master.key`), checks out exactly that commit, records the one it replaced, builds, starts the stack, waits for the server to be healthy and prints the address. Running it again for the same commit is safe. `--dry-run` shows the steps first. If the runner code changed it builds the staging runner image and tells you to click Build and update runners in staging's Settings.

## Rollback

```
scripts/deploy-staging.sh --rollback
```
puts the previous commit back (code only; the staging database is not touched) and waits for health. To go forward again, deploy the newer commit by hash. If staging's data itself is damaged, it is disposable: from the staging folder run `docker compose -p boss-man-staging down -v`, which removes only staging's containers and volumes (never run it from the production folder), then deploy again. The staging data folder is under `BOSSMAN_DATA`; delete it only after checking the path.

## Boss Man's staging target

To let a release's "staging first" step use this, add a non-production deploy target named `staging` in Settings, with a host deployer of its own: a second `host-deployer.sh` with its own folder and schedule (see `docs/09-self-deploy.md`) pointing at the staging checkout. That target belongs to the production Boss Man, so it is set up there; staging's own Settings stay for staging companies.

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
- Anything that needs the owner's real accounts or other machines.

## Worked example: TrueNAS and the Minisforum (Proxmox) box

These values are the owner's, not defaults. On TrueNAS SCALE, create the datasets for the staging folder and data in the UI and use their mount paths in `.env`; the checkout lives beside production's. On the Minisforum, a Proxmox VM or LXC with Docker installed is the host: follow the steps above inside it, and bind `BOSSMAN_BIND` to the VM's Tailscale address. Once the new box is the production host, a separate staging VM is the cleaner setup; the same folder works there unchanged.
