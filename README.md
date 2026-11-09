# Boss Man

*Working name.*

Boss Man runs teams of AI agents on a machine you own. Each team is a **company**: a CEO agent plans the work, other agents pick up tickets on a board, and anything that needs you lands in one **decision queue**, so you approve and steer instead of watching every step.

It is for people who want AI agents doing real project work (code, docs, design) on their own Docker host, with their own keys, and who want to stay in charge of what gets merged and deployed.

> **Status: alpha.** Boss Man works, and its own agents build it, but expect rough edges and breaking changes. Read [docs/23-updating.md](docs/23-updating.md) before each update.

## Install

You need a Linux host with Docker (a plain Linux box, a Proxmox VM or LXC, or TrueNAS SCALE), and a Claude subscription or an Anthropic API key.

1. Follow [docs/00-first-time-install.md](docs/00-first-time-install.md). It takes you from an empty host to a company with an agent working its first ticket.
2. On TrueNAS SCALE, [docs/06-install-truenas.md](docs/06-install-truenas.md) is a fuller worked example, with backups and self-updates.
3. Before you update, read [docs/23-updating.md](docs/23-updating.md).

## Get help

- **Something broken, or a question?** See [SUPPORT.md](SUPPORT.md): bugs go to GitHub Issues, questions and ideas to Discussions.
- **A security problem?** Don't post it in public. Report it through GitHub's private form, as [SECURITY.md](SECURITY.md) explains.
- **Want to contribute?** See [CONTRIBUTING.md](CONTRIBUTING.md). During the alpha we take bug reports and ideas, not pull requests.

## How it works

Each company is a team of agents with a CEO. Each company runs in its own **runner container**, with its own secrets and deploy targets. All agents connect through the **Agent Client Protocol (ACP)**. For Claude, that means the official Claude Code running inside the runner, so model lists come from the agents themselves and are never hard-coded. Work is anchored to **objectives with measurable key results**. Companies hire each other through formal **engagements**. The decision queue also holds stale blockers, and it is ranked by how much each item blocks and how soon it is due. Spend is tracked against two **funding sources**: API credit and subscription quota windows.

Boss Man takes its inspiration from [Paperclip](https://github.com/paperclipai/paperclip). It is a separate product, written from scratch, and it does not depend on Paperclip. Compared with Paperclip, it adds:

- companies that can work with each other;
- a kanban board you can change;
- a decision queue, so decisions don't get lost among the tickets;
- reminders for blockers that have gone stale;
- monthly budgets that also track subscription usage;
- model lists read from the agents, so they stay current;
- a fix for Claude sign-ins expiring;
- goals and a roadmap view.

## Run it from source (development)

You need Node 22.12 or later and pnpm 10. The master key encrypts stored secrets, so keep the same one between restarts.

```sh
pnpm install
mkdir -p secrets && openssl rand -base64 32 > secrets/master.key
BOSSMAN_MASTER_KEY_FILE="$PWD/secrets/master.key" BOSSMAN_INSECURE_COOKIES=1 pnpm dev
```

In a second terminal, start the web UI. It opens on http://localhost:5173 and sends API calls to the server on port 3100:

```sh
pnpm dev:web
```

Without `DATABASE_URL` the server keeps its data in an embedded Postgres (PGlite) under `apps/server/data/`. For a real install, use Docker Compose as the install guide describes.

[CLAUDE.md](CLAUDE.md) holds the working rules for the AI agents that build Boss Man. It isn't a guide for people.

## Documents

**Running Boss Man**

| Doc | What's in it |
|---|---|
| [docs/00-first-time-install.md](docs/00-first-time-install.md) | **Start here to install:** from an empty Linux host (or TrueNAS SCALE) to a company with an agent working its first ticket |
| [docs/23-updating.md](docs/23-updating.md) | **Read before you update:** the update steps, backups and how to check one restores, breaking changes that need a hand step, and where release notes are |
| [docs/06-install-truenas.md](docs/06-install-truenas.md) | Installing on TrueNAS SCALE: datasets, building the images on the NAS, credentials, updates and backups |
| [docs/21-move-to-new-host.md](docs/21-move-to-new-host.md) | Moving Boss Man to another Docker host: what moves, hard-coded host values, cut-over order, rollback; TrueNAS and Proxmox notes |
| [docs/22-staging.md](docs/22-staging.md) | A second, separate staging stack: setup, one-step deploy of a commit, rollback, smoke checklist, what it does not cover |
| [docs/09-self-deploy.md](docs/09-self-deploy.md) | Boss Man updating itself: the host deployer, the runner drain, the leader lock and blue/green swaps |
| [docs/11-import-export.md](docs/11-import-export.md) | Moving a company in or out of Boss Man as one file |
| [docs/12-runner-add-ons.md](docs/12-runner-add-ons.md) | Optional tools in the runner image, such as a browser |
| [docs/14-paperclip-migration.md](docs/14-paperclip-migration.md) | Moving a company over from Paperclip |

**How it was designed and built.** These are the project's own planning records. They mention internal ticket numbers (BOS-…) and "the owner", the person who runs a Boss Man install.

| Doc | What's in it |
|---|---|
| [docs/01-scope.md](docs/01-scope.md) | The problem, goals, non-goals and requirements, plus the v1, v1.1 and later scope |
| [docs/02-architecture.md](docs/02-architecture.md) | Components, the runner model, the data model, the decision queue, engagements, budgets and secrets |
| [docs/03-phased-plan.md](docs/03-phased-plan.md) | Spikes first, then the build phases to v1, and the plan for Boss Man to build itself |
| [docs/04-research.md](docs/04-research.md) | Findings with sources: the Paperclip code, Claude authentication and policy, ACP, and quota tracking |
| [docs/05-decision-log.md](docs/05-decision-log.md) | Every scoping decision and its answer |
| [docs/07-feature-requests.md](docs/07-feature-requests.md) | Feedback notes, features, scoring and the public feedback portal |
| [docs/08-v1.2-plan.md](docs/08-v1.2-plan.md) | The v1.2 plan: the runner launcher, the setup wizard, merge checks, pull requests, the Agents page and more |
| [docs/10-migrations.md](docs/10-migrations.md) | The rules for database migrations and server code that keep a rollback safe |
| [docs/13-team-plan.md](docs/13-team-plan.md) | The CEO proposing a team for a project |

## Licence

Apache-2.0. See [LICENSE](LICENSE). Any code adapted from Paperclip (MIT) keeps its MIT notice.
