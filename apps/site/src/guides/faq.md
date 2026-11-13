---
path: /faq
title: FAQ
description: Short answers about what Boss Man is, what it costs, what you need to run it, and how safe it is.
group: Questions
order: 13
lead: Short answers to the questions people ask first.
---

## What is Boss Man?

A web app on your own machine where AI agents build your software. You collect feedback, rank features and plan the roadmap. Agents plan, write and review the work as tasks on a board ([what features and tasks are](/guides/how-boss-man-works#features-tasks-and-sub-tasks)), and when they need you, a card arrives on your Decisions page.

## What does it cost?

Boss Man is free and open source under the Apache 2.0 licence. You pay for your own machine and your own AI accounts.

## Which AI does it use?

The accounts you choose. Agents run Claude Code, Codex or OpenCode, so you can use a Claude Pro or Max plan, a ChatGPT plan, an Anthropic key, or any OpenAI-compatible API key, such as OpenRouter, Synthetic or Ollama. You can mix them in one company.

## What do I need to run it?

A 64-bit Linux machine with Docker and Docker Compose v2, a GitHub or Gitea account, and an AI account: a Claude or ChatGPT plan, or any OpenAI-compatible API key. You need to be comfortable copying commands into a shell. Each company's runner uses up to 4 GB of memory by default.

Why Linux? The install and update scripts expect it, and two safety features use the Linux kernel: the network guard keeps agents off your home network, and the agent fence keeps each agent in its own folder. Settings shows whether each one is working on your machine.

Docker Desktop on Mac and Windows isn't supported yet. Both safety features should work on Docker Desktop 4.60 or newer, and we're testing it. Ready-made images for x86 and ARM machines come after the alpha.

## Is my code safe?

Boss Man runs on your machine. There is no hosted service, so nothing passes through us. Your code goes only to your git host, and prompts only to your AI accounts. Secrets are encrypted with a master key only you hold, and agents get them only for their runs.

## Can agents push code or delete things without me?

Pushing, publishing and destructive commands come to you as a permission card. Deleting temp files, or files in the agent's own folder, goes to the CEO first instead, and the CEO can allow it without you. If the CEO does not settle it within five minutes, it comes to you. Approved work merges only after a review and any checks you set for the project. High and critical work also waits for your sign-off.

## Can I use it from my phone?

Yes, over Tailscale. Boss Man's page works in a phone browser, and with Tailscale's HTTPS address you can install it as an app. Notifications reach your phone through your own ntfy server.

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
