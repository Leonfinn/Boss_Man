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
- **Blocked**: waiting, with nothing to work on yet (see [What Blocked means](#what-blocked-means))
- **Review**: waiting for review or merging
- **Done**: merged or closed

![A close-up of the Boss Man board with tickets in its columns, from Backlog on the left to Done on the right.](/img/board-crop.webp =2400x875 "The board. New tasks wait in Backlog until they can start, then move right as agents work on them.")

You can rename a column with its pencil. Agents still see the fixed state, shown under the name as "Agents see:".

## What Blocked means

Blocked holds every ticket that is only waiting. A ticket can be Blocked when:

- it waits on another ticket
- a card on Decisions is open for it, including a plan card
- it waits until a set date and time
- it is merged and its after-merge checks wait for the change to go live

A plan card moves its ticket to Blocked by itself. When the plan is answered, the ticket is free to carry on. A merged ticket that waits to go live also moves to Blocked, and goes back to In progress when it is live and the checks can be made.

An agent cannot move a ticket to Blocked unless one of these is true. Blocked tickets never count towards the in-progress limits.

## In-progress limits

An in-progress limit stops agents starting more work than they can finish. Open **Settings > Server and runner > Limits and checks**. Find **Tickets in progress**. There are two limits:

- **Tickets in progress per agent**: 2 by default, one being worked and one waiting on its check
- **Tickets in progress, whole company**: off by default

Leave a box empty for no limit.

You can also hold new starts while the merge line or the quick-check queue is long: **Hold new starts while this many merges are waiting** and **Hold new starts while this many quick checks are queued**. Both are off by default. If the merge line grows for an hour with no merge limit set, the merge banner says "Start brake off" and suggests a number ([Guide 7](/guides/reviews-and-merge-queue#the-merge-banner)).

When an agent is at its limit, a new ticket for it waits in Ready. Its note says, for example, "Waiting: Soo is at the limit of 2 in-progress tickets; starts when one finishes." It starts by itself when one of that agent's tickets moves to Review, Done or Blocked.

The limit never holds work that was already started, such as a ticket sent back with changes requested. A **Priority 1** ticket may start even when the agent is at its limit.

Some tickets in In progress cannot move, so they do not count. Each one shows the reason on the board:

- **Not counted: waits on** a ticket, with that ticket's reference
- **Not counted: plan with owner**, when its plan waits for approval
- **Not counted: merged, waiting to go live**

## The three review lanes

The Review column splits into three lanes:

- **Awaiting review**: an agent has finished and asked for review
- **Approved, merging**: every reviewer approved, and Boss Man is checking and merging it
- **Your review**: tickets from any column that are waiting on you

A card in Your review has a button: **Review and approve** for a sign-off, or **Answer in Decisions** for a question. **Answer in Decisions** opens Decisions at that exact card, highlighted. If the card was answered or withdrawn in the meantime, Decisions says "That card is not open any more" instead.

A strip at the top of the board says how many tickets wait on you.

## The ticket page

Open a ticket to see its description, Done when lines with each pass or fail, the conversation, the review and the activity.

If the ticket waits on cards from you, they are listed at the top under "Waiting on your decision", each with an **Answer in Decisions** button.

On the ticket page you can also:

- tick **Priority 1**. The ticket goes first in the check queue and the merge line, and keeps running when a plan is nearly used up (the quota hold). You get one alert when it is ready to go live.
- tick **Doesn't need code changes** for research, wiki or docs work, so it can close with no change to the repository
- under **After it goes live**, write what you must do once the change is live, one step per line. When the change is live, a card on Decisions brings these steps to you. It names the ticket that went live, says why the steps matter and what happens if you skip them, then lists the steps.

## Decisions

Open **Decisions** in the sidebar. The number beside it counts only the cards that need you now. Cards in "Waiting, nothing to do yet" are not in that number: the page heading shows them separately, for example "3 need you · 2 with the team". Alerts the team is still handling are folded under **Being handled by the team**.

Each card shows what kind it is (Plan, Permission, Approval, Question, Stale blocker, Stalled run and others), what is being asked and the options.

Each card also says which project it is for, or **Company-wide** when it is not about one project. When cards come from more than one project, chips at the top filter the list: **All projects**, one chip per project, and **Company-wide**. Decisions remembers your choice in this browser. If no open card belongs to the project you chose any more, the list goes back to **All projects**.

Cards are newest first, with these exceptions:

- steps you need to do by hand come first
- an urgent Boss Man update, one that carries the fix for a problem on your live server, also goes to the top
- cards waiting on an agent sit at the bottom under "Waiting, nothing to do yet"

Small labels at the top of a card say why it matters:

- **Moss is waiting on you**: the agent named is paused until you answer
- **Holds up BOS-12**: the ticket this card blocks, with **+2 more** if it blocks others too
- **Due 14 Nov**: the date the answer is due

A card with none of these labels holds nothing up. The labels do not change the order.

### Being re-checked

An amber **Being re-checked** strip means someone is confirming the card is still needed, for example because the work moved on since it was raised. If it is not needed, the card closes by itself. You can still answer it now.

A red **Not re-checked** strip means nobody re-checked the card in time. It says who should have.

## Answering a card

![A Decisions card showing what is being asked, what the agent already tried, a recommended option and the option buttons.](/img/card-wide.webp =1600x567 "A Decisions card, with its options as buttons.")

1. Read the card. The heading is the question. The text under it says what the agent wants and what it already tried. A card that asks you to do steps starts with three lines: **Why** it matters, **Where** you do the steps, and **How long** they take, for example "About 5 minutes".
2. Look under **Your answer**. The recommended button is marked **Recommended**. On plan, sign-off, permission and stalled-run cards, a line under each button says what happens if you press it.
3. Choose a button.
4. Or, on a question card, choose **Write my own answer**, type it, and choose **Send my answer**.
5. If you need more, choose **Not enough detail?**, then **Ask the CEO for advice**.

On a plan or sign-off card, a note box sits under the buttons. What you type there is sent with **Keep planning** or **Send it back**.

If you run more than one company, the **All companies** filter shows cards from every company together.

### The sign-off card

For high and critical work, the sign-off card lists what was checked, so you can decide without opening the ticket:

- **Reviews**: each reviewer and their verdict, such as "✓ Passed" or "✗ Changes asked"
- **Quick check**: whether the agent's last quick check passed, on which commit and when
- **Change**: how many files changed, and the risk level
- **Built by**: the agent who built it, with a link to the ticket

**Approve and merge** runs the full check and merges the work. If that check fails, the ticket goes back to the agent, not to you. **Send it back** returns it to the agent with your note, and the reviews start again when it comes back.

### Closed cards

When a card leaves your list before you answer it, for example because the update is already live, a newer card replaced it or the agent withdrew it, the card shows for 2 hours under **Left your list recently**. Each line says why it left. If a newer card replaced it, choose **Open the newer card ›** to go to it.

Cards closed in the last 30 days are folded at the bottom under **Closed in the last 30 days**. Each line starts with what happened: **Answered**, **Allowed**, **Denied**, **Withdrawn** or **Replaced**.

A plan marked **Replaced** says who wrote the newer plan and when. Choose **Open the newer card** to go to it.
