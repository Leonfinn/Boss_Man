---
title: "What agents cost: funding sources and limits"
description: How Boss Man pays for your agents' work, the limits you can set, what happens when a limit is reached, and where to see what your agents have spent.
group: Set it up your way
order: 5
lead: Every agent's work is paid from a Claude plan or an API key. Boss Man records what each one spends, and you can set limits so a bill never surprises you.
---

## Funding sources

A funding source is a Claude plan or an API key that agents' work is charged to, with its limits. Each agent is paid from one funding source. You choose it under **Paid from** when you hire the agent, and you can change it on the **Agents** page.

There are two kinds you will meet first:

- **A plan** (Claude Pro, Max or Ultra, connected with a setup token). You pay a fixed monthly price to Anthropic. Agents' work uses up the plan's allowance, not money, so Boss Man shows it in tokens, not dollars.
- **An API key** (pay as you go). Each piece of work costs money from your Anthropic credit. Boss Man shows an estimate in dollars at list prices. It is not a bill: Anthropic's Console has the real figure.

If you connected Claude in the setup wizard with a setup token, Boss Man has already made the CEO's funding source. To add or change one, open **Settings → Funding**. To choose between a plan and a key, see [Connect a Claude account](/guides/connect-a-claude-account).

## The limits you can set

| Limit | Where | What it counts | At the limit |
|---|---|---|---|
| **Monthly spend cap** for a project | **Projects**, your project, **Config** tab | API-key work only, per calendar month (UTC) | No new work starts on the project. A Decisions card asks you to **Raise the cap by half** or **Keep it paused**. |
| **Cost cap per task** | the same form | All work on one task, plan work included at list prices | Work on that task stops. A card asks you to **Raise the cap by half** or **Stop work on it**. |
| **Spending limit per month** for a project | **Projects**, your project, **Budget** tab | API-key work | You choose under **At the limit**: **Ask me** or **Pause**. |
| **Hold routine work at** for a plan | **Settings → Funding**, on the plan's card | How much of the plan's allowance is used | Routine work waits until the allowance resets. Chats and reviews carry on. |

Work that is already running always finishes. A limit only stops new work from starting.

**Ask me or Pause.** With **Ask me**, work carries on and a Decisions card tells you the limit has been passed. You choose **Raise it by half**, **Make it a hard stop** or **Leave it**. With **Pause**, no new work starts until the next month.

**A plan's allowance.** A Claude plan has an allowance that resets every 5 hours and every week. When it reaches the hold level (95% unless you change it), Boss Man pauses routine work and tells you. Tasks marked **Priority 1** and your extra-usage setting can change that: see [When a plan is nearly used up](/guides/agents-and-models#when-a-plan-is-nearly-used-up).

## Limits outside Boss Man

Boss Man's caps count its own estimates. They do not see extra usage or top-up credit you buy on a plan. Set a limit with Anthropic too, so the real bill has a ceiling:

- For an API key, set a **Monthly spend limit** in the Claude Console. [Connect a Claude account](/guides/connect-a-claude-account#3-set-a-monthly-spend-limit) shows how.
- For a plan, check your usage in claude.ai under **Settings → Usage**. If you turn on usage credits there, set a limit on them as well.

## Where to see what agents spend

- **Dashboard.** One card shows this month's spend: **API spend this month** in dollars, or **Subscription tokens this month** for a plan. Choose it for more detail.
- **Spend.** Spend by day, by agent and by feature, and the costliest tickets. Open it from the Dashboard card, or from a project's **Budget** tab with **See spend by day, agent and feature**.
- **A project's Budget tab.** This month's pay-as-you-go spend against its cap, with a forecast of when it reaches the limit, and its costliest tasks.
- **Settings → Funding.** Each funding source, each plan's allowance, and the **Spending limits** table with how much of each limit is used.

## Related

- [Connect a Claude account](/guides/connect-a-claude-account): plan or API key, and how to connect each.
- [Agents and models](/guides/agents-and-models): several Claude plans, other AI accounts, and what waits when a plan is nearly used up.
- [Stopping work](/guides/stopping-work): pause one agent, or everything at once.
