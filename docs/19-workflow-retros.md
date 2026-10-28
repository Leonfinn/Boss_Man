# Workflow retros

Boss Man gets better at running its team over time, but nothing goes live without approval. A retro looks across agents and across two levels: features and their tasks. It finds where work goes wrong between agents and proposes one small change at a time. It then checks whether each change helped.

The research behind this is summarised in the PR for this doc: harness2, hermes-agent, ADAS/AFlow/MASS, GEPA, Agent Workflow Memory and MAST.

The short version:
- Automated search over prompts or team shapes needs a cheap benchmark that can be run again and again. We don't have one, because every ticket costs real money.
- So we learn from the tickets we already ran.
- We blame handoffs and patterns, never one agent on one ticket. Automatic blame picks the right step only about 14% of the time ([Who&When](https://arxiv.org/abs/2505.00212)).

## Owner's choices (28 Oct 2026)

1. The CEO approves playbooks and brief lessons. The owner approves everything else.
2. A retro runs every 20 completed tickets or 7 days, whichever comes first.
3. The retro is run by the Product Manager by default (the agent made from the `product-manager` template). Settings can pick any agent.
4. All four parts are built.
5. The retro looks at two levels: tasks, and the features they make up. Example: the tasks get done, but the feature waits on one task that didn't finish in time.

## 1. Scorecard (no model calls)

New records:
- **`ticket_transitions`**: one row per state change. The existing `state_changed_at` trigger writes it, so every code path is covered.
  - shortcut: history starts at deploy. Older tickets have only the activity log.
- **`check_results`**: one row per CI or verify result (ticket, commit, kind, passed, at). Today only the latest `pullRequestCi` is kept.

`GET /api/companies/:id/workflow?days=14` and a **Workflow** page show the scorecard:

- **Per role and per agent:**
  - tickets done
  - first-time review pass rate
  - mean rework rounds
  - median cycle time (in progress to done)
  - cost per done ticket
  - watchdog flags
  - share of decisions where the answer differed from the recommendation
- **Handoffs:** a from-role → to-role table of count, median wait and bounce rate.
  - Assignments: from `assigned` activity to the assignee's first run.
  - Reviews: from request to verdict.
  - Bounces: `changes_requested`.
- **Features:** for each open or recently released feature:
  - tasks done/total
  - the **tail**: tasks still open once at least 75% are done, with age, state and assignee
  - flag when a tail task is older than twice the company's median cycle time
  - for released features: **tail lag**, the time from the 75th-percentile task completion to the last task completion

## 2. Retro run

- **Trigger:** a sweep counts tickets done since the last retro. At 20, or 7 days after the last retro, it wakes the retro agent with reason `retro`.
  - It doesn't fire if nothing was done since the last one.
  - The first retro waits until 5 tickets are done.
- **What the run gets:**
  - the scorecard, compared with the previous period
  - digests (not transcripts) of up to 10 worst tickets: 2+ rework rounds, a stall, merge failed, over cost cap, or an overridden recommendation
  - the worst feature tails
  - the open and recent workflow changes, and their results
- **What it does:** it tags each bad ticket with a failure type (a MAST-style short list) and the handoff where it went wrong. It saves the findings, ranked by how often they recur, with `save_retro`. The saved findings show on the Workflow page.

## 3. Proposals

`propose_workflow_change` takes the setting to change, the target, the new value, the evidence (ticket refs), and the number it should move. It makes one decision with **Apply** and **Skip**.

| Setting | Who approves | Applied through |
|---|---|---|
| Playbook (a skill for a role's agents) | CEO | `skills` + `agent_skills`, source `retro` |
| Brief lesson | CEO | the existing lesson decision |
| Agent instructions | Owner | `agent_changes` (undoable) |
| Review policy for one risk tier | Owner | company `reviewPolicy` |
| Plan-first for one risk tier | Owner | company setting |
| Watchdog thresholds | Owner | `companies.watchdog`, backtested before it is proposed |
| Model or thinking for one agent | Owner | `agent_changes` |
| Hire (a role is a bottleneck) | Owner | the existing hire decision |

Rules:
- Only one live change per agent per setting.
- At most 3 proposals per retro.
- `workflow_changes` keeps the old value, the new value, the metric and its baseline, so every change can be undone.

Not built yet: plan-first (there is no per-company setting for it; it follows the risk tier) and hire (the hire decision is the CEO's, with its own approval setting, so a retro's change can't be tracked through it).

## 4. Check the result

- Fourteen days or 10 relevant done tickets after Apply (whichever comes later, capped at 30 days), Boss Man measures the metric again.
- It raises **Keep / Revert** with the before and after numbers. The decision goes to whoever approved the change.
- Revert restores the saved old value.
- A playbook that is reverted is archived, not deleted.

## Skipped

These are skipped on purpose:
- Automated prompt or team-shape search.
- Re-running tickets to compare.
- Fine-tuning.
- Agents editing their own code.
- Any change without approval.
- Usage-based archiving of skills (Boss Man doesn't record skill use).

## 5. Critical path (research: partly supported)

Classical critical path planning assumes unlimited workers and known durations. Boss Man has neither: 4 runs per company and 1 per agent, and real durations vary with retries, review rounds and queueing.

Scheduling with limited workers is the resource-constrained scheduling problem (RCPSP). It is NP-hard, and in practice teams use simple priority rules instead of solving it exactly ([Chand et al.](https://cs.adelaide.edu.au/users/markus/pub/2017priorityrules.pdf)). Classical scheduling also assumes known durations, which LLM work does not have ([LLMSched](https://arxiv.org/abs/2504.03444)). We found no study of critical paths for teams of coding agents.

What we build:
- **Measured durations.** Durations come from history, not model guesses: the median and 85th-percentile cycle time per role, from `ticket_transitions`.
  - Below 10 done tickets for a role, use the company-wide numbers.
  - Below 10 for the whole company, show no estimate.
- **The path on each feature.** The longest chain through `ticket_dependencies`, shown as a p50–p85 range.
- **Ageing flags.** An open task on the path flags when it is unassigned, blocked, or older than its role's 85th-percentile time. This is the Kanban "ageing work in progress" idea, and it targets the "one late task holds the feature" case directly.

Not built, and waiting on the owner:
- Letting the scheduler prefer critical-path tasks when slots are short. This changes which work runs first.

Not built at all:
- Critical chain (CCPM) buffers.
- Monte Carlo forecasts. These need more history first.
- Model-generated duration estimates.
- Cost-of-delay scoring.
