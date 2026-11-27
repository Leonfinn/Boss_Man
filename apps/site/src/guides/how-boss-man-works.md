---
title: How Boss Man works
description: The parts of Boss Man and how they fit together: companies, agents, the runner, projects, features, tasks and sub-tasks, Decisions, reviews and the merge queue.
group: Start here
order: 1
lead: Boss Man is a web app you run on your own Linux machine. This page explains the parts and how they fit together.
---

Boss Man is a web app you run on your own Linux machine. You use it to plan your software and have AI agents build it in your git repositories. Agents are grouped into companies, each with its own team, runner and secrets. This page explains the parts and how they fit together.

## Companies and agents

A company is a team of agents with its own runner, secrets and budget. Every company has a CEO agent, which plans the work, writes tasks, assigns them and reviews simpler work. You hire the other agents from ready-made roles.

Each agent is a session of Claude Code, Codex or OpenCode with a role, instructions and a model.

## The runner

The runner is the container where a company's agents work. Each company has one. It connects out to the Boss Man server, so it needs no open ports. Agents work on a separate copy of the repository for each task. You can add check workers on other machines to run checks. See [Your agents' workspace (the runner)](/guides/the-runner) for why it is kept separate and what to do if it stops.

## Projects and tasks

A project is one git repository. A task is one piece of work in a project. Each task has a title, a description, a risk level and up to 10 "Done when" lines that say what finished means. Agents and some pages also call a task a ticket: it means the same thing.

A task is always in one of six states: backlog, ready, in progress, blocked, review or done.

## Features, tasks and sub-tasks

A feature is what your users get. A task is the work that builds it.

**Feature**: something users would notice or ask for, such as "Dark mode". Features are kept on the **Features** page. Each one has:

- a status: Idea, Considering, Planned, In progress, Released or Declined
- demand, from the feedback linked to it
- an effort, from 1 (tiny) to 5 (huge)
- a priority, worked out from demand, your own scores and effort

A feature can sit on the roadmap and on the public feedback portal. A feature does no work by itself: one or more tasks deliver it. Agents sometimes call it a feature request.

**Task**: one piece of work an agent does in a project, with Done when lines, a risk level and a review. One or more tasks deliver a feature: a small feature needs one task, a bigger one needs several.

To link a task to a feature, choose the feature under **Part of feature** when you add the task, or later on the task's page under **Roadmap, feature and dependencies**. When the first task of a feature starts, the feature moves to In progress. When all its tasks are done, it moves to Released. If the company has a production deploy target, it also waits until one of its tasks has been deployed there.

Work that is not a feature, such as an internal fix, a test or a server chore, is a task with no feature.

**Sub-task**: a task under a bigger task. Agents split a task when the work splits naturally: different parts, different agents, or parts that need their own review or risk level. The parent task waits, in Blocked, until its sub-tasks are done. A sub-task cannot have sub-tasks of its own. On the board it is marked **Sub-task** and names its parent. Most tasks are not split.

### An example

- **Feature**: "Sign-up that works on phones"
- **Task 1**: Redesign the sign-up form for small screens
- **Task 2**: Send the confirmation email as a link that opens on the phone
- **Task 1 is split into sub-tasks**: one to draw the new form, one to build it

Task 1 waits until both of its sub-tasks are done. When Task 1 and Task 2 are done, the feature shows as Released.

### Which one to add

- Add a **feature** for something you want your users to get. You can rank it and put it on the roadmap before any work starts.
- Add a **task** for a specific job you want done now, such as fixing a bug or building one part of a feature.

Not sure yet? Write a rough draft and choose [Let the CEO question me first](/guides/first-company-and-ticket#let-the-ceo-question-you-first). The CEO asks a few questions, then adds the feature or task for you.

## Decisions

Decisions is the page where Boss Man asks you things. Plans to approve, permission requests, sign-offs on high-risk work and questions all arrive there as cards. Each card offers its own buttons.

## Reviews and the merge queue

When an agent finishes a task, another agent reviews it. Approved work joins the merge queue, where Boss Man runs the project's checks and merges it if they pass. By default, high and critical work also needs your sign-off, and you approve its plan first. Change this in **Settings › Reviews**.

![A task's path: it starts in the backlog, is built by an agent, is reviewed by another agent, goes through the merge queue and ends as done.](/img/tickets-path.svg =1160x560 narrow=/img/tickets-path-narrow.svg:360x1016 "A task's path from backlog to done.")

## What you do

You set up the companies and accounts, answer Decisions, and sign off high-risk work. Agents do the rest and come to you when they need you.

To set up your first company, see [Your first company and task](/guides/first-company-and-ticket). To see where the work and the questions appear, see [The board and Decisions](/guides/board-and-decisions).
