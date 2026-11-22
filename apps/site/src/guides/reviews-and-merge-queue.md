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

- **2 for you to answer**: work that waits on your answer
- **Main is red: 3 checks on hold**: the main branch really is failing its check, so new checks wait (see [Quick checks](#quick-checks))
- **Merges are held: 2 approved tickets are held behind BOS-123**: a fix for main is marked and on its way, so approved tickets wait until it is merged and live. The label names the fix. Main is not shown as red in this case.
- **1 with a failed check**: a merge check failed and Boss Man is trying again
- **1 not moved for over an hour**: work that has not moved for over an hour

If none of these apply, it says "Nothing needs you. Everything here is moving by itself."

When a server update is waiting for a quiet machine, both tabs say so, for example: "Paused for a server update since 14:05; new checks start once it is done, by 14:35 at the latest. A server update is waiting for these 2 running checks to finish; no new merges start until it's done. Nothing needs stopping." You do not need to stop anything. The update starts by itself when the running checks finish.

Each tab shows a count: **Merges** counts the approved work in the merge line, and **Quick checks** counts the quick and full checks. The count turns amber when something on that tab needs you or is held.

The **Merges** tab shows:

- **Needs you**: only when something waits on you. Each item has a button straight to its card, such as **Open the sign-off** or **Open the stopped check**.
- **Running now**: the merges being checked, and how many merge slots are busy, for example "1 of 2 merge slots busy". A check running for over an hour is marked **over an hour**.
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

Work from background agents (an agent whose job title includes "Background", such as a Background Developer) lets newer ordinary work merge first, then takes its place by when it joined. Its row says so, for example "background lane: newer ordinary work goes first for up to 40 min more". You set how long in **Background lane gives way for**, in the **Checks** box under **Settings > Server and runner > Limits and checks**: 120 minutes by default, up to 1440. 0 means it always goes after ordinary work.

### The landing turn

While a passed change waits to land, other changes can reach main first. If they touch the same files, the change is rebuilt and checked again. A change rebuilt twice this way gets the project's **landing turn**: for up to an hour, other passed changes wait to land so it can go first. Their checks carry on meanwhile.

A ticket waiting behind a turn says so in its history, for example: "Merge line: waiting behind another ticket's landing turn: "Fix the login page" has the landing turn; this merge pushes when it lands or the turn ends". If main changes its files meanwhile, it does not wait for the turn to end: it is rebuilt and checked again at once, and its history says so. You do not need to do anything.

Two settings in the **Checks** box under **Settings > Server and runner > Limits and checks** control this. Both are on by default:

- **Land passed merges when main moved elsewhere**: a passed change lands even though main moved, as long as main's newer changes touch none of its files and none of the project's dependency, build, CI or migration files. Main's own CI checks the result. Turn it off to test every change again whenever main moves.
- **Landing turn**: how many minutes a turn lasts, from 0 to 240 (60 by default). 0 turns landing turns off. Choose **Save landing turn**.

### Wait for GitHub CI

In the same place, tick **Wait for GitHub CI before merging** to merge only once GitHub CI passes as well as Boss Man's own check. It is off by default and works for projects on GitHub only. Each merge then uses GitHub Actions minutes, which a private repository pays for. If CI fails, the ticket goes back to the agent with the failing jobs and tests.

### The merge banner

When the merge line needs your attention, a banner shows at the top of the **Dashboard** and **Decisions**. Choose it to open the page it names. It goes away by itself when the problem does.

| Banner | What it means | What to do |
|---|---|---|
| **Merges are stuck:** and a cause | Nothing is moving and someone has to act. The banner is red. | Do what its **Fix:** line says. |
| **Merging, but slowly:** | Merges land, but the line is long, so the wait is long. The banner is calm, not red. It says how many are waiting, about how long they will take at the current rate, and when the last one landed. For example: "Merging, but slowly: 17 for Boss Man to merge, about 4 h to clear at the current rate, last landed 19:03." | Nothing. The line clears by itself. |
| **Paused for a server update** | New checks wait for an update (see above). | Nothing. |
| **Start brake off** | The merge line has grown for an hour and new starts are not held. It says how many merges are waiting and suggests a limit, for example "Start brake off, 24 waiting; suggested limit 12". | Choose **Open Settings** and set **Hold new starts while this many merges are waiting** ([Guide 4](/guides/board-and-decisions#in-progress-limits)). |

On each ticket, Boss Man runs the check you chose for the project under **Before merging, Boss Man will**. If it passes, Boss Man merges the branch or opens a pull request, as your project is set. If you chose **Nothing: merge after review only**, it merges straight after the review.

### Quick checks

The **Quick checks** tab lists the checks agents ask for on their own work that are running or waiting. Merge checks are not listed here; they are on the **Merges** tab. Running checks come first, then waiting ones in the order they will start. Each row shows:

- its place in the line, and the ticket
- **Running**, **Waiting** or **Held**
- the kind: **quick check** (an agent checking its own work) or **full check**
- who asked for it, and how long it has run or waited

When the main branch is really failing its check (main is red), new checks are **Held** and cannot start. A red banner above the list says "Main is failing its check, so new checks wait.", how many checks are held and, if a ticket that fixes main is queued, links to it. A check marked **fixes main** is for that ticket, and it still runs.

When main is not red but a marked fix for it is on its way, the banner starts "Merges are held." instead. It says how many approved tickets are held until the fix is merged and live, and links to the fix. Checks that fix main, and merges already running, carry on.

When nothing is queued, the tab says "No quick checks queued." and how many slots are free.

If a check slot is free but a queued check is not taking it, the tab says **Idle check capacity.** and which machine it is, which check and why. If it lasts 5 minutes, the CEO is told. If it lasts 30 minutes, Boss Man sends you a notification. A slot that is idle for a reason you already know about, such as a server update, is listed without the alert.

The line at the top says how many check slots are busy, for example "1 of 4 check slots busy, shared with merge checks". Quick checks and merge checks take turns on the same slots. You set the number under **Settings > Server and runner > Limits and checks**, in **Checks at once**. The tab is read-only.

The full list needs **Boss Man runs them** under **Who runs the checks** in the same place. With **Each agent runs its own**, the tab shows only the checks Boss Man already knows about.

## When the check fails

The ticket goes back to in progress, and the agent is told which command failed. It fixes the problem and asks for review again. Boss Man also sends a ticket back if it has merge conflicts, or if it changed nothing and is not marked as needing no code changes.

## Your sign-off

For high and critical work, a card asks whether to merge after the reviewer approves. It lists the reviews, the last quick check and how many files changed ([Guide 4](/guides/board-and-decisions#the-sign-off-card)). Choose **Approve and merge** or **Send it back**. The ticket also shows in the Your review lane on the board, and under **Needs you** on the Merge queue page.

## After it goes live

Some Done when lines can only be checked on the running system, such as "the health check returns 200". When you write the ticket, or later on the ticket page, tick those lines under **On a real host (checked after merge)**. The ticket page then marks them "on a real host, checked after merge". Reviewers skip these lines, so they never hold up a review.

After the merge, the ticket stays open until each of these checks has a pass or fail:

1. If the change is not live yet, the ticket waits in **Blocked**. A change to tests, the `docs/` folder, top-level notes such as `README.md`, or GitHub CI only counts as live as soon as it merges, so it never waits for a server update. The ticket page says what it waits for, such as "waiting for go-live: the server update". On the board it shows **Not counted: merged, waiting to go live**, so it does not take one of the agent's in-progress places.
2. When the change is live, Boss Man moves the ticket to **In progress** and wakes the agent to make the checks.
3. The agent reports pass or fail for each one, then closes the ticket. It cannot close it before then.

If a check fails on the live system, Boss Man opens a follow-up ticket for it, assigned to the same agent.

### When a card asks you to make the check

If only you can make a check, the agent sends you a card. When it raises the card, the agent must say what each answer means: pass, fail or not checked. Boss Man records only that. It does not guess from the answer's wording or from which answer is recommended.

- An answer that means pass or fail is recorded as that check's result.
- An answer that means not checked, such as "Ask me later", records nothing and opens no follow-up.
- If you type your own answer, a plain "pass", "fail", "yes" or "no" counts. Anything else records nothing, and the agent reads your words and reports the result itself.

If the agent later reports its own pass or fail for the same check, that replaces the card's result.
