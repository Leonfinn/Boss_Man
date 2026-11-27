---
title: Glossary
navTitle: Glossary
description: What each Boss Man word means, in a sentence or two, with a link to the guide that explains it.
group: Questions
order: 14
lead: Meet a Boss Man word you do not know? Find it here. Each term has a sentence or two and a link to the guide that explains it.
---

## A

- **Add-ons**: Optional extras that Boss Man works without: Tailscale, ntfy, Penpot and runner add-ons. Each one is off until you turn it on. ([Guide 9](/guides/add-ons))
- **Advice on permission cards**: A setting under **Settings > Permissions** that lets Boss Man suggest which button to press on a permission card: **Advise**, **Watch** or **Off**. It never answers a card for you. ([Guide 6](/guides/permissions#advice-on-permission-cards))
- **After-merge check**: A Done when line ticked **On a real host (checked after merge)**, because it can only be checked on the live system. Reviewers skip it, and the ticket stays open after the merge until it has a pass or fail. ([Guide 7](/guides/reviews-and-merge-queue#after-it-goes-live))
- **Agent**: An AI worker in a company, with a role, instructions and a model. Each agent is a session of Claude Code, Codex or OpenCode. ([Guide 1](/guides/how-boss-man-works#companies-and-agents))
- **Agent program**: The program an agent runs in: Claude Code, Codex or OpenCode. Each one can use different AI accounts. ([Guide 5](/guides/agents-and-models#agent-programs-and-accounts))
- **Approved, merging**: The Review lane on the board for tickets that every reviewer approved, while Boss Man checks and merges them. ([Guide 4](/guides/board-and-decisions#the-three-review-lanes))
- **Ask**: The notification level for things that need your answer. Urgent asks go to your phone. Choose **All decisions** to get every ask. ([Guide 8](/guides/phone-notifications#notification-levels))
- **Awaiting review**: The Review lane on the board for tickets an agent has finished and asked to have reviewed. ([Guide 4](/guides/board-and-decisions#the-three-review-lanes))

## B

- **Backlog**: The board column for tickets that are written but not started. ([Guide 4](/guides/board-and-decisions#the-board-s-columns))
- **Backups**: Copies of the database that Boss Man makes before every update, kept in the install folder next to `src`. Test one with `scripts/restore-test.sh` before you rely on it. ([Guide 10](/guides/updates-and-backups#where-backups-are-kept))
- **Blocked**: The board column for tickets that are only waiting: on another ticket, an open card (plan cards too), a date, or the change going live. Blocked tickets do not count towards the in-progress limits. ([Guide 4](/guides/board-and-decisions#what-blocked-means))
- **Board**: The page that shows every ticket in a project, in six columns. Open **Projects** and choose a project to see it. ([Guide 4](/guides/board-and-decisions#the-board-s-columns))
- **Built-in allows**: What agents may do at once, with no card: use Boss Man's own tools, read, search and edit files, fetch web pages and run other shell commands. Ask rules do not apply to them. ([Guide 6](/guides/permissions#who-is-asked))
- **Built-in guards**: Boss Man's fixed checks on risky requests: pushing, publishing and destructive commands come to you, and some deletes go to the CEO first. An Allow rule cannot let a guarded request run. ([Guide 6](/guides/permissions#who-is-asked))

## C

- **Card**: One thing on the Decisions page that waits for your answer, such as a plan, a permission request, a sign-off or a question. Each card offers its own buttons. A button that promises a screenshot works only once one is attached on the card. ([Guide 4](/guides/board-and-decisions#answering-a-card))
- **CEO**: The agent every company has. It plans the work, writes and assigns tickets, reviews simpler work and settles many permission requests before you see them. ([Guide 1](/guides/how-boss-man-works#companies-and-agents))
- **CEO-first rule**: Commands that no rule or built-in check settles, and deletes in /tmp or in the agent's own folder (apart from plain deletes of its own entries in /tmp, which run at once), go to the CEO first. If the CEO does not settle one within five minutes, or the request is from the CEO itself, it comes to you. ([Guide 6](/guides/permissions#who-is-asked))
- **Check worker**: A small container on another Docker host that runs checks when the check line is long. It runs no agents. Add one under **Settings > Server and runner > Limits and checks**. ([Guide 9](/guides/add-ons#check-workers-more-machines-for-checks))
- **Checks before merging**: The command Boss Man runs on approved work before it merges it, chosen under **Before merging, Boss Man will**. If it fails, the ticket goes back to In progress. ([Guide 7](/guides/reviews-and-merge-queue#the-merge-queue))
- **Company**: A team of agents with its own runner, secrets and budget. One Boss Man server can run several companies. ([Guide 1](/guides/how-boss-man-works#companies-and-agents))

## D

- **Decisions**: The page where Boss Man and its agents ask you things, one card for each. The sidebar shows how many are waiting. ([Guide 4](/guides/board-and-decisions#decisions))
- **Doesn't need code changes**: A tick box on the ticket page for research, wiki or docs work, so the ticket can close with no change to the repository. Without it, Boss Man sends back a ticket that changed nothing. ([Guide 4](/guides/board-and-decisions#the-ticket-page))
- **Done**: The board column for tickets that are merged or closed. ([Guide 4](/guides/board-and-decisions#the-board-s-columns))
- **Done when**: The lines on a ticket that say what finished means, up to 10. An agent must report pass or fail for each one before it asks for review. ([Guide 7](/guides/reviews-and-merge-queue#what-a-review-checks))

## E

- **End all running runs**: A button on the **Runs** page that ends every run going now, in every company. Work the agents have not saved is lost. It does not stop new runs from starting. ([Guide 12](/guides/stopping-work#end-all-running-runs))
- **Engagements**: Work one of your companies asks another of your companies to do. Open **Engagements** in the sidebar to see them. ([Guide 1](/guides/how-boss-man-works#companies-and-agents))

## F

- **Feature**: Something users would notice or ask for, kept on the **Features** page with a status, demand, effort and priority. A feature does no work itself: one or more tasks deliver it. Agents also call it a feature request. ([Guide 1](/guides/how-boss-man-works#features-tasks-and-sub-tasks))
- **Flag**: The notification level that shows on the Notifications page and as a browser notification. Tick **Also send flags** to get them on your phone too. ([Guide 8](/guides/phone-notifications#notification-levels))
- **Funding source**: A named account that pays for agents, such as your Claude Max plan, added under **Settings > Funding**. Boss Man uses it to track cost and quota. ([Guide 3](/guides/first-company-and-ticket#what-pays-for-the-ceo), and [What agents cost](/guides/what-agents-cost))

## H

- **Hire**: Adding an agent to a company from **Agents > Hire**, starting from a ready-made role or a blank one. The CEO can also propose hires, which come to Decisions. ([Guide 5](/guides/agents-and-models#hire-an-agent))
- **Host deployer**: An optional root script on your machine, run every minute by cron, that lets you update Boss Man from the web page. It will not apply changes to Compose files, Dockerfiles or the deploy scripts. ([Guide 10](/guides/updates-and-backups#update-from-the-web-page-optional))

## I

- **In progress**: The board column for tickets an agent is working on. ([Guide 4](/guides/board-and-decisions#the-board-s-columns))
- **In-progress limit**: How many tickets one agent, or the whole company, may have in progress at once, set under **Settings > Server and runner > Limits and checks**. A ticket over the limit waits in Ready and starts by itself when a place frees up. Agents also call it the WIP limit. ([Guide 4](/guides/board-and-decisions#in-progress-limits))

## K

- **Keyboard shortcuts**: Keys that move around Boss Man without the mouse. Press **?** to list them. Switch off the single-letter keys under **Settings > Account**. ([Guide 4](/guides/board-and-decisions#keyboard-shortcuts))

## L

- **Launcher**: The part of Boss Man that starts each company's runner for you. The image install always turns it on. In the build install, `BOSSMAN_LAUNCHER=1` in `.env` turns it on. ([Guide 2](/guides/install-boss-man#4-write-the-settings-file))
- **Let the CEO question me first**: A button on the New task and New feature form. It sends your draft to the CEO's chat, where the CEO asks you a few questions and then adds the task or feature for you. ([Guide 3](/guides/first-company-and-ticket#let-the-ceo-question-you-first))

## M

- **Master key**: The file `secrets/master.key`, which encrypts every secret Boss Man stores. Keep a copy off the machine, because a backup without it cannot restore your secrets. ([Guide 10](/guides/updates-and-backups#keep-the-master-key-safe))
- **Merge queue**: Where approved tickets wait while Boss Man runs the checks and merges them, shown under **Merge queue** in the sidebar. Work that waits on you is listed first, under **Needs you**. Agents sometimes call it the merge gate or the merge line. ([Guide 7](/guides/reviews-and-merge-queue#the-merge-queue))
- **Model**: The AI model an agent uses, chosen from the **Model** list. **Default** uses the agent program's own default. ([Guide 5](/guides/agents-and-models#choose-a-model))

## N

- **Network guard**: The first check on every request, which refuses addresses agents must not reach, such as your home network or the Boss Man machine. No permission rule can lift it. To let runners reach an extra address, add it to `BOSSMAN_NETGUARD_ALLOW` in `.env`. ([Guide 6](/guides/permissions#who-is-asked))
- **No size**: A ticket nobody has given points yet. It adds nothing to the points left, so a forecast with unsized tickets is only as good as the sized ones. ([Guide 1](/guides/how-boss-man-works#features-tasks-and-sub-tasks))
- **Note**: The lowest notification level, shown on the Notifications page only. ([Guide 8](/guides/phone-notifications#notification-levels))
- **ntfy**: A free, open-source notification service that you run yourself. Boss Man uses it to send notifications to your phone. ([Guide 8](/guides/phone-notifications#send-notifications-to-your-phone))

## O

- **Owner**: You. There is one owner account, and it controls every company on the server. ([Guide 2](/guides/install-boss-man#6-make-the-owner-account))

## P

- **Pace**: How many points of a milestone were finished each week over the last 4 weeks. Boss Man uses it to guess when the rest will be finished. ([Guide 1](/guides/how-boss-man-works#features-tasks-and-sub-tasks))
- **Page**: The notification level that is also sent to your phone, for example when a runner goes offline. ([Guide 8](/guides/phone-notifications#notification-levels))
- **Pause**: A button on an agent's row on the **Agents** page. The agent starts nothing new until you choose **Start**. A run it already has going finishes by itself. **Settings > Team and CEO** can pause a whole company the same way. ([Guide 12](/guides/stopping-work#pause-one-agent))
- **Penpot**: An open-source design tool that Boss Man can run for your designer agents, on your home network only. ([Guide 9](/guides/add-ons#penpot-a-design-tool-for-your-designer-agents))
- **Permission card**: A card on Decisions that asks whether an agent may run a command or use a tool, with buttons such as **Allow once** and **Deny**. If nobody answers within 10 minutes, the request counts as denied. ([Guide 6](/guides/permissions#answering-a-permission-card))
- **Plan**: An agent's outline of how it will do a ticket, approved before the work starts. By default, the CEO approves plans for low and medium risk, and you approve them for high and critical. You can change this in **Settings > Reviews**. ([Guide 7](/guides/reviews-and-merge-queue#risk-levels))
- **Points**: How big a ticket is: a number it is given when it is planned. A bigger number means more work. The Roadmap adds up the points still to do to forecast when a milestone finishes. ([Guide 1](/guides/how-boss-man-works#features-tasks-and-sub-tasks))
- **Priority 1**: A tick box on the ticket page, once called **Urgent**. The ticket goes first in the check queue and the merge line, keeps running when a plan is nearly used up, and you get one alert when it is ready to go live. ([Guide 4](/guides/board-and-decisions#the-ticket-page))
- **Project**: One stream of work with its own task board, such as "Client reports". It can hold documents only, or a code repository that a company's agents work in. ([Guide 1](/guides/how-boss-man-works#projects-and-tasks))

## Q

- **Quick checks**: The tab on the **Merge queue** page that lists the quick and full checks agents ask for, running or waiting, with each one's ticket, kind, place in line and wait. Merge checks are on the **Merges** tab. Checks are **Held** while main is red. ([Guide 7](/guides/reviews-and-merge-queue#quick-checks))
- **Quiet hours**: Hours you set under **Notifications > How you're told**, when pages and asks become flags and flags become notes. ([Guide 8](/guides/phone-notifications#quiet-hours-and-limits))

## R

- **Ready**: The board column for tickets ready for an agent to pick up. ([Guide 4](/guides/board-and-decisions#the-board-s-columns))
- **Review**: The step where another agent, or you, checks a finished ticket and approves it or sends it back with comments. On the board, the Review column has three lanes. ([Guide 7](/guides/reviews-and-merge-queue#what-a-review-checks))
- **Risk level**: How risky a ticket is: trivial, low, medium, high or critical. It decides who approves the plan, who reviews the work and whether you sign it off. ([Guide 7](/guides/reviews-and-merge-queue#risk-levels))
- **Rules**: Your own permission rules under **Settings > Permissions**, each with the outcome **Allow**, **Ask the CEO**, **Ask me** or **Deny**. Deny rules always win. Then your Allow rules apply. **Ask the CEO** and **Ask me** rules only apply to requests that would otherwise ask. ([Guide 6](/guides/permissions#rules))
- **Rules judge**: The name agents use for Advice on permission cards. ([Guide 6](/guides/permissions#advice-on-permission-cards))
- **Run**: One working session of an agent on a ticket. Runs are listed under **Activity > Runs** in the sidebar. ([Guide 3](/guides/first-company-and-ticket#a-first-task))
- **Runner**: The container where a company's agents work, one for each company. It connects out to the Boss Man server and shows **Connected** under **Settings > Server and runner > Runner** when it is working. ([Guide 1](/guides/how-boss-man-works))
- **Runner add-ons**: Extra tools built into the runner image, such as a browser agents can drive. Turn them on with the tick boxes in Settings > Server and runner > Runner. ([Guide 9](/guides/add-ons#runner-add-ons-extra-tools-for-agents))
- **Runner update**: Rebuilding the runner image with `scripts/update-runner.sh`, after which Boss Man swaps each company's runner when it is idle. Follow it under **Settings > Server and runner > Updates**. ([Guide 10](/guides/updates-and-backups#update-the-runners))

## S

- **Scrum Master**: An optional agent you can hire. It chases tickets that stay stuck. What it may do is set under **Settings > Watchdog**. ([Guide 5](/guides/agents-and-models#hire-an-agent))
- **Secrets**: The tokens and keys Boss Man stores encrypted under **Settings > Secrets**, such as a Claude setup-token or a git token. Boss Man never shows a secret again after you save it. ([Guide 5](/guides/agents-and-models#add-an-account))
- **Setup-token**: A long-lived token for your Claude Pro or Max plan, made by running `claude setup-token` on your own computer. It lasts one year. ([Connect a Claude account](/guides/connect-a-claude-account#connect-a-claude-plan-with-a-setup-token))
- **Setup wizard**: The eight steps that open after you make the owner account, to create a company, connect your accounts and start a first ticket. Run it again with **Settings > Run the setup wizard**. ([Guide 3](/guides/first-company-and-ticket))
- **Sign-off**: Your approval before Boss Man merges high or critical work, asked for on a card after the reviewer approves. The card lists the reviews, the last quick check and how many files changed. Choose **Approve and merge** or **Send it back**. ([Guide 7](/guides/reviews-and-merge-queue#your-sign-off))
- **Skills**: Extra know-how for agents, added from a link, a draft or an upload. A Security Reviewer can check each one, and you approve every one. Open **Skills** in the sidebar. ([Guide 9](/guides/add-ons))
- **Standing rules**: A block of text, up to 2,000 characters, that every agent reads at the start of each run. Edit them under **Settings > Team and CEO**. ([Guide 6](/guides/permissions#standing-rules))
- **Stop all work**: A button under **Settings > Server and runner > Updates** that stops every company from starting new runs until you choose **Resume** on the banner at the top of every page. Runs already going finish by themselves. ([Guide 12](/guides/stopping-work#stop-all-work))
- **Sub-task**: A task under a bigger task, used where the work splits naturally. The parent task waits until its sub-tasks are done. A sub-task cannot have sub-tasks of its own. ([Guide 1](/guides/how-boss-man-works#features-tasks-and-sub-tasks))
- **Synthetic**: A model provider (synthetic.new) for OpenCode agents. Add its key as **Synthetic API key**. ([Guide 5](/guides/agents-and-models#synthetic))

## T

- **Tailnet**: Your private Tailscale network: the devices that can reach each other through Tailscale. ([Guide 9](/guides/add-ons#tailscale-https-from-anywhere-on-your-tailnet))
- **Tailscale**: An add-on that gives Boss Man an HTTPS address that only your own devices can reach. You need it for phone notifications. ([Guide 9](/guides/add-ons#tailscale-https-from-anywhere-on-your-tailnet))
- **Task**: One piece of work an agent does in a project, with a title, a description, a risk level and Done when lines. One or more tasks deliver a feature, and work that is not a feature is a task with no feature. Add one with **Add task**. Also called a ticket. ([Guide 1](/guides/how-boss-man-works#features-tasks-and-sub-tasks))
- **Thinking**: How hard the model thinks before it answers, from **Default** and **Low** up to **Max**. Not every model offers every level. ([Guide 5](/guides/agents-and-models#choose-a-thinking-level))
- **Ticket**: Another name for a task. See **Task**. ([Guide 1](/guides/how-boss-man-works#projects-and-tasks))
- **Tool servers**: Servers (MCP) that give agents extra tools, such as reading web pages. Add them under **Settings > Tools and deploys**. ([Guide 9](/guides/add-ons#tool-servers-extra-tools-from-servers-you-run))

## U

- **Urgent**: The old name for **Priority 1**. See **Priority 1**. ([Guide 4](/guides/board-and-decisions#the-ticket-page))

## W

- **Watchdog**: The settings for when the Scrum Master steps in, under **Settings > Watchdog**. ([Guide 5](/guides/agents-and-models#hire-an-agent))
- **Wiki**: The company's shared pages, written by you and the agents. Open **Wiki** in the sidebar.

- **Wrap-up**: What **Ask agents to wrap up** starts: every running agent is asked to save its work and stop, and nothing new starts until it lifts by itself or you choose **Cancel wrap-up**. ([Guide 12](/guides/stopping-work#ask-agents-to-wrap-up))
- **Workspaces**: The runner's copies of your repository, one for each ticket. **Settings > Server and runner > Runner** shows their size, and Boss Man clears those of tickets that finished more than 7 days ago. ([Guide 13](/guides/troubleshooting#updates-and-backups))

## Y

- **Your review**: The Review lane on the board for tickets from any column that are waiting on you. ([Guide 4](/guides/board-and-decisions#the-three-review-lanes))
