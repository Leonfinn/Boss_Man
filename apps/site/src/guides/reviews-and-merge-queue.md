---
title: Reviews and the merge queue
description: How a change is reviewed by risk level, what the merge queue shows, what happens when a check fails, and how checks after the merge work.
group: Everyday use
order: 7
lead: Every change an agent makes is reviewed by another agent, then checked and merged by Boss Man. The ticket's risk level decides who reviews it and whether you sign it off.
---

![A ticket's path from review to live: review by risk level, your sign-off for high and critical work, the merge line, the merge check with a way back to the agent, the merge, then go-live and the after-merge checks.](/img/review-to-live.svg =1160x600 narrow=/img/review-to-live-narrow.svg:360x1330 "From review to live: a change is reviewed, checked and merged, then waits until it is running before its last checks.")

## Risk levels

| Risk | Plan approved by | Reviewed by | Your sign-off |
|---|---|---|---|
| Trivial | no plan | CEO | no |
| Low | CEO | CEO | no |
| Medium | CEO | Senior developer | no |
| High | you | Senior developer | yes |
| Critical | you | Senior developer | yes |

If the company has no senior developer, the CEO reviews instead. A ticket with no risk level counts as medium. High and critical work also runs the project's deeper check before merging, and gets a security review, by the CEO unless you name someone else.

The table is a starting point. In **Settings > Reviews**, you can change who approves the plan and who reviews the code at each level, and turn on extra reviews: **Security review**, **Infrastructure review** and **Adversarial review**. Each can name one agent or several. All the reviews a ticket needs must approve before it merges. To give one project its own rules, open it on the **Projects** page and use **Reviews for this project**.

## What a review checks

Before an agent can ask for review, it must report pass or fail against each Done when line. The reviewer reads the change, the line-by-line diff and the Done when results. Then it approves or sends the ticket back with comments.

If you review a ticket yourself, open it and choose **Approve and merge** (or **Approve and open a pull request**), or **Request changes**. With changes requested, you can add a one-line lesson. The CEO decides whether it goes into the project's brief, and you are told the outcome.

## When reviews go round in circles

Boss Man stops a ticket and asks you what to do when:

- the same review finding comes back three times
- it has been through more than three review rounds
- the same failure happens three times in two hours

The card offers options such as **Send it back anyway** and **Stop work on it**.

## The merge queue

Once every reviewer approves, the ticket moves to Approved, merging, and joins the merge queue. Open **Merge queue** in the sidebar.

The top of the page says what needs attention, as coloured labels you can choose:

- **2 need you**: work that waits on your answer
- **Main is red: 3 checks held**: the main branch is failing its check (see [Queued checks](#queued-checks))
- If a fix for main is on its way, approved tickets wait behind it. The label names the fix.
- **1 check failed**: a merge check failed and Boss Man is trying again
- **1 stuck over an hour**: work that has not moved for over an hour

If none of these apply, it says "Nothing needs you. Everything here is moving by itself."

Each tab shows a count: **Merges** counts work waiting to merge or being checked, and **Queued checks** counts the checks. The count turns amber when something on that tab needs you or is held.

The **Merges** tab shows:

- **Needs you**: only when something waits on you. Each item has a button straight to its card, such as **Open the sign-off** or **Open the stopped check**.
- **Running now**: the checks in progress, and how many check slots are busy. A check running for over an hour is marked **over an hour**.
- **Waiting to merge**: in the order they will go, Priority 1 work first, then the longest wait. Choose **Move to front** to put a waiting merge next in line.
- **Recently finished**: the last three, each marked **merged** or **check failed**. Choose **Show 2 more** (or however many there are) to see the rest.

Each row in Waiting to merge has one state word:

| Word | Meaning |
|---|---|
| **Needs you** | It waits on your answer, usually your sign-off. |
| **Check failed** | Its merge check failed and Boss Man is trying again. |
| **Stuck** | It has not moved for over an hour. |
| **Checking** | Its check is running. |
| **Held** | It waits on something else, such as another ticket, a card or the host. |
| **Waiting** | It waits for its turn. |

The row then says what is happening and who is acting. If a card holds the work, the row names the card and who raised it, with a link to open it.

On each ticket, Boss Man runs the check you chose for the project under **Before merging, Boss Man will**. If it passes, Boss Man merges the branch or opens a pull request, as your project is set. If you chose **Nothing: merge after review only**, it merges straight after the review.

### Queued checks

The **Queued checks** tab lists every check that is running or waiting on the company's runner, not only merge checks. Running checks come first, then waiting ones in the order they will start. Each row shows:

- its place in the line, and the ticket
- **Running**, **Waiting** or **Held**
- the kind: **merge check**, **quick check** (an agent checking its own work) or **full check**
- who asked for it, and how long it has run or waited

When the main branch is failing its check (main is red), new checks are **Held** and cannot start. One red banner above the list says how many are held and, if a ticket that fixes main is queued, links to it. A check marked **fixes main** is for that ticket, and it still runs.

When nothing is queued, the tab says "No checks queued" and how many slots are free.

The line at the top says how many check slots are in use. You set the number under **Settings > Server and runner > Limits and checks**, in **Checks at once**. The tab is read-only.

The full list needs **Boss Man runs them** under **Who runs the checks** in the same place. With **Each agent runs its own**, the tab shows only the checks Boss Man already knows about.

## When the check fails

The ticket goes back to in progress, and the agent is told which command failed. It fixes the problem and asks for review again. Boss Man also sends a ticket back if it has merge conflicts, or if it changed nothing and is not marked as needing no code changes.

## Your sign-off

For high and critical work, a card asks whether to merge after the reviewer approves. It lists the reviews, the last quick check and how many files changed ([Guide 4](/guides/board-and-decisions#the-sign-off-card)). Choose **Approve and merge** or **Send it back**. The ticket also shows in the Your review lane on the board, and under **Needs you** on the Merge queue page.

## After it goes live

Some Done when lines can only be checked on the running system, such as "the health check returns 200". When you write the ticket, or later on the ticket page, tick those lines under **On a real host (checked after merge)**. The ticket page then marks them "on a real host, checked after merge". Reviewers skip these lines, so they never hold up a review.

After the merge, the ticket stays open until each of these checks has a pass or fail:

1. If the change is not live yet, the ticket waits in **Blocked**. The ticket page says what it waits for, such as "waiting for go-live: the server update". On the board it shows **Not counted: merged, waiting to go live**, so it does not take one of the agent's in-progress places.
2. When the change is live, Boss Man moves the ticket to **In progress** and wakes the agent to make the checks.
3. The agent reports pass or fail for each one, then closes the ticket. It cannot close it before then.

If a check fails on the live system, Boss Man opens a follow-up ticket for it, assigned to the same agent.

### When a card asks you to make the check

If only you can make a check, the agent sends you a card. When it raises the card, the agent must say what each answer means: pass, fail or not checked. Boss Man records only that. It does not guess from the answer's wording or from which answer is recommended.

- An answer that means pass or fail is recorded as that check's result.
- An answer that means not checked, such as "Ask me later", records nothing and opens no follow-up.
- If you type your own answer, a plain "pass", "fail", "yes" or "no" counts. Anything else records nothing, and the agent reads your words and reports the result itself.

If the agent later reports its own pass or fail for the same check, that replaces the card's result.
