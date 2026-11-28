---
title: The watchdog
description: What the watchdog watches, when it hands a stuck task to the Scrum Master, when it asks you, and where to change it.
group: Everyday use
order: 8
lead: The watchdog checks every few minutes that no task is stuck. When one is, it hands it to the Scrum Master, an agent that nudges whoever can unstick it.
---

## In short

The watchdog is a set of simple rules that Boss Man runs over the board every few minutes. It uses no AI and costs nothing. When a task looks stuck, it wakes the **Scrum Master**, an agent you hire, to sort it out.

The watchdog is on for every new company, but it reaches nobody until you pick a Scrum Master: nobody is nudged, and the board shows no **Looks stuck** tags. See [Set it up](#set-it-up).

## What it watches

A task looks stuck when, for example:

- nobody is assigned to it for 15 minutes
- it has not moved in **In progress** or **Review** for 2 hours
- it has sat in **Blocked** for 8 hours with nothing changing
- the agent's last run crashed, or ended without moving it
- it keeps going back and forth between review and changes
- it waits on a card from you

These are the default times. You can change each one.

## What the Scrum Master does

The Scrum Master can only do a few things: nudge an agent, give unassigned work to someone, wake an agent again, chase a review, put a flag off for a while, pass the problem to the CEO, or ask you. It cannot do the work itself.

Every action is listed under **Activity > Scrum Master log**, with the reason, and can be undone.

## When it asks you

- **A card waits on you.** If a task has waited 8 hours for your answer on Decisions, Boss Man reminds you once. After that, the daily summary carries it.
- **Nobody else could sort it out.** Boss Man's own alerts, such as a run that has sent nothing for a long time, go to the Scrum Master first, then the CEO, then you. An alert moves up a level when nobody settles it in 30 minutes. Without a Scrum Master it starts at the CEO. When it reaches you, it is a card on Decisions.
- **It hit its own limit.** The Scrum Master may only run a few times an hour. If it reaches that limit, the watchdog pauses until the hour ends, then carries on by itself, and tells you.

## Set it up

1. Hire a Scrum Master: open **Team > Agents**, choose **Hire** and start from the **Scrum Master** role.
2. Open **Settings > Watchdog**.
3. Under **Scrum Master**, pick the agent you hired, and choose **Save**.
4. If the line under the heading says **Off.**, choose **Switch on**.

To try it without it reaching anyone, tick **Record only (rehearse)**. It then writes down what it would have done. To see how often it would have stepped in, choose a period under **Test the rules against** and choose **Run the test**.

## Related

- [The board and Decisions](/guides/board-and-decisions#looks-stuck): what **Looks stuck** on the board means.
- [Decisions](/guides/decisions): answering the cards that reach you.
