---
title: How Boss Man works
description: The parts of Boss Man and how they fit together: companies, agents, the runner, projects, tickets, Decisions, reviews and the merge queue.
group: Start here
order: 1
lead: Boss Man is a web app you run on your own Linux machine. This page explains the parts and how they fit together.
---

Boss Man is a web app you run on your own Linux machine. You use it to plan your software and have AI agents build it in your git repositories. Agents are grouped into companies, each with its own team, runner and secrets. This page explains the parts and how they fit together.

## Companies and agents

A company is a team of agents with its own runner, secrets and budget. Every company has a CEO agent, which plans the work, writes tickets, assigns them and reviews simpler work. You hire the other agents from ready-made roles.

Each agent is a session of Claude Code, Codex or OpenCode with a role, instructions and a model.

## The runner

The runner is the container where a company's agents work. Each company has one. It connects out to the Boss Man server, so it needs no open ports. Agents work on a separate copy of the repository for each ticket.

## Projects and tickets

A project is one git repository. A ticket is one piece of work in a project. Each ticket has a title, a description, a risk level and up to 10 "Done when" lines that say what finished means.

A ticket is always in one of six states: backlog, ready, in progress, blocked, review or done.

## Decisions

Decisions is the page where Boss Man asks you things. Plans to approve, permission requests, sign-offs on high-risk work and questions all arrive there as cards. Each card offers its own buttons.

## Reviews and the merge queue

When an agent finishes a ticket, another agent reviews it. Approved work joins the merge queue, where Boss Man runs the project's checks and merges it if they pass. High and critical work also needs your sign-off.

![A ticket's path: it starts in the backlog, is built by an agent, is reviewed by another agent, goes through the merge queue and ends as done.](/img/tickets-path.svg =1160x560 narrow=/img/tickets-path-narrow.svg:360x1016 "A ticket's path from backlog to done.")

## What you do

You set up the companies and accounts, answer Decisions, and sign off high-risk work. Agents do the rest and come to you when they need you.

To set up your first company, see [Your first company and ticket](/guides/first-company-and-ticket). To see where the work and the questions appear, see [The board and Decisions](/guides/board-and-decisions).
