---
path: /faq
title: FAQ
description: Short answers about what Boss Man is, what it costs, what you need to run it, and how safe it is.
group: Questions
order: 14
lead: Short answers to the questions people ask first.
---

## What is Boss Man?

A web app on your own machine where AI agents build your software. You collect feedback, rank features and plan the roadmap. Agents plan, write and review the work as tasks on a board ([what features and tasks are](/guides/how-boss-man-works#features-tasks-and-sub-tasks)), and when they need you, a card arrives on your Decisions page.

## What does it cost?

Boss Man is free and open source under the Apache 2.0 licence. You pay for your own machine and your own AI accounts.

## Which AI does it use?

The accounts you choose. Agents run Claude Code, Codex or OpenCode, so you can use a Claude Pro or Max plan, a ChatGPT plan, or an API key from Anthropic, OpenAI, OpenRouter, Ollama Cloud or Synthetic. You can mix them in one company.

## What happens when my Claude plan runs out?

Your agents pause, then carry on by themselves when the plan's allowance resets. You don't need to restart anything.

A Claude Pro or Max plan comes with a usage allowance that Anthropic sets and resets on its own schedule. Every agent on the plan draws from the same allowance. By default, Boss Man pauses routine work when 95% of it is used, and tells you. Chats with you and reviews keep running. When the allowance resets, the paused work starts again.

To see what is paused, look at your tasks. The board says **Held by the quota hold**, and the task's own page says which agent is paused and until when. To start one task anyway, choose **Run now**, or make it **Priority 1**.

If the pauses get in your way, you can:

- change the 95% level, or let urgent work carry on using your plan's extra usage, on **Settings > Funding**
- add a second Claude plan, so new work moves to whichever plan has room

Both are explained in [Agents and models](/guides/agents-and-models#when-a-plan-is-nearly-used-up).

## Why don't a project's tokens match its dollars?

Open the project's **Budget** tab (the same figures are under **Settings > Funding > Budgets**). There are two reasons the numbers look apart:

- **Cached tokens.** "In" counts new input only. Prompt text that is re-read or written to the cache shows on the **Cache read / written** line under each in / out figure. The dollar figures include it.
- **Subscription runs.** The token figures count every run, subscription runs included. The dollar figures are list-price estimates for API and credit runs only.

## How many agents should I start with?

Start with the CEO and one or two agents. All of them share one plan's allowance, so a small team gets more done before a pause. Once you know how far your plan goes, hire more on the **Agents** page.

## What do I need to run it?

A 64-bit Linux machine with Docker and Docker Compose v2, a GitHub or Gitea account, and an AI account: a Claude or ChatGPT plan, or an API key from Anthropic, OpenAI, OpenRouter, Ollama Cloud or Synthetic. You need to be comfortable copying commands into a shell. Plan on 16 GB of memory for one company with the default settings, or 8 GB if fewer agents run at once: see [What machine do I need](/guides/install-boss-man#what-machine-do-i-need).

Why Linux? The install and update scripts expect it, and two safety features use the Linux kernel: the network guard keeps agents off your home network, and the agent fence keeps each agent in its own folder. Settings shows whether each one is working on your machine.

Mac and Windows: not supported yet, but we're testing Docker Desktop. On a Mac with Apple silicon, the agent fence already works under Docker Desktop. The network guard isn't proven there yet, and Windows hasn't been tested. For now, use a Linux machine.

Ready-made images for x86 and ARM machines come after the alpha.

## Is my code safe?

Boss Man runs on your machine. There is no hosted service, so nothing passes through us. Your code goes only to your git host, and prompts only to your AI accounts. Secrets are encrypted with a master key only you hold, and agents get them only for their runs.

## Can agents push code or delete things without me?

Pushing, publishing and destructive commands come to you as a permission card. Deleting the agent's own entries in /tmp runs at once. Other clean-ups, and deletes in the agent's own folder, go to the CEO first, and the CEO can allow them without you. If the CEO does not settle one within five minutes, it comes to you. Approved work merges only after a review and any checks you set for the project. By default, high and critical work also waits for your sign-off.

## Can I use it from my phone?

Yes. On your home network, open it in your phone's browser. With Tailscale you can reach it from anywhere and install it as an app. Notifications reach your phone through your own ntfy server.

## Can several people log in?

No. There is one owner account, which controls every company on the server.

## Is there a hosted version?

No. Boss Man is self-hosted only.

## How is it different from Paperclip?

Boss Man was inspired by Paperclip and written from scratch. It does not depend on Paperclip. You can move a company over from Paperclip: see [`docs/14-paperclip-migration.md`](@repo/blob/main/docs/14-paperclip-migration.md).

## Is it ready to use?

It is in alpha. Boss Man's own agents build Boss Man, and some parts are still rough. Keep it off the open internet.

## Where do I ask for help?

On GitHub. Open an issue and say which step of which guide you are on.
