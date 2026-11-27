---
title: "What agents cost: funding sources and limits"
description: How Boss Man tracks what your agents spend, which limits you can set, what happens when one is reached, and where to see the figures.
group: Start here
order: 4
lead: Your agents' work is billed by whichever account they run on. A funding source is Boss Man's record of that account, so it can show what the work costs and stop it before it runs away.
---

## A funding source is the account agents run on

When you connect an account in the setup wizard, Boss Man also makes a **funding source** for it: the same account, with a name, and a note of whether it is a fixed monthly plan or pay as you go. Every run is counted against the funding source of the agent that did it.

You can see and change them under **Settings → Funding**. An existing company keeps what it has; connecting a second account adds a second funding source.

## Limits you can set

- **Where the account sets one.** An API account has its own monthly spend limit and credit balance, on the provider's website (Anthropic's Console, for example). Once agents reach that limit, the provider refuses their work until the next month or until you raise it.
- **Per task.** A project can have a cap on what one task may cost in API or credit runs. When a task reaches it, the agents stop and ask you.
- **Per project, per month.** A project can have a monthly cap too, for the same kind of runs.
- **A plan's allowance.** A Claude plan's usage resets every 5 hours and every week. Boss Man sees how much of it is used and can pause routine work before it runs out.

Runs paid from a fixed monthly plan are left out of the dollar figures: the plan's price doesn't change with use, so its limits are the allowance, not money.

## What happens at a limit

Work pauses rather than failing. Boss Man stops starting new runs on that account, tells you what was reached, and asks how to carry on: wait for the reset, raise the limit, or move the work to another account. Work already finished is not lost.

## Where to see the spend

- **Funding** shows each funding source, what it has used and what is left.
- **A project's Budget tab** shows that project's cost for API and credit runs, with its caps.
- **The Spend report** adds it up by day and by project.

The figures are estimates at list price, not a bill: the provider's website is the final word on what you are charged.
