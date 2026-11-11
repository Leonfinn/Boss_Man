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
| Claude Code | a Claude Pro or Max plan (with a setup-token), an Anthropic API key, or an LLM gateway such as OpenRouter |
| Codex | an OpenAI API key, or a ChatGPT plan |
| OpenCode | an OpenRouter, Ollama Cloud or Synthetic key, an OpenAI or Anthropic key, or another OpenAI-compatible service |

**Another OpenAI-compatible service.** OpenCode can use any service that speaks the OpenAI API. Add it under **Settings > Secrets** with the kind **Other**, named `OPENCODE_CONFIG_CONTENT`, whose value describes the service. **Settings > Funding > What the provider controls** shows an example for Ollama on your own machine. (Unverified: this route was not tried end to end for this guide, and the runner's network guard may refuse a service on your home network.)

Through OpenRouter, Claude Code can be pointed at models that are not Claude. Boss Man marks those "(not Claude: may not work)".

## Add an account

1. Open **Settings > Secrets**.
2. Under **Add**, choose the kind: **Claude setup-token**, **Anthropic API key**, **OpenAI API key**, **OpenRouter API key**, **Ollama Cloud API key** or **Synthetic API key**.
3. Paste the value and save. Boss Man encrypts it and never shows it again.
4. Add a funding source under **Settings > Funding** for it, so Boss Man can track what each agent spends.

For a Claude plan, run `claude setup-token` on your own computer and paste the token it prints.

![How a run picks an account and when work pauses: an API key just runs; a Claude plan is chosen in your order; at the hold level routine work waits, chats and reviews carry on, and your extra-usage setting decides whether urgent or all work carries on past the limit using credit.](/img/which-account-and-hold.svg =1160x640 narrow=/img/which-account-and-hold-narrow.svg:360x1190 "Which account a run uses, and what waits when a plan is nearly used up.")

## Synthetic

Synthetic (synthetic.new) is a model provider for OpenCode agents. Add its key as **Synthetic API key**. Its models are named `synthetic/<model>`. Add a funding source with the kind **Subscription (setup-token)** and the provider **Synthetic**.

The Funding page shows how much of the plan's weekly credits are used. Credits come back 2% at a time. Boss Man reads this at most every 5 minutes. You get a notification at 60%, 80% and 92% used.

At **Hold routine work at** (95% unless you change it), Boss Man pauses routine work on the plan and tells you. Chats and reviews keep running. Agents on Synthetic's Infinite mode (`infinite:` models) don't spend the credits and are never paused.

If your Synthetic account has paid top-up credit, Synthetic spends it once the weekly credits are used. Choose what happens then under **I have top-up credit** on the plan's card:

- **Hold everything at the limit** (the default): routine work waits for credits to come back; urgent tickets run until the limit. Use this if the account has no top-up credit.
- **Keep urgent work running on top-up credit**: routine work still pauses; urgent tickets, chats and reviews carry on past the limit.
- **Keep all work running on top-up credit**: nothing pauses. You get one notification a week when work starts drawing on top-up credit.

Synthetic doesn't tell Boss Man the top-up balance, so Boss Man can't show it or stop before it runs out. Check it at synthetic.new. When it runs out, Synthetic refuses the runs.

## Hire an agent

Open **Agents** and choose **Hire**. Pick a role under **Start from**, or **Blank** to write the job yourself. The roles are:

- most capable model: Senior Developer, Security Reviewer, Adversarial Reviewer, Senior Infrastructure Engineer
- balanced model: Engineer, Researcher, Designer, QA, Writer, Product Manager, Data & Analytics
- fast model: Scrum Master, Assistant, Release Manager, Support

## Choose a model

The **Model** list starts with **Default**, which uses the agent program's own default. Below that are the models the runner reports for that agent program, and the models your API key offers. Choose **Other…** to type a model name yourself. If the list is empty, choose **Refresh models**.

## Choose a thinking level

**Thinking** sets how hard the model thinks before it answers: Default, Low, Medium, High, Extra high or Max. Not every model offers every level. A level the model does not offer is left at the model's default.

## Changes the CEO proposes

The CEO can propose new hires and model changes. They come to Decisions and wait for you. For a hire, choose **Hire the ticked ones** or **Not now**. For a model change, choose **Approve**, **Edit** or **Reject**.
