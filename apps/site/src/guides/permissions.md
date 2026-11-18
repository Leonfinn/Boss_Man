---
title: Permissions and the CEO-first rule
description: See who Boss Man asks when an agent wants to run a command, how to answer a permission card, and how to add a rule.
group: Set it up your way
order: 6
lead: Agents can use Boss Man's tools, read, search and edit files in their own workspace, fetch web pages and run ordinary shell commands without asking. Pushing, publishing, deleting and anything Boss Man cannot place come to you or to the CEO as a card on Decisions.
---

This guide explains who is asked and how to add a rule.

## Who is asked

Boss Man checks every request an agent makes, whether it is a command, a file change or a tool, in this order:

1. **Network guard.** Requests to addresses agents must not reach, such as your home network or the Boss Man machine, are refused. No rule can lift this.
2. **Built-in guards.** Pushing, publishing and destructive commands come to you. Deleting the agent's own entries directly in /tmp runs at once. You can turn this off under **Settings > Permissions**, in **Cleaning up temp files**. Other deletes in /tmp, and deletes in the agent's own folder (its working copy of the project), go to the CEO first. If the agent has no working copy of its own, that delete comes to you. Removing Boss Man's own entries in /tmp, such as a check slot, goes to the CEO.
3. **Your rules.** Your **Deny** rules refuse a request, even one a guard caught. Then your **Allow**, **Ask the CEO** and **Ask me** rules are checked in the order shown on the Rules page, and the first one that matches decides. An Ask rule can change who is asked about a guarded request. An Allow rule cannot let a guarded request run, apart from the **Always allow commands that only work in /tmp** switch (off by default).
4. **Built-in allows.** These run at once, with no card: Boss Man's own tools; reading, searching and editing files; fetching web pages; and any other shell command. Ask rules do not apply to anything on this list.
5. **No match.** A command, or a tool Boss Man does not recognise, goes to the CEO first. A delete, a move, or a request that names a path comes straight to you.

![A flow chart of the five checks, in order, that decide whether Boss Man refuses a request, runs it, or asks the CEO or you.](/img/who-is-asked.svg =1160x670 narrow=/img/who-is-asked-narrow.svg:360x1590 "Who is asked when an agent wants to run a command.")

This is the CEO-first rule. The CEO has five minutes to settle a request. If it does not, the card moves to you, marked "Boss Man tried the CEO first". A request from the CEO itself always comes to you. If the company has no CEO, or the CEO is paused, requests come straight to you.

A request does not wait for ever. If nobody answers within 10 minutes, the agent's runner gives up and treats the request as denied.

## Answering a permission card

A permission card explains the command in plain words, in up to three rows: **Does** (what the command does), **For** (why the agent wants it) and **Command** (the exact command). A line under each button says what happens if you press it. The buttons are:

- **Allow once**: this run only
- **Always allow this exact command**: offered only for read-only commands under 250 characters with no secrets in them
- **Always allow** a tool from one of your tool servers
- **Deny**

Before you press an Always button, choose whether it covers that agent only (the default) or every agent in the company. An Always rule never covers pushes or destructive commands.

## Rules

Open **Settings > Permissions** and find **Permission rules**. You can:

- choose whether a rule applies to every company or to one
- give a rule one of four outcomes: **Allow**, **Ask the CEO**, **Ask me** or **Deny**
- describe a rule in plain words and choose **Ask the CEO to draft it**, which brings a Proposed rule card to Decisions
- write a rule yourself under **Advanced: write the rule yourself**
- test a command under **Try a command**

## Advice on permission cards

Boss Man can suggest which button to press. Under **Settings > Permissions**, find **Advice on permission cards**:

- **Advise**: shows a recommended button and the reason
- **Watch**: records what it would suggest without showing it (the default)
- **Off**

The advice only picks a suggested button. It never answers a card for you.

You can also turn on a **Second opinion**. It can only make the advice stricter, and it never answers a card.

## Agent fence

The **Agent fence** keeps agents away from the runner's key and the company's git login. Set it under **Settings > Permissions**.

## Standing rules

Standing rules are different. They are a block of text, up to 2,000 characters, that every agent reads at the start of each run, such as "never write a token to a file". Edit them under **Settings > Team and CEO**.
