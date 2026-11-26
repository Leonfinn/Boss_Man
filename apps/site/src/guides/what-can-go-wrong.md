---
path: /what-can-go-wrong
title: What can go wrong with AI agent teams
navTitle: What can go wrong
description: Real stories of AI agents that ran up bills, deleted data or claimed work they never did, and what Boss Man does about each one, including what it does not cover yet.
group: Questions
order: 15
lead: You may have read the stories about AI agents that ran up a $47,000 bill, deleted a production database or claimed to have written tests that did not exist. This page takes the stories people have published and says, for each one, what Boss Man does about it, and where it does nothing yet.
---

Each answer was checked against Boss Man's code on 21 November 2026. Boss Man is in beta and changes often, so if something here looks out of date, [tell us on GitHub](@repo/issues).

## At a glance

| What went wrong | What Boss Man does | Covered? |
|---|---|---|
| [Two agents looped for 11 days and spent $47,000](#an-agent-loop-ran-up-a-47-000-bill) | A cost cap per task stops new runs at the cap. Review loops stop after three rounds. | Yes |
| [Spending crept up for weeks and was found on the invoice](#spending-crept-up-and-nobody-noticed) | Caps stop a runaway, but nothing warns you when spending speeds up. | Not yet |
| [An agent deleted a live database during a code freeze](#an-agent-deleted-a-live-database) | Destructive commands, including database deletes, come to you as a permission card. | Partly |
| [An agent ran `terraform destroy` on production](#an-agent-destroyed-production-infrastructure) | `terraform destroy` comes to you as a permission card. Deploys to production wait for you. | Yes |
| [An agent said it wrote tests that did not exist](#an-agent-claimed-tests-it-never-wrote) | Another agent reviews the actual change, against the ticket's "Done when" lines. | Yes |
| [An agent quietly undid other settings](#an-agent-changed-more-than-it-said) | The reviewer reads the whole change, not the agent's summary. | Yes |
| [An agent said "deployed" when part of it failed](#an-agent-said-done-about-something-nobody-checked) | Checks on the live system must each get a pass or fail before the ticket can close. | Partly |
| [An agent hung for 22 minutes waiting for a keypress](#an-agent-hung-and-nobody-knew) | A quiet run is flagged after 5 minutes. A run time limit can stop it. | Yes |
| [A stopped agent left a test runner using 7.6 GB](#a-stopped-agent-left-processes-behind) | Stopping a run stops everything it started. | Yes |
| [Parallel work was right piece by piece and wrong together](#parallel-work-that-did-not-fit-together) | Each ticket has its own copy of the code, and every merge is checked. Nothing decides whether tickets should run in parallel at all. | Partly |
| [Agents trusted old notes over what was true](#agents-trusted-old-notes) | Notes show their age, and old agent notes are marked for re-checking. | Partly |

## An agent loop ran up a $47,000 bill

**The story.** Two agents in a research system asked each other for clarification thousands of times over 11 days. Nothing failed, so no alarm went off. The team found out from the invoice. Sources: [the engineer's own account](https://techstartups.com/2025/11/14/ai-agents-horror-stories-how-a-47000-failure-exposed-the-hype-and-hidden-risks-of-multi-agent-systems/) and [a write-up on dev.to](https://dev.to/utibe_okodi_339fb47a13ef5/the-ai-agent-that-cost-47000-while-everyone-thought-it-was-working-1lg6).

**What Boss Man does.**

- **A cost cap per task.** Set it in the project's settings; a ticket can also have its own. When a ticket reaches its cap, Boss Man starts no new runs for it and sends you a card: raise the cap by half, or stop work on it. There is no cap until you set one.
- **A monthly spend cap** per project. It counts pay-as-you-go spend. At the cap, no new runs start for that project until you raise it.
- **Review loops stop.** If the same review finding comes back three times, or a ticket goes through more than three review rounds, Boss Man stops the ticket and asks what to do. The same failure three times in two hours is flagged too. See [when reviews go round in circles](/guides/reviews-and-merge-queue#when-reviews-go-round-in-circles).
- **You can see the loop.** Every run has a transcript you can read on its ticket, and the [watchdog](/guides/board-and-decisions#looks-stuck) marks a ticket **Looks stuck** when it stops moving.

**Limits.** A cap stops new runs. A run already going finishes first.

## Spending crept up and nobody noticed

**The story.** In the same case, weekly costs went from $127 to $891, then $6,240, then $18,400. The write-up suggests an alert when a day's spend is more than three times the average of the week before.

**What Boss Man does.** Not covered yet. Boss Man has caps and limits, but no alert when spending per day or per hour jumps. If you use a Claude or ChatGPT plan, **Settings > Funding** shows when the week's allowance will run out at the current pace, but that is about your plan, not dollars.

## An agent deleted a live database

**The story.** During a code freeze, an AI coding agent deleted a company's live database, against explicit instructions not to go ahead without approval. Source: [Fortune](https://fortune.com/2025/07/23/ai-coding-tool-replit-wiped-database-called-it-a-catastrophic-failure/).

**What Boss Man does.**

- **Destructive commands come to you.** `DROP`, `TRUNCATE` and `DELETE` sent through a database command line, force pushes and other destructive commands come to you as a [permission card](/guides/permissions#who-is-asked). Deletes inside the agent's own working folder go to the CEO first. Boss Man reads the command itself, so the same command written another way is caught too. An **Always allow** answer never covers a destructive command.
- **No reply means no.** If nobody answers a card within 10 minutes, the request is denied.
- **Your own Deny rules** refuse a command outright. See [rules](/guides/permissions#rules).

**Limits.** An instruction such as "code freeze" is only text that agents read. Boss Man does not enforce it. Ordinary commands run without asking, and agents can reach the public internet. So keep production passwords out of what agents can see: a deploy target's secrets go to an agent only while it carries out a deploy you approved.

## An agent destroyed production infrastructure

**The story.** An agent ran `terraform destroy`, which wiped a website's setup, including a database with 2.5 years of records and the snapshots meant as backups. Source: [Tom's Hardware](https://www.tomshardware.com/tech-industry/artificial-intelligence/claude-code-deletes-developers-production-setup-including-its-database-and-snapshots-2-5-years-of-records-were-nuked-in-an-instant).

**What Boss Man does.**

- `terraform destroy`, and plans or applies that destroy, come to you as a permission card. So does every `git push`.
- Agents do not push their own work. It merges only after a review and the checks you set. High and critical work also waits for [your sign-off](/guides/reviews-and-merge-queue#your-sign-off).
- A deploy to a production target waits for your approval.

## An agent claimed tests it never wrote

**The story.** Asked for code and tests, an agent sent a tidy summary and the code. The diff had no new tests. The test suite passed because nothing new was tested. Source: [dev.to](https://dev.to/galadev/i-run-a-side-business-with-ai-agents-heres-what-broke-in-14-days-4ch).

**What Boss Man does.**

- **Another agent reviews it.** Nobody reviews their own work. The reviewer reads the line-by-line change, so missing tests show as missing files. See [what a review checks](/guides/reviews-and-merge-queue#what-a-review-checks).
- **"Done when" lines.** A ticket can carry checkable "Done when" lines. Before it can go to review, the agent must report pass or fail for each one.
- **Checks before merge.** The checks you set for the project run before every merge. A ticket with no changes at all cannot go to review unless it is marked as not needing code.

**Limits.** The reviewer is an AI too. For high and critical work, you also sign off.

## An agent changed more than it said

**The story.** Asked to make one small change in four settings files, a cheap model started from old copies. Its summary listed only the change asked for. The diff showed it had also undone other settings. Source: [dev.to](https://dev.to/galadev/i-run-a-side-business-with-ai-agents-heres-what-broke-in-14-days-4ch).

**What Boss Man does.** The reviewer reads the whole change against the main branch, not the agent's summary. Each ticket works in its own copy of the code, on its own branch.

## An agent said "done" about something nobody checked

**The story.** A deploy command printed its success line, but one file had been rejected further up. The agent read only the last lines, and three changes were lost. Source: [dev.to](https://dev.to/heytobo/ai-agents-run-most-of-my-company-here-is-what-broke-5eif).

**What Boss Man does.** Some "Done when" lines can only be checked on the live system. After the merge, the ticket stays open until each of those has a pass or a fail, and a failure opens a follow-up ticket. See [after it goes live](/guides/reviews-and-merge-queue#after-it-goes-live).

**Limits.** The agent still makes the check and reports it. Boss Man makes sure there is a verdict for each line, not that the agent read the output well.

## An agent hung and nobody knew

**The story.** A background agent waited 22 minutes for keyboard input that would never come, until its owner killed it. Source: [dev.to](https://dev.to/galadev/i-run-a-side-business-with-ai-agents-heres-what-broke-in-14-days-4ch).

**What Boss Man does.**

- A run that goes quiet for 5 minutes is flagged (15 minutes while it is running a command). A **Stalled run** card goes to the Scrum Master or the CEO first, then to you, with **Keep waiting** or **Cancel run**.
- An agent that has not posted on its ticket for 30 minutes is asked for a progress report.
- The **Run time limit** in **Settings > Permissions** stops any run after the number of minutes you choose. It is off by default.

## A stopped agent left processes behind

**The story.** An agent was killed, but the test runner it started kept going. It grew to 7.6 GB of memory and shared a test database with another agent. Source: [dev.to](https://dev.to/galadev/i-run-a-side-business-with-ai-agents-heres-what-broke-in-14-days-4ch).

**What Boss Man does.** Each agent runs in its own process group. Stopping a run stops every process it started, and anything still running 5 seconds later is killed. The checks Boss Man runs before a merge take turns: by default one runs at a time.

## Parallel work that did not fit together

**The story.** A team ran seven coding agents in parallel. Each piece passed on its own, but the pieces did not fit. In their words, the work was "locally right and globally wrong". They went back to one agent at a time. Source: [dev.to](https://dev.to/nabil_since_dev/we-ran-seven-coding-agents-in-parallel-then-we-went-back-to-one-21k4).

**What Boss Man does.**

- Each ticket has its own copy of the code and its own branch.
- Every merge is tried in a throwaway copy before it lands, and the project's checks run first. See [the merge queue](/guides/reviews-and-merge-queue#the-merge-queue).
- The sign-off card warns you when an approved branch is likely to clash with another.
- Tickets can wait on other tickets, and **Hold new starts while this many merges are waiting** keeps new work back while merges pile up. It is off by default. See [in-progress limits](/guides/board-and-decisions#in-progress-limits).

**Not covered yet.** Nothing checks, before work starts, whether several tickets should run in parallel at all. That is down to the CEO's planning and to you.

## Agents trusted old notes

**The story.** Agents wrote most of a company's notes. New sessions read them and agreed with them without checking the live system, and an approval went unnoticed for six days. Source: [TechBytes](https://techbytes.app/posts/what-running-a-company-on-20-claude-agents-taught-us/) (the company sells a kit based on this, and the figures are its own).

**What Boss Man does.** Each ticket's note shows how old it is when an agent reads it. An agent's own notes show when they were written, and after 30 days untouched they are marked "review due", with a line telling the agent to check them against what it can see now.

**Limits.** This is a reminder, not a check. Nothing stops an agent trusting a note.

## What Boss Man does not do

- It does not warn you when spending speeds up. Set caps.
- It does not decide whether work should run in parallel.
- It does not back up your production systems. It backs up its own database before every update ([where backups are kept](/guides/updates-and-backups#where-backups-are-kept)).
- It does not ask before ordinary commands, or before an agent reaches the public internet. The [network guard](/guides/permissions#who-is-asked) keeps agents off your home network.
- Its reviewers are AI agents. Your sign-off is the human check, and by default it is only required for high and critical work.

Ready to try it? Start with [Install Boss Man](/guides/install-boss-man), and read [Permissions and the CEO-first rule](/guides/permissions) before you give agents anything that matters.
