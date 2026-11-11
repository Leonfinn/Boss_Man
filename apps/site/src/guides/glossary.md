---
title: Glossary
navTitle: Glossary
description: What each Boss Man word means, in a sentence or two, with a link to the guide that explains it.
group: Questions
order: 12
lead: Meet a Boss Man word you do not know? Find it here. Each term has a sentence or two and a link to the guide that explains it.
---

## A

- **Add-ons**: Optional extras that Boss Man works without: Tailscale, ntfy, Penpot and runner add-ons. Each one is off until you turn it on. ([Guide 9](/guides/add-ons))
- **Advice on permission cards**: A setting under **Settings > Reviews and CEO** that lets Boss Man suggest which button to press on a permission card: **Advise**, **Watch** or **Off**. It never answers a card for you. ([Guide 6](/guides/permissions#advice-on-permission-cards))
- **After-merge check**: A Done when line ticked **On a real host (checked after merge)**, because it can only be checked on the live system. Reviewers skip it, and the ticket stays open after the merge until it has a pass or fail. ([Guide 7](/guides/reviews-and-merge-queue#after-it-goes-live))
- **Agent**: An AI worker in a company, with a role, instructions and a model. Each agent is a session of Claude Code, Codex or OpenCode. ([Guide 1](/guides/how-boss-man-works#companies-and-agents))
- **Agent program**: The program an agent runs in: Claude Code, Codex or OpenCode. Each one can use different AI accounts. ([Guide 5](/guides/agents-and-models#agent-programs-and-accounts))
- **Approved, merging**: The Review lane on the board for tickets that every reviewer approved, while Boss Man checks and merges them. ([Guide 4](/guides/board-and-decisions#the-three-review-lanes))
- **Ask**: The notification level for things that need your answer. Asks are sent to your phone. ([Guide 8](/guides/phone-notifications#notification-levels))
- **Awaiting review**: The Review lane on the board for tickets an agent has finished and asked to have reviewed. ([Guide 4](/guides/board-and-decisions#the-three-review-lanes))

## B

- **Backlog**: The board column for tickets that are written but not started. ([Guide 4](/guides/board-and-decisions#the-board-s-columns))
- **Backups**: Copies of the database that Boss Man makes before every update, kept in the install folder next to `src`. Test one with `scripts/restore-test.sh` before you rely on it. ([Guide 10](/guides/updates-and-backups#where-backups-are-kept))
- **Blocked**: The board column for tickets waiting on something, such as another ticket or your answer. ([Guide 4](/guides/board-and-decisions#the-board-s-columns))
- **Board**: The page that shows every ticket in a project, in six columns. Open **Projects** and choose a project to see it. ([Guide 4](/guides/board-and-decisions#the-board-s-columns))
- **Built-in allows**: What agents may do at once, with no card: use Boss Man's own tools, read, search and edit files, fetch web pages and run other shell commands. Ask rules do not apply to them. ([Guide 6](/guides/permissions#who-is-asked))
- **Built-in guards**: Boss Man's fixed checks on risky requests: pushing, publishing and destructive commands come to you, and some deletes go to the CEO first. An Allow rule cannot let a guarded request run. ([Guide 6](/guides/permissions#who-is-asked))

## C

- **Card**: One thing on the Decisions page that waits for your answer, such as a plan, a permission request, a sign-off or a question. Each card offers its own buttons. ([Guide 4](/guides/board-and-decisions#answering-a-card))
- **CEO**: The agent every company has. It plans the work, writes and assigns tickets, reviews simpler work and settles many permission requests before you see them. ([Guide 1](/guides/how-boss-man-works#companies-and-agents))
- **CEO-first rule**: Commands that no rule or built-in check settles, and deletes of temp files or the agent's own files, go to the CEO first. If the CEO does not settle one within five minutes, or the request is from the CEO itself, it comes to you. ([Guide 6](/guides/permissions#who-is-asked))
- **Checks before merging**: The command Boss Man runs on approved work before it merges it, chosen under **Before merging, Boss Man will**. If it fails, the ticket goes back to In progress. ([Guide 7](/guides/reviews-and-merge-queue#the-merge-queue))
- **Company**: A team of agents with its own runner, secrets and budget. One Boss Man server can run several companies. ([Guide 1](/guides/how-boss-man-works#companies-and-agents))

## D

- **Decisions**: The page where Boss Man and its agents ask you things, one card for each. The sidebar shows how many are waiting. ([Guide 4](/guides/board-and-decisions#decisions))
- **Doesn't need code changes**: A tick box on the ticket page for research, wiki or docs work, so the ticket can close with no change to the repository. Without it, Boss Man sends back a ticket that changed nothing. ([Guide 4](/guides/board-and-decisions#the-ticket-page))
- **Done**: The board column for tickets that are merged or closed. ([Guide 4](/guides/board-and-decisions#the-board-s-columns))
- **Done when**: The lines on a ticket that say what finished means, up to 10. An agent must report pass or fail for each one before it asks for review. ([Guide 7](/guides/reviews-and-merge-queue#what-a-review-checks))

## F

- **Flag**: The notification level that shows on the Notifications page and as a browser notification. ([Guide 8](/guides/phone-notifications#notification-levels))
- **Funding source**: A named account that pays for agents, such as your Claude Max plan, added under **Settings > Funding**. Boss Man uses it to track cost and quota. ([Guide 3](/guides/first-company-and-ticket#7-what-pays-for-the-ceo))

## H

- **Hire**: Adding an agent to a company from **Agents > Hire**, starting from a ready-made role or a blank one. The CEO can also propose hires, which come to Decisions. ([Guide 5](/guides/agents-and-models#hire-an-agent))
- **Host deployer**: An optional root script on your machine, run every minute by cron, that lets you update Boss Man from the web page. It will not apply changes to Compose files, Dockerfiles or the deploy scripts. ([Guide 10](/guides/updates-and-backups#update-from-the-web-page-optional))

## I

- **In progress**: The board column for tickets an agent is working on. ([Guide 4](/guides/board-and-decisions#the-board-s-columns))

## L

- **Launcher**: The part of Boss Man that starts each company's runner for you. `BOSSMAN_LAUNCHER=1` in `.env` turns it on. ([Guide 2](/guides/install-boss-man#4-write-the-settings-file))

## M

- **Master key**: The file `secrets/master.key`, which encrypts every secret Boss Man stores. Keep a copy off the machine, because a backup without it cannot restore your secrets. ([Guide 10](/guides/updates-and-backups#keep-the-master-key-safe))
- **Merge queue**: Where approved tickets wait while Boss Man runs the checks and merges them, shown under **Merge queue** in the sidebar. Agents sometimes call it the merge gate or the merge line. ([Guide 7](/guides/reviews-and-merge-queue#the-merge-queue))
- **Model**: The AI model an agent uses, chosen from the **Model** list. **Default** uses the agent program's own default. ([Guide 5](/guides/agents-and-models#choose-a-model))

## N

- **Network guard**: The first check on every request, which refuses addresses agents must not reach, such as your home network or the Boss Man machine. No rule can lift it. ([Guide 6](/guides/permissions#who-is-asked))
- **Note**: The lowest notification level, shown on the Notifications page only. ([Guide 8](/guides/phone-notifications#notification-levels))
- **ntfy**: A free, open-source notification service that you run yourself. Boss Man uses it to send notifications to your phone. ([Guide 8](/guides/phone-notifications#send-notifications-to-your-phone))

## O

- **Owner**: You. There is one owner account, and it controls every company on the server. ([Guide 2](/guides/install-boss-man#6-make-the-owner-account))

## P

- **Page**: The notification level that is also sent to your phone, for example when a runner goes offline. ([Guide 8](/guides/phone-notifications#notification-levels))
- **Penpot**: An open-source design tool that Boss Man can run for your designer agents, on your home network only. ([Guide 9](/guides/add-ons#penpot-a-design-tool-for-your-designer-agents))
- **Permission card**: A card on Decisions that asks whether an agent may run a command or use a tool, with buttons such as **Allow once** and **Deny**. If nobody answers within 10 minutes, the request counts as denied. ([Guide 6](/guides/permissions#answering-a-permission-card))
- **Plan**: An agent's outline of how it will do a ticket, approved before the work starts. The CEO approves plans for low and medium risk, and you approve them for high and critical. ([Guide 7](/guides/reviews-and-merge-queue#risk-levels))
- **Project**: One git repository that a company's agents work in. Each project has its own board. ([Guide 1](/guides/how-boss-man-works#projects-and-tickets))

## Q

- **Queued checks**: The tab on the **Merge queue** page that lists every check running or waiting on the company's runner, with its ticket, kind, place in line and wait. ([Guide 7](/guides/reviews-and-merge-queue#queued-checks))
- **Quiet hours**: Hours you set under **Notifications > How you're told**, when pages and asks become flags and flags become notes. ([Guide 8](/guides/phone-notifications#quiet-hours-and-limits))

## R

- **Ready**: The board column for tickets ready for an agent to pick up. ([Guide 4](/guides/board-and-decisions#the-board-s-columns))
- **Review**: The step where another agent, or you, checks a finished ticket and approves it or sends it back with comments. On the board, the Review column has three lanes. ([Guide 7](/guides/reviews-and-merge-queue#what-a-review-checks))
- **Risk level**: How risky a ticket is: trivial, low, medium, high or critical. It decides who approves the plan, who reviews the work and whether you sign it off. ([Guide 7](/guides/reviews-and-merge-queue#risk-levels))
- **Rules**: Your own permission rules under **Settings > Rules**, each with the outcome **Allow**, **Ask the CEO**, **Ask me** or **Deny**. Deny rules always win, and for the others the first match in the list decides. ([Guide 6](/guides/permissions#rules))
- **Rules judge**: The name agents use for Advice on permission cards. ([Guide 6](/guides/permissions#advice-on-permission-cards))
- **Run**: One working session of an agent on a ticket. Runs are listed under **Runs** in the sidebar. ([Guide 3](/guides/first-company-and-ticket#8-a-first-task))
- **Runner**: The container where a company's agents work, one for each company. It connects out to the Boss Man server and shows **Connected** under **Settings > Server and runner** when it is working. ([Guide 1](/guides/how-boss-man-works))
- **Runner add-ons**: Extra tools built into the runner image, such as a browser agents can drive. Turn them on with `RUNNER_ADDONS` in `.env`. ([Guide 9](/guides/add-ons#runner-add-ons-extra-tools-for-agents))
- **Runner update**: Rebuilding the runner image with `scripts/update-runner.sh`, after which Boss Man swaps each company's runner when it is idle. Follow it under **Settings > Server and runner**, in **Runner update**. ([Guide 10](/guides/updates-and-backups#update-the-runners))

## S

- **Secrets**: The tokens and keys Boss Man stores encrypted under **Settings > Secrets**, such as a Claude setup-token or a git token. Boss Man never shows a secret again after you save it. ([Guide 5](/guides/agents-and-models#add-an-account))
- **Setup-token**: A long-lived token for your Claude Pro or Max plan, made by running `claude setup-token` on your own computer. ([Guide 3](/guides/first-company-and-ticket#4-claude))
- **Setup wizard**: The eight steps that open after you make the owner account, to create a company, connect your accounts and start a first ticket. Run it again with **Settings > Run the setup wizard**. ([Guide 3](/guides/first-company-and-ticket))
- **Sign-off**: Your approval before Boss Man merges high or critical work, asked for on a card after the reviewer approves. Choose **Approve and merge** or **Send it back**. ([Guide 7](/guides/reviews-and-merge-queue#your-sign-off))
- **Standing rules**: A block of text, up to 2,000 characters, that every agent reads at the start of each run. Edit them under **Settings > Reviews and CEO**. ([Guide 6](/guides/permissions#standing-rules))
- **Synthetic**: A model provider (synthetic.new) for OpenCode agents. Add its key as **Synthetic API key**. ([Guide 5](/guides/agents-and-models#synthetic))

## T

- **Tailnet**: Your private Tailscale network: the devices that can reach each other through Tailscale. ([Guide 9](/guides/add-ons#tailscale-https-from-anywhere-on-your-tailnet))
- **Tailscale**: An add-on that gives Boss Man an HTTPS address that only your own devices can reach. You need it for phone notifications. ([Guide 9](/guides/add-ons#tailscale-https-from-anywhere-on-your-tailnet))
- **Thinking**: How hard the model thinks before it answers, from **Default** and **Low** up to **Max**. Not every model offers every level. ([Guide 5](/guides/agents-and-models#choose-a-thinking-level))
- **Ticket**: One piece of work in a project, with a title, a description, a risk level and Done when lines. The button that makes one says **Add task**. ([Guide 1](/guides/how-boss-man-works#projects-and-tickets))

## U

- **Urgent**: A tick box on the ticket page that puts the ticket first in the merge queue. ([Guide 4](/guides/board-and-decisions#the-ticket-page))

## W

- **Workspaces**: The runner's copies of your repository, one for each ticket. **Settings > Server and runner** shows their size, and Boss Man clears those of tickets that finished more than 7 days ago. ([Guide 11](/guides/troubleshooting#updates-and-backups))

## Y

- **Your review**: The Review lane on the board for tickets from any column that are waiting on you. ([Guide 4](/guides/board-and-decisions#the-three-review-lanes))
