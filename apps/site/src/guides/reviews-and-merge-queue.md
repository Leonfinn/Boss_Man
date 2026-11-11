---
title: Reviews and the merge queue
description: How a change is reviewed by risk level, what the merge queue shows, and what happens when a check fails.
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

Once every reviewer approves, the ticket moves to Approved, merging, and joins the merge queue. Open **Merge queue** in the sidebar to see:

- **Running now**: the checks in progress
- **Waiting to merge**: in the order they will go, urgent work first, then the longest wait
- **Recently finished**: each marked merged or check failed

Boss Man runs the command you chose under **Before merging, Boss Man will** on each ticket. If it passes, Boss Man merges the branch or opens a pull request, as your project is set. If you chose **Nothing: merge after review only**, it merges straight after the review.

## When the check fails

The ticket goes back to in progress, and the agent is told which command failed. It fixes the problem and asks for review again. Boss Man also sends a ticket back if it has merge conflicts, or if it changed nothing and is not marked as needing no code changes.

## Your sign-off

For high and critical work, a card asks whether to merge after the reviewer approves. Choose **Approve and merge** or **Send it back**. The ticket also shows in the Your review lane on the board.
