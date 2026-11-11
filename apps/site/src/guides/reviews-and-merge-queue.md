---
title: Reviews and the merge queue
description: How a change is reviewed by risk level, what the merge queue shows, what happens when a check fails, and how checks after the merge work.
group: Everyday use
order: 7
lead: Every change an agent makes is reviewed by another agent, then checked and merged by Boss Man. The ticket's risk level decides who reviews it and whether you sign it off.
---

## Risk levels

| Risk | Plan approved by | Reviewed by | Your sign-off |
|---|---|---|---|
| Trivial | no plan | CEO | no |
| Low | CEO | CEO | no |
| Medium | CEO | Senior developer | no |
| High | you | Senior developer | yes |
| Critical | you | Senior developer | yes |

If the company has no senior developer, the CEO reviews instead. A ticket with no risk level counts as medium. High and critical work also runs the project's deeper check before merging.

The table is a starting point. In **Settings > Reviews and CEO**, under **Reviews**, you can change who approves the plan and who reviews the code at each level, and turn on extra reviews: **Security review**, **Infra review** and **Adversarial review**. Each can name one agent or several. All the reviews a ticket needs must approve before it merges. You can also give one project its own rules under **Reviews for this project**.

## What a review checks

Before an agent can ask for review, it must report pass or fail against each Done when line. The reviewer reads the change, the line-by-line diff and the Done when results. Then it approves or sends the ticket back with comments.

If you review a ticket yourself, open it and choose **Approve and merge** or **Request changes**. With changes requested, you can add a one-line lesson. The CEO decides whether it goes into the project's brief, and you are told the outcome.

## When reviews go round in circles

Boss Man stops a ticket and asks you what to do when:

- the same review finding comes back three times
- it has been through more than three review rounds
- the same failure happens three times in two hours

The card offers options such as **Send it back anyway** and **Stop work on it**.

## The merge queue

Once every reviewer approves, the ticket moves to Approved, merging, and joins the merge queue. Open **Merge queue** in the sidebar. The **Merges** tab shows:

- **Running now**: the checks in progress
- **Waiting to merge**: in the order they will go, urgent work first, then the longest wait
- **Recently finished**: each marked merged or check failed

Boss Man runs the command you chose under **Before merging, Boss Man will** on each ticket. If it passes, Boss Man merges the branch or opens a pull request, as your project is set. If you chose **Nothing: merge after review only**, it merges straight after the review.

### Queued checks

The **Queued checks** tab lists every check that is running or waiting on the company's runner, not only merge checks. Running checks come first, then waiting ones in the order they will start. Each row shows:

- the ticket
- the kind: **merge check**, **quick check** (an agent checking its own work) or **full check**
- **running**, or **waiting, place** and its number in the line
- who asked for it, and how long it has run or waited

A check marked **held** cannot start yet, and the row says why, for example "main is red". A check marked **fixes main** is for a ticket that repairs a failing main branch.

The line at the top says how many check slots are in use. You set the number under **Settings > Server and runner > Checks**, in **Checks at once**. The tab is read-only.

The full list needs **Boss Man runs them (server queue)** under **Who runs agents' checks** in the same place. With **Agents run their own (legacy)**, the tab shows only the checks Boss Man already knows about.

## When the check fails

The ticket goes back to in progress, and the agent is told which command failed. It fixes the problem and asks for review again. Boss Man also sends a ticket back if it has merge conflicts, or if it changed nothing and is not marked as needing no code changes.

## Your sign-off

For high and critical work, a card asks whether to merge after the reviewer approves. Choose **Approve and merge** or **Send it back**. The ticket also shows in the Your review lane on the board.

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
