---
title: Checks and check workers (code companies)
description: For companies whose agents write code. What a check is, when you do not need one, how to choose it, what a check worker is and when it helps, and the git token agents use to save their work.
group: Set it up your way
order: 7
lead: A check is an automatic test Boss Man runs on finished code before it joins the project. You only need one if your agents write code.
---

## Do I need a check?

**No, if your company does not write code.** A company whose projects have no repository (the online folder where code is kept), such as one that writes reports or research, never runs a check. If you pick **Documents, research and writing** in the setup wizard, it leaves out the **A git token** and **Checks before merging** steps, so there is nothing to skip.

**No, if you would rather rely on reviews alone.** Choose **Nothing: merge after review only**. Approved work then joins the project as soon as its reviews pass. This is fine for a project with no tests, or one where a mistake is easy to put right.

**Yes, if your code has tests.** A check catches a change that breaks something before it reaches your project, so one agent's slip does not stop the others.

## What a check does

1. An agent finishes a task, and another agent reviews it.
2. Once the reviews approve it, the task joins the merge queue. There, Boss Man runs the project's check on the finished code.
3. If the check passes, Boss Man merges the work: it joins the main version of the project.
4. If it fails, the task goes back to **In progress**. The agent is told which command failed, fixes it, and asks for review again. You do not need to do anything.

Agents can also ask for a quick check of their own work before review. Those appear on the **Merge queue** page, under **Quick checks**. See [Reviews and the merge queue](/guides/reviews-and-merge-queue#the-merge-queue).

## Choosing the check

In the setup wizard's **Checks before merging** step:

1. Boss Man looks at your repository and suggests a check under **Before merging, Boss Man will**, such as running the project's tests. Choose the suggestion, **Nothing: merge after review only**, or **Custom command…** to type your own.
2. Optionally, under **For high-risk work, also**, choose a slower, fuller check for high-risk work.
3. If the list looks wrong for your project, choose **Re-detect**.

If the page says "The runner doesn't have" a tool the check needs, pick another check, or ask the CEO to add the tool to the runner.

To change it later, open **Projects**, choose **Edit settings** on the project, and use the same two lists.

## Where checks run, and memory

Checks run on [the runner](/guides/the-runner), beside your agents. Each check needs about 3 GB of memory there, on top of 1 GB for each agent. The memory line in **Settings → Server and runner → Limits and checks** tells you how many agents fit with a check beside them, for example "This machine can run 6 agents at once, or 3 agents plus 1 check."

**Checks at once**, on the same page, sets how many checks the runner runs together. The default is 1.

## Check workers: another machine for checks

A check worker is a second machine that runs checks for you, so they do not wait in line or take memory from your agents. It runs checks only: no agents, and it holds none of your keys. Your code only ever joins the project from your main Boss Man machine.

**When it helps:**

- checks often wait in line on the **Merge queue** page
- the memory line says there is "no room for a check" beside your agents
- you have a spare computer, such as a NAS, with memory to share

**What it needs:** Docker with its Compose plugin (version 2.23.1 or newer), and about 5 GB of memory for each check at once plus 2 GB for the machine itself: 8 GB for 1 check, 12 GB for 2. It runs your project's tests, so use a machine you trust with your code. It connects out to Boss Man, so you do not open any ports.

**To add one:**

1. Open **Settings → Server and runner → Limits and checks**. In the **Checks** section, choose **Add a check worker**.
2. Give it a name, tick the company, set **Checks at once on this machine**, and choose **Add**.
3. Choose **Copy compose file**. The file contains the worker's key, so keep it private.
4. On the other machine, save it as `compose.yaml` in an empty folder and run `docker compose up -d` there. On TrueNAS, Portainer or Dockge, paste it into their compose editor instead.
5. Within a few minutes the worker shows as connected in the **Checks** section.

After a runner update, a check worker needs nothing. If the **Checks** section says a worker is "Out of date", redeploy it on that machine. The full steps are in [`docs/34-check-workers.md`](@repo/blob/main/docs/34-check-workers.md).

## Git token

A git token is a key from GitHub or Gitea that lets agents save work to your repository. You add it in the setup wizard's **A git token** step. The wizard's **How do I get a token?** shows these steps for your host.

**On GitHub** (a fine-grained personal access token):

1. Open GitHub → **Settings** → **Developer settings** → **Personal access tokens** → **Fine-grained tokens** → **Generate new token**.
2. Name it, for example boss-man, and pick an expiry. 90 days is a sensible default.
3. Under **Repository access**, choose **Only select repositories** and pick this project's repository.
4. Under **Repository permissions**, set **Contents**, **Pull requests**, **Workflows** and **Actions** to read and write. **Metadata** is added as read-only by itself.
5. Generate it and copy it. GitHub shows it only once.

**On Gitea:** open **Settings → Applications → Generate New Token**, name it, and set the repository scope to Read and Write.

Then, in Boss Man, paste the token, save it, and choose **Check the token against** your project. Success is "The token can read and push to the repo."

**When it stops working.** When a token expires, merges fail. Choosing **Check the token against** then says "The host refused the token (HTTP 401/403)". Make a new token the same way and save it over the old one under **Settings → Secrets**, as **Git token (GitHub or Gitea)**. To avoid this, put a reminder in your calendar a few days before the expiry you chose.

| The check says | What to do |
|---|---|
| "The host refused the token" | It is wrong or has expired. Make a new one. |
| "The token can't see the repo" | Give the token access to this repository, and check the project's repository address. |
| "The token can read the repo but not push to it" | Set **Contents** to read and write (on Gitea, the repository scope to Read and Write). |
| "It can't read GitHub Actions runs" | Set **Actions** to read and write on the token. |

Paste tokens only into Boss Man's forms, never into a chat, a task or the wiki, because agents can read those.

## Related

- [Reviews and the merge queue](/guides/reviews-and-merge-queue): what happens to finished work before and after the check.
- [Your agents' workspace (the runner)](/guides/the-runner): where checks run, and how much memory they need.
- [Your first company and task](/guides/first-company-and-ticket): the setup wizard, step by step.
