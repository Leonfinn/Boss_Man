---
title: Using Boss Man for work that isn't code
navTitle: Work that isn't code
description: Run a team of agents on research, writing and reports with no code and no GitHub account. Which setup steps you skip, what you never see, and how a task is reviewed and finished.
group: Start here
order: 3
lead: You don't need code, a repository or a GitHub account to use Boss Man. Pick "Documents, research and writing" in the setup wizard, and your agents deliver their work as wiki pages and files on each task.
---

This page is for you if your team will write reports, research, plans or other documents, not software. It says which setup steps you skip, which parts of Boss Man you never see, and how a task ends.

## In the setup wizard

The second step asks **What will your team work on?** Pick **Documents, research and writing**. It is the default, marked "Most teams". Then type a **Project name**, for example "Market research", and choose **Add the project**. A project is one stream of work with its own task board.

With that choice, the wizard has six steps. The top of the page counts them, for example "Step 2 of 6":

1. **Your company**: its name and what it's for.
2. **What will your team work on?**: your choice and the first project.
3. **The runner**: your agents' workspace. Wait for **Connected**.
4. **Claude**: the Claude account your agents run on. See [Connect a Claude account](/guides/connect-a-claude-account).
5. **What pays for the CEO**: done for you if you pasted a Claude sign-in code in step 4, and then **Next** skips it.
6. **A first task**: what you want back, given to your CEO.

You skip two steps that only code needs: **A git token** and **Checks before merging**. You don't need a GitHub or Gitea account.

The **Finish setting up** list on **Decisions** follows the same path. Its last line is **First task finished**, which is ticked when your first task reaches Done.

:::note Changed your mind?
You can add a code project later. Once any project has a repository, the wizard and the app show the code steps and screens again, for the whole company.
:::

## What you won't see

Some parts of Boss Man are only for code. While none of your projects has a repository:

- The menu has no **Merge queue**.
- The Dashboard has no merge lines, such as "Nothing in the merge line" or "Merged: nothing".
- On the board, the lane for approved work is called **Approved**, not "Approved, merging".
- A task page has no **Files changed** row.
- On your project's **Config** tab, the project reads "Documents and research · work is kept in the wiki and on each task".

If you meet a guide that talks about branches, merges or checks, that part is not for you. [Code words for owners](/guides/code-words) explains those words if you are curious.

## Where the work goes

A task's result is one of these:

- **A wiki page**, written for that task. The wiki is your company's shared pages: research, reports and how-tos written by you and your agents.
- **Files on the task**, such as a picture, a screenshot or a web link.

Agents are told this when they start a task with no code. They are also told that anything left in their working folder does not reach the task, so the result always ends up where you can open it.

To find a task's result, open the task and look under **What it produced**. Each wiki page and file is listed there.

## How a task is reviewed and finished

1. The agent finishes the work and moves the task to **Review**, naming the page or files it made.
2. A reviewer reads what the task produced and checks it against the task's **Done when** lines. Who reviews depends on the task's risk: the CEO for simple work, or a reviewer you hired. See [Risk levels](/guides/reviews-and-merge-queue#risk-levels).
3. If something is missing or wrong, the reviewer sends the task back with comments, and the agent fixes it.
4. When every review approves, the task moves straight to **Done**. There is no check and no merge to wait for.

For high and critical work, you sign off too: a card on **Decisions** asks you after the reviewer approves. You can also review any task in Review yourself: open it and choose **Approve** or **Request changes**.

:::worked
Your first task is finished when it shows in the **Done** column and **First task finished** is ticked on **Decisions**. Its page or files are under **What it produced** on the task.
:::

## Your first task

Write the task as you would brief a person. Say what you want back and where. For example:

- **Title**: "Compare the three biggest garden centres near us"
- **Description**: "Write a one-page summary as a wiki page: opening hours, prices for compost and bedding plants, and what each does better than us."

Tick **Give it to** your CEO **now (it starts straight away)**, then choose **Add the task to** your project.

The CEO plans the work and may suggest hiring a researcher or a writer. See [Hiring your first team](/guides/hiring-your-first-team).

## If a task has no result

If **What it produced** is empty when the task reaches Review, the reviewer is told so and sends the task back, asking for a wiki page. If a task seems stuck, see [If nothing starts](/guides/first-company-and-ticket#if-nothing-starts).
