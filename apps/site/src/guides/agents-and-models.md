---
title: Agents and models
description: Choose an agent program, add an AI account, hire an agent, and pick its model and thinking level.
group: Set it up your way
order: 5
lead: Each agent runs one of three agent programs, with a model and a thinking level you choose. This guide covers the AI accounts you can use and how to set each agent up.
---

![The Agents page in Boss Man, listing each agent with its job and model.](/img/agents-crop.webp =2300x774 "The Agents page. Each agent has a job, a model and its own instructions.")

## Agent programs and accounts

| Agent program | Accounts it can use |
|---|---|
| Claude Code | a Claude Pro or Max plan (with a setup-token), an Anthropic API key, an LLM gateway such as OpenRouter, Amazon Bedrock or Microsoft Foundry |
| Codex | an OpenAI API key, or a ChatGPT plan |
| OpenCode | an OpenRouter, Ollama Cloud or Synthetic key, an OpenAI or Anthropic key, an Ollama Cloud or Synthetic plan, or another OpenAI-compatible service |

**Another OpenAI-compatible service.** OpenCode can use any service that speaks the OpenAI API. Add it under **Settings > Secrets** with the kind **Other**, named `OPENCODE_CONFIG_CONTENT`, whose value describes the service. **Settings > Funding > What the provider controls** shows an example for Ollama on your own machine. (Unverified: this route was not tried end to end for this guide, and the runner's network guard may refuse a service on your home network.)

Through OpenRouter, Claude Code can be pointed at models that are not Claude. Boss Man marks those "(not Claude: may not work)".

## Add an account

1. Open **Settings > Secrets**.
2. Under **Add**, choose the kind: **Claude setup-token**, **Anthropic API key**, **OpenAI API key**, **OpenRouter API key**, **Ollama Cloud API key** or **Synthetic API key**.
3. Paste the value and save. Boss Man encrypts it and never shows it again.
4. Add a funding source under **Settings > Funding** for it, so Boss Man can track what each agent spends.

For a Claude plan, run `claude setup-token` on your own computer and paste the token it prints. [Connect a Claude account](/guides/connect-a-claude-account) walks through it step by step, and helps you choose between a plan and an API key. For limits and where to see spend, see [What agents cost](/guides/what-agents-cost).

![How a run picks an account and when work pauses: an API key just runs; a Claude plan is chosen in your order; at the hold level routine work waits, chats and reviews carry on, and your extra-usage setting decides whether urgent or all work carries on past the limit using credit.](/img/which-account-and-hold.svg =1160x640 narrow=/img/which-account-and-hold-narrow.svg:360x1190 "Which account a run uses, and what waits when a plan is nearly used up.")

## When a plan is nearly used up

A plan (Claude, ChatGPT, Ollama Cloud or Synthetic) has a usage allowance. Boss Man calls the pause near the end of it the quota hold. An API key has no hold: its runs just start.

Each plan's card on **Settings > Funding** has the hold settings, under **When the subscription is nearly used up**:

- **Hold routine work at**: a percentage from 80 to 100. The default is 95. At this level Boss Man pauses routine work on the plan and tells you. Chats and reviews keep running.
- **I have extra usage** (on a Synthetic plan, **I have top-up credit**): what happens once the plan is at the hold level.
- **Which limits can trigger the hold**: untick a window so it never pauses work.

In the choices below, urgent work means tickets marked **Priority 1**.

| Choice | Routine work | Priority 1 tickets |
|---|---|---|
| **Hold everything at the limit** (the default) | waits | runs until the limit itself, then waits. It also waits if the plan is already using extra usage. |
| **Keep urgent work running past the limit** (Synthetic: **Keep urgent work running on top-up credit**) | waits | carries on past the limit, paid from extra usage or top-up credit |
| **Keep all work running** (Synthetic: **Keep all work running on top-up credit**) | carries on | carries on |

Chats and reviews always carry on. Use the default if the account has no extra usage or top-up credit. Boss Man can't see your extra-usage balance, so set a spending limit in your Claude account.

Agents on Synthetic's Infinite mode (`infinite:` models) are never held, because those runs don't spend the plan's credits. Another agent on the same plan with a normal model is still held.

## Several Claude plans

If you have more than one Claude plan, Boss Man can move new runs between them.

1. Add each plan's setup-token under **Settings > Secrets** (kind **Claude setup-token**).
2. On **Settings > Funding**, add a funding source for each plan with the kind **Subscription (setup-token)** and the provider **Anthropic**.
3. On each plan's card, under **Switch between Claude accounts**, set **Order** (1 is used first) and choose its token under **Login for this account**. Save.

Each new run then goes to:

1. the first plan in your order that is under its hold level;
2. if none is, the first plan whose extra-usage setting still allows the work. So extra usage is spent only when no plan has room;
3. if no plan allows it, nothing: the run waits for the plan that frees up first.

Your first plan is used again as soon as its window resets. Runs already going finish on the plan they started on.

A plan with an empty **Order** is left out of the list. An agent whose funding source has no order can't switch to the ranked plans, and Boss Man says so when it holds that agent's work. A plan after the first with no login is skipped.

## Synthetic

Synthetic (synthetic.new) is a model provider for OpenCode agents. Add its key as **Synthetic API key**. Its models are named `synthetic/<model>`. Add a funding source with the kind **Subscription (setup-token)** and the provider **Synthetic**.

The Funding page shows how much of the plan's weekly credits are used. Credits come back 2% at a time. Boss Man reads this at most every 5 minutes. You get a notification at 60%, 80% and 92% used.

The quota hold works as in [When a plan is nearly used up](#when-a-plan-is-nearly-used-up). If your Synthetic account has paid top-up credit, Synthetic spends it once the weekly credits are used. Choose what happens then under **I have top-up credit** on the plan's card. With **Keep all work running on top-up credit**, you get one notification a week when work starts drawing on top-up credit.

Synthetic doesn't tell Boss Man the top-up balance, so Boss Man can't show it or stop before it runs out. Check it at synthetic.new. When it runs out, Synthetic refuses the runs.

## Hire an agent

Open **Agents** and choose **Hire**. Pick a role under **Start from**, or **Blank** to write the job yourself. The roles are:

- most capable model: Senior Developer, Security Reviewer, Adversarial Reviewer, Senior Infrastructure Engineer
- balanced model: Engineer, Researcher, Designer, QA, Writer, Product Manager, Data & Analytics
- fast model: Scrum Master, Assistant, Release Manager, Support

Choose what pays for it under **Paid from**.

## Choose a model

The **Model** list starts with **Default**, which uses the agent program's own default. Below that are the models the runner reports for that agent program, and the models your API key offers. Choose **Other…** to type a model name yourself. If the list is empty, choose **Refresh models**.

## Choose a thinking level

**Thinking** sets how hard the model thinks before it answers: Default, Low, Medium, High, Extra high or Max. Not every model offers every level. A level the model does not offer is left at the model's default.

## Changes the CEO proposes

The CEO can propose new hires and model changes. They come to Decisions and wait for you. For one hire, choose **Hire** or **Don't hire**. For a team, tick who you want and choose **Hire the ticked ones**, or **Not now**. For a model change, choose **Approve**, **Edit** or **Reject**.
