---
title: Deploys
description: For companies that publish something, such as a website. What a deploy target is, how to add one, and who approves each deploy.
group: Set it up your way
order: 11
lead: A deploy puts a new version live where people use it, such as your website. You only need this page if your agents build something that goes live.
---

## Do you need this?

Only if your agents build something that goes live somewhere, such as a website or an app. If your company writes reports, research or other documents in the wiki, there is nothing to deploy. Skip this page.

## What a deploy target is

A deploy target is a place where agents may put their work live, such as "Production" for your real website or "Staging" for a test copy. Each target has a name, a kind and an address:

| Kind | Address, for example |
|---|---|
| **SSH host** | `deploy@example.com` |
| **Docker endpoint** | `tcp://socket-proxy:2375` |
| **Git remote** | `https://git.example.com/you/app.git` |

An agent can only deploy to a target you added. Without a target, nothing goes live.

## Who approves a deploy

You choose this for each target:

- **Production** (tick box): you approve every deploy, and high and critical risk work must go to a staging target first.
- **Requires approval** (tick box): you approve every deploy, without the staging rule.
- **Neither**: a deploy starts straight away, with no card.

When a deploy needs you, an **Approval** card comes to Decisions, such as "Sam wants to deploy main (ships 3f2a9c1) to Production (production)." Choose **Approve** or **Reject**.

## Add a deploy target

1. Open **Settings > Tools and deploys** and find **Deploy targets**.
2. Under **Add a deploy target**, type a **Name**, choose a **Kind** and type the **Address**.
3. Tick **Production** for your live site, or **Requires approval** for a target you still want to approve.
4. Choose **Add target**.

A secret kept for a target, shown on the **Secrets** page as "only for deploys to" the target, is given only to the agent's run that carries out an approved deploy, and only while it runs.

The targets table shows each target's approval rule and its last successful deploy.

## Related

- [Review and risk](/guides/review-and-risk): what high and critical risk mean.
- [Decisions](/guides/decisions): answering the deploy card.
