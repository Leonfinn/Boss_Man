---
title: Your first company and task
description: Use the setup wizard to create a company, connect your accounts, start a first task and hire your first agent. Then add more tasks and features.
group: Start here
order: 3
lead: This guide uses the setup wizard to create a company, connect your accounts and start a first task. The wizard has eight steps, and you can skip any of them.
---

:::note Before you start
You need Boss Man installed (see [Install Boss Man](/guides/install-boss-man)). The wizard has eight steps. You can skip any of them and come back with **Settings > Run the setup wizard**.
:::

![Your first half hour: create the company and its project, connect the runner and your accounts, add a first task, hire your first agent, then add more tasks.](/img/first-half-hour.svg =1160x420 narrow=/img/first-half-hour-narrow.svg:360x1040 "The first half hour, from the setup wizard to your first agent and tasks.")

## 1. Your company

Type a **Company name** and a sentence or two under **What it's for**. The CEO plans the work from this. Choose **Create the company**, then **Next**.

Boss Man creates the company's CEO agent and a paused Wiki Maintainer. If the launcher is on (`BOSSMAN_LAUNCHER=1` in `.env`, as [Install Boss Man](/guides/install-boss-man) sets), Boss Man also starts the company's runner. If it is off, you start the runner yourself in step 3.

## 2. A project

A project is a git repository your agents work in. Type a **Project name** and choose **Add the project**. Paste the repository address into **Git repo**, for example `https://github.com/you/repo.git`.

Under **When work is approved**, choose **Merge into the default branch** or **Open a pull request**. Choose the pull request option if your default branch only accepts pull requests.

## 3. The runner

Wait for the runner to say **Connected**. It shows **Starting…** first, and can take up to a minute. If it says **Not started**, choose **Start runner**.

## 4. Claude

On your own computer, run `claude setup-token`. It prints a long-lived token for your Claude plan. In the wizard, choose **Claude setup-token** under **Add**, paste the token into **Value**, and save. Then choose **Check with Claude**, which runs one tiny prompt on the runner.

Using another account? Under **Add**, choose its kind instead, such as **OpenRouter API key**, **Ollama Cloud API key** or **Synthetic API key**, paste the key and save. In step 7, pick the matching provider.

Paste tokens only into these forms. Never paste one into a chat, a ticket or the wiki, because agents can read those.

## 5. A git token

Choose **Git token (GitHub or Gitea)** under **Add**.

- On GitHub, make a fine-grained personal access token for only the repositories this company works on, with Contents, Pull requests and Workflows set to read and write, and Checks set to read.
- On Gitea, open **Settings > Applications > Generate New Token** and give it repository Read and Write.

Paste it, save, and choose **Check the token against** your project. You should see "The token can read and push to the repo."

## 6. Checks before merging

Under **Before merging, Boss Man will**, choose the command Boss Man runs before it merges approved work. Boss Man suggests one from your repository. Choose **Re-detect** if the list looks generic.

## 7. What pays for the CEO

Under **Funding sources**, name your plan, for example "Claude Max", and choose the kind **Subscription (setup-token)**. Choose **Add**, then pick it under "The CEO runs on". Boss Man uses this to track cost and quota.

## 8. A first task

A task is one piece of work for an agent. To see how tasks differ from features, see [Features, tasks and sub-tasks](/guides/how-boss-man-works#features-tasks-and-sub-tasks).

Type a **Title**, for example "Read the repo and propose a roadmap". Tick **Give it to** your CEO **now (it starts straight away)**. The box shows your CEO's name, which is "CEO" unless you changed it. Choose **Add the task to** your project. Then choose **Finish**.

:::worked
A run shows under **Runs** in the sidebar, and the task moves on the board. If no run shows, see "If nothing starts" below.
:::

## Hire your first agent

The CEO needs someone to hand work to.

1. Open **Agents** in the sidebar and choose **Hire**.
2. Under **Start from**, pick a role, such as Engineer.
3. Give it a **Name**. Under **Agent**, choose Claude Code, Codex or OpenCode.
4. Leave **Model** on Default, or pick one. Under **Paid from**, pick your funding source.
5. Read the **Instructions** and change them to fit your company.
6. Choose **Hire**. The button shows the name you typed, for example **Hire Sam**.

:::worked
The agent shows on the Agents page with **Pause** and **Edit** buttons.
:::

## Add more tasks and features

Open **Projects**, open your project, and choose **Add task**. At the top of the form, choose **New task** or **New feature**. A feature is something your users get, and tasks are the work that builds it. If you are not sure which you need, see [Features, tasks and sub-tasks](/guides/how-boss-man-works#features-tasks-and-sub-tasks).

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

Check that the agent is not paused, and that **Settings > Server and runner** says the runner is **Connected**.
