---
title: The board and Decisions
description: Read the board's columns and review lanes, use the ticket page, and answer the cards on the Decisions page.
group: Everyday use
order: 4
lead: The board shows every ticket in a project. Decisions shows everything that needs your answer. This guide explains both.
---

![The board and the Decisions page: tickets move across the board's columns as agents work, and anything that needs you arrives as a card on Decisions.](/img/board-and-decisions.svg =1160x760 narrow=/img/board-and-decisions-narrow.svg:360x1160 "Tickets move across the board, and what needs you arrives on Decisions.")

## The board's columns

Open **Projects** and choose a project. Tickets sit in six columns:

- **Backlog**: written but not started
- **Ready**: ready for an agent to pick up
- **In progress**: an agent is working on it
- **Blocked**: waiting on something, such as another ticket or your answer
- **Review**: waiting for review or merging
- **Done**: merged or closed

![A close-up of the Boss Man board with tickets in its columns, from Backlog on the left to Done on the right.](/img/board-crop.webp =2400x875 "The board. New tasks wait in Backlog until they can start, then move right as agents work on them.")

You can rename a column with its pencil. Agents still see the fixed state, shown under the name as "Agents see:".

## The three review lanes

The Review column splits into three lanes:

- **Awaiting review**: an agent has finished and asked for review
- **Approved, merging**: every reviewer approved, and Boss Man is checking and merging it
- **Your review**: tickets from any column that are waiting on you

A card in Your review has a button: **Review and approve** for a sign-off, or **Answer in Decisions** for a question. A strip at the top of the board says how many tickets wait on you.

## The ticket page

Open a ticket to see its description, Done when lines with each pass or fail, the conversation, the review and the activity. On the ticket page you can also:

- tick **Urgent**, which puts it first in the merge queue. An urgent ticket also keeps running when Boss Man pauses routine work because a subscription plan is nearly used up (the quota hold).
- tick **Doesn't need code changes** for research, wiki or docs work, so it can close with no change to the repository
- write steps under **After it goes live, you'll need to**, for something you must do once the change is live

## Decisions

Open **Decisions** in the sidebar. The number beside it counts only the cards that need you now. Cards in "Waiting, nothing to do yet" are not in that number: the page heading shows them separately, for example "3 decisions to do · 2 waiting".

Each card shows what kind it is (Plan, Permission, Approval, Question, Stale blocker, Stalled run and others), what is being asked and the options.

Cards are newest first, with these exceptions:

- steps you need to do by hand come first
- an urgent Boss Man update, one that carries the fix for a problem on your live server, also goes to the top
- cards waiting on an agent sit at the bottom under "Waiting, nothing to do yet"

Each card shows a score for how much it holds up: what it blocks, how soon it is due and how long it has waited. The score does not change the order.

## Answering a card

![A Decisions card showing what is being asked, what the agent already tried, a recommended option and the option buttons.](/img/card-wide.webp =1600x567 "A Decisions card, with its options as buttons.")

1. Read the card. It says what the agent wants, what it already tried and which option it recommends.
2. Choose an option button.
3. Or choose **Write my own answer**, type it, and choose **Send my answer**.
4. If you need more, choose **Not enough detail?**, then **Ask the CEO for advice**.

If you run more than one company, the **All companies** filter shows cards from every company together.
