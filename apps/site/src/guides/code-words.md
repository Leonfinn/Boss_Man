---
title: Code words for owners
navTitle: Code words
description: Repo, branch, merge and pull request in plain words, with a picture, and how to choose between "Merge into the default branch" and "Open a pull request" in the setup wizard.
group: Questions
order: 14
lead: Only for companies whose agents work on code. Four words come up again and again, repo, branch, merge and pull request, and this page explains each in a sentence or two.
---

You need this page only if you picked **Code in a git repository** in the setup wizard. If your team works on documents and research, see [Using Boss Man for work that isn't code](/guides/work-that-isnt-code) instead.

![A repo, a branch and a merge: the main version of the code runs along the top; a task's branch splits off it, collects the agent's saved changes, and joins the main version again when the work is approved.](/img/code-words.svg =720x340 "A task's branch splits off the main version of the code and joins it again when the work is approved.")

## Repo

A repo (short for repository) is the online folder where a software project's code is kept, on GitHub or Gitea. It also keeps every earlier version. In Boss Man, each code project has one repo. You paste its address into **Git repo** in the setup wizard, for example `https://github.com/you/repo.git`.

Agents need a **git token** to save their work to your repo. The wizard's **A git token** step sets it up.

## Branch

A branch is a separate copy of the code where one piece of work happens, without touching the main version. Boss Man gives each task its own branch, so two agents never change the same copy at once.

The main version is called the **default branch**. On most repos it is named `main`.

## Merge

A merge is finished, approved code joining the main version of the project. In Boss Man, a task's branch is merged only after its reviews approve it and Boss Man's **check** passes. A check is an automatic test that Boss Man runs on finished code before it joins the project. You choose it in the wizard's **Checks before merging** step.

After a merge the task is done, unless one of its **Done when** lines can only be checked once the change is live. See [Reviews and the merge queue](/guides/reviews-and-merge-queue).

## Pull request

A pull request is a request, made on GitHub or Gitea, to merge a branch into the main version. The merge then happens on that website rather than in Boss Man. People use pull requests when a repo only accepts changes that way, or when someone wants to look at each change there before it goes in.

## Merge or pull request: which to choose

In the wizard's second step, under **When work is approved**, you choose one of two:

| Choice | What happens after the reviews approve | Choose it when |
|---|---|---|
| **Merge into the default branch** | Boss Man runs the check, then merges the branch itself. The task moves to Done. | You want approved work to go in without another step. This suits most owners. |
| **Open a pull request** | Boss Man opens a pull request on GitHub or Gitea and merges it there if the site allows. If the site needs a person's approval first, the task waits in Review with the site's reason until the pull request is merged. If someone merges it on the site by hand, the task finishes. | Your default branch only accepts pull requests, or you want every change to go through GitHub or Gitea. |

You can change the choice later: open **Projects**, open your project, and change **When work is approved** on its **Config** tab.

When you review a task yourself, the button says which one you chose: **Approve and merge** or **Approve and open a pull request**.

## Other words you may meet

- **Commit**: one saved set of changes on a branch. Each dot on the branch in the picture above is a commit.
- **Clone**: a full copy of a repo, which an agent downloads to work on.
- **Push**: sending saved changes from that copy back to the repo online.
- **Merge conflict**: two branches changed the same lines in different ways, so they can't be merged automatically. Boss Man sends the task back to its agent to sort out.

For every other Boss Man word, see the [Glossary](/guides/glossary).
