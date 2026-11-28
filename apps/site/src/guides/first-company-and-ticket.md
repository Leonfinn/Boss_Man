---
title: Your first company and task
description: Use the setup wizard to create a company, say what your team works on, connect your Claude account, start a first task and hire your first agent. Code is optional.
group: Start here
order: 3
lead: This guide uses the setup wizard to create a company, connect your Claude account and start a first task. A team that works on documents and research sees six steps. A team that works on code sees two more. You can skip any step.
---

:::note Before you start
You need Boss Man installed (see [Install Boss Man](/guides/install-boss-man)) and a Claude account: a Claude plan or an API key (see [Connect a Claude account](/guides/connect-a-claude-account)). You do not need a GitHub or Gitea account unless your agents will work on code. You can skip any step and come back with **Settings > Run the setup wizard**.
:::

![Your first half hour: create the company and its project, connect the runner and your accounts, add a first task, hire your first agent, then add more tasks.](/img/first-half-hour.svg =1160x420 narrow=/img/first-half-hour-narrow.svg:360x1040 "The first half hour, from the setup wizard to your first agent and tasks.")

The top of each wizard page says which step you are on, for example "Step 2 of 6".

## Your company

Type a **Company name** and a sentence or two under **What it's for**, for example "We write market research reports for small shops". The CEO, the agent in charge of your company, plans the work from this. See [The CEO](/guides/the-ceo). Choose **Create the company**, then **Next**.

Boss Man creates the company's CEO agent and a paused Wiki Maintainer. If the launcher is on (the image install always turns it on, and the build install sets `BOSSMAN_LAUNCHER=1` in `.env`, as [Install Boss Man](/guides/install-boss-man#build-from-source) shows), Boss Man also starts the company's runner. If it is off, you start the runner yourself at the runner step.

## What will your team work on?

Pick one:

- **Documents, research and writing**: reports, research, plans and other written work. The agents write their results in your company's **Wiki**. This is the default.
- **Code in a git repository**: the agents change code in a repository on GitHub or Gitea.

A project is one stream of work with its own task board, such as "Client reports". Type a **Project name** and choose **Add the project**. You can change your choice later in **Settings**. For what a documents company sees and skips, see [Using Boss Man for work that isn't code](/guides/work-that-isnt-code).

If you picked code, the project also needs its repository. Paste its address into **Git repo**, for example `https://github.com/you/repo.git`. Under **When work is approved**, choose **Merge into the default branch** or **Open a pull request**. Choose the pull request option if your default branch only accepts pull requests. New to repos, branches and pull requests? See [Code words for owners](/guides/code-words).

## The runner

The runner is your agents' workspace: a separate, locked-down space where they work. Wait for it to say **Connected**. This can take up to a minute. If it says **Not connected**, choose **Start the runner**. To find out more, see [Your agents' workspace (the runner)](/guides/the-runner).

## Claude

Your agents need a Claude account: a Claude plan or an API key. To choose one, and for every step on a Mac or Windows, see [Connect a Claude account: plan or API key?](/guides/connect-a-claude-account)

For a plan: on your own computer, install Claude Code, then run `claude setup-token`. It prints a code for your Claude plan. In the wizard, paste the code into **Claude sign-in code** and choose **Save the code**. This also sets up what pays for the CEO.

Using another account? Open **Use an API key instead**, choose its kind under **Add**, such as **OpenRouter API key**, **Ollama Cloud API key** or **Synthetic API key**, paste the key and save. At the **What pays for the CEO** step, pick the matching provider. If it is not a Claude account, change the CEO's agent to OpenCode or Codex on the **Agents** page.

Paste codes and keys only into these forms. Never paste one into a chat, a task or the wiki, because agents can read those.

## A git token (code companies only)

The wizard shows this step only if you picked **Code in a git repository**. A git token lets agents save work to your repository. Choose **Git token (GitHub or Gitea)** under **Add**.

- On GitHub, make a fine-grained personal access token for only the repositories this company works on, with Contents, Pull requests, Workflows and Actions set to read and write. The wizard's **How do I get a token?** lists every step.
- On Gitea, open **Settings > Applications > Generate New Token** and give it repository Read and Write.

Paste it, save, and choose **Check the token against** your project. You should see "The token can read and push to the repo." Step-by-step help and what to do when it expires are in [Git token](/guides/checks-and-check-workers#git-token).

## Checks before merging (code companies only)

The wizard shows this step only if you picked **Code in a git repository**. A check is an automatic test Boss Man runs on finished code before it joins the project. Under **Before merging, Boss Man will**, choose the command Boss Man runs before it merges approved work. Boss Man suggests one from your repository. Choose **Re-detect** if the list looks generic. To find out whether you need a check at all, see [Checks and check workers](/guides/checks-and-check-workers).

## What pays for the CEO

If you saved a Claude sign-in code at the Claude step, this step is already done, and **Next** skips it. Otherwise, under **Funding sources**, name your plan, for example "Claude Max", and choose a **Kind**. Choose **Add funding source**, then pick it under "The CEO runs on". Boss Man uses this to track cost and quota. To learn about limits and where to see spend, see [What agents cost](/guides/what-agents-cost).

## A first task

A task is one piece of work for an agent. For how to write a good one, with examples, see [Tasks and the board](/guides/tasks-and-the-board). To see how tasks differ from features, see [Features, tasks and sub-tasks](/guides/how-boss-man-works#features-tasks-and-sub-tasks).

Type a **Title** and, under **Description**, say what you want back. For example:

- Documents: "Compare the three biggest garden centres near us and write a one-page summary".
- Code: "Read the repo and propose a roadmap".

Tick **Give it to** your CEO **now (it starts straight away)**. The box shows your CEO's name, which is "CEO" unless you changed it. Choose **Add the task to** your project. Then choose **Finish**.

:::worked
A run shows under **Activity > Runs** in the sidebar, and the task moves on the board. If no run shows, see "If nothing starts" below.
:::

When the task reaches Done, the **Finish setting up** list on **Decisions** ticks it off: "First task finished" for a documents company, or "First ticket merged" for a code company.

## Hire your first agent

The CEO needs someone to hand work to.

1. Open **Team > Agents** in the sidebar and choose **Hire**.
2. Under **Start from**, pick a role. For documents, Researcher or Writer. For code, Engineer.
3. Give it a **Name**. Under **Agent**, choose Claude Code, Codex or OpenCode.
4. Leave **Model** on Default, or pick one. Under **Paid from**, pick your funding source.
5. Read the **Instructions** and change them to fit your company.
6. Choose **Hire**. The button shows the name you typed, for example **Hire Sam**.

:::worked
The agent shows on the Agents page with a **Pause** button. To change it later, open the ⋯ menu and choose **Edit**.
:::

To choose the rest of your team, or to read the CEO's team-plan card, see [Hiring your first team](/guides/hiring-your-first-team).

## Add more tasks and features

Open **Projects**, open your project, and choose **Add task**. At the top of the form, choose **New task** or **New feature**. A feature is something your users or clients get, and tasks are the work that builds it. If you are not sure which you need, see [Features, tasks and sub-tasks](/guides/how-boss-man-works#features-tasks-and-sub-tasks).

For a **New task**, fill in:

- **Title** and **Description**
- **Done when**, one line per check, up to 10
- **Part of feature**, or leave it on "None (a standalone task)"
- **Assign to**, or leave it on "Nobody yet" for the CEO to assign
- **Risk**, or leave it on "Let the CEO rate it"

If you picked an agent under **Assign to**, choose **Add and start** to start it now. Otherwise the button says **Add to backlog**, and the task waits in Backlog.

For a **New feature**, fill in the **Title**, **What problem does it solve, and for whom?** and, if you like, an **Objective or milestone**. Tick **Ask the CEO to plan it** if you want the CEO to break it into tasks now. Then choose **Add feature**. The feature shows on the **Features** page.

To follow a task and answer the cards it raises, see [The board and Decisions](/guides/board-and-decisions).

### Let the CEO question you first

Use this when you have a rough idea but have not worked out the details. The CEO asks you questions until the idea is clear, then adds the task or feature for you.

1. Open the form as above, choose **New task** or **New feature**, and type a **Title**. Add a rough description if you have one.
2. Choose **Let the CEO question me first**. The button only shows if your company has a CEO.
3. Boss Man opens your chat with the CEO, with your draft in it. The draft is cleared from the form, so it is not added twice.
4. The CEO checks the board, tasks and features first. Then it asks one question at a time, each with its recommended answer, which you can simply accept. The questions cover the goal and who it is for, what done looks like, edge cases and what is out of scope, the risk, and what it depends on.
5. It usually takes 3 to 7 questions. To stop early, reply "go".

Boss Man asks the CEO to finish like this:

- **For a task**: the CEO adds it with a description, Done when lines and a risk level, and with its feature and who does it if that is clear.
- **For a feature**: the CEO adds it with a description, what done looks like and its place on the roadmap (an objective or milestone). It then plans the work as one task, or as a task with sub-tasks where the work splits naturally.

The CEO replies in the chat with what it added.

Add a task directly when you already know what you want and can write the Done when lines yourself. Let the CEO question you when the idea is rough, or when you are not sure what done looks like, what it touches or how risky it is.

## If nothing starts

Check that the agent is not paused, and that **Settings > Server and runner > Runner** says **Connected**.
