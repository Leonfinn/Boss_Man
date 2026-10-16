# Boss Man

*Working name.*

Boss Man is a self-hosted platform for running teams of AI agents organised as companies. It takes its inspiration from [Paperclip](https://github.com/paperclipai/paperclip). It is a separate product, written from scratch, and it does not depend on Paperclip.

It fixes the following problems in Paperclip:

- Companies cannot work with each other.
- The kanban board is fixed.
- Decisions get lost among the tickets.
- Blockers are forgotten.
- Budgets are lifetime-only, and Paperclip records subscription usage at $0.
- Model lists are out of date.
- Claude sign-in expires.
- Goals have been retired, and there is no roadmap view.

> **Status:** scoping complete (2026-10-16). There is no code yet.

## Documents

| Doc | What's in it |
|---|---|
| [docs/01-scope.md](docs/01-scope.md) | The problem, goals, non-goals and requirements, plus the v1, v1.1 and later scope |
| [docs/02-architecture.md](docs/02-architecture.md) | Components, the runner model, the data model, the decision queue, engagements, budgets and secrets |
| [docs/03-phased-plan.md](docs/03-phased-plan.md) | Spikes first, then the build phases to v1, and the plan for Boss Man to build itself |
| [docs/04-research.md](docs/04-research.md) | Findings with sources: the Paperclip code, Claude authentication and policy, ACP, and quota tracking |
| [docs/05-decision-log.md](docs/05-decision-log.md) | Every scoping decision (Q1–Q29) and its answer |

## The idea in one paragraph

Each company is a team of agents with a CEO. Each company runs in its own **runner container**, with its own secrets and deploy targets. All agents connect through the **Agent Client Protocol (ACP)**. For Claude, that means the official Claude Code shipped inside the runner, so model lists come from the agents themselves and are never hard-coded. Work is anchored to **objectives with measurable key results**. Companies hire each other through formal **engagements**. Anything that needs the owner goes into one **decision queue**, which also contains stale blockers. The queue is ranked by how much each item blocks and by how soon it is due. Spend is tracked against two **funding sources**: the Max plan's $200 a month of API credit, and its subscription quota windows.

## Licence

Apache-2.0. See [LICENSE](LICENSE). Any code adapted from Paperclip (MIT) keeps its MIT notice.
