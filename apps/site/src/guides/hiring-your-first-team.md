---
title: Hiring your first team
navTitle: Your first team
description: Which agents a small research or writing team and a small software team need, what the model and thinking settings mean for cost and quality, and how to read the CEO's team plan card.
group: Start here
order: 4
lead: A new company starts with the CEO alone. For a small team, hire two or three agents to begin with. The CEO usually suggests who to hire on a card, and you tick the ones you want.
---

## Who you start with

Every new company has two agents:

- **The CEO** plans the work, splits it into tasks, hands them out and reviews simpler work. You don't hire it.
- **A Wiki Maintainer**, which starts paused. It keeps the company's wiki tidy once you turn it on.

The CEO can do small tasks itself, but it is meant to hand work on. So hire at least one agent who does the work.

## Who to hire

Start small. You can hire more later, and the CEO suggests hires when the work grows.

### A research or writing team

| Role | What it does |
|---|---|
| **Researcher** | Finds things out and writes them up in the wiki. |
| **Writer** | Writes documents, guides and announcements. |
| **Product Manager** (optional) | Turns a rough idea into a short brief and well-formed tasks, in order of priority. |

Other roles that suit any kind of work: **Data & Analytics**, **Support**, **Scrum Master** and **Assistant**.

### A software team

| Role | What it does |
|---|---|
| **Engineer** | Builds and fixes things in the project's repo. |
| **Senior Developer** | Reviews plans and code for risky or complex work, and builds the hardest pieces. |
| **QA** (optional) | Tests work before it ships and reports what breaks. |

Other roles for code: **Designer** (screens and flows for an app), **Security Reviewer**, **Adversarial Reviewer**, **Senior Infrastructure Engineer** and **Release Manager**. If the words repo, branch and merge are new, see [Code words for owners](/guides/code-words).

### Do I need a reviewer?

No. Every task is reviewed before it counts as done, but if you have hired no reviewer, the CEO reviews it. For medium-risk and higher work, Boss Man asks a Senior Developer if you have one. For high and critical work, you sign off as well. See [Risk levels](/guides/reviews-and-merge-queue#risk-levels).

A reviewer you hire reviews only once you name them in **Settings > Reviews**.

## The CEO's team plan card

When you add a project, an objective or a milestone, the CEO checks on its next run whether the team covers the new work. You can also ask the CEO in chat to propose a team. If it doesn't, it puts one **team plan** card on **Decisions**. A team plan always waits for you: nobody is hired until you say so.

The card reads like this:

1. **The heading** says how many agents the CEO proposes and for what, for example "Hire 3 agents for Client reports?".
2. **Already covered** says which work your current agents can do already.
3. **The cost line** says what the hires cost on the account that pays for them. On a Claude plan it says there is no extra cost, because agents use the plan's allowance. On an API key you pay as you go, for the work they do.
4. **One row per hire** gives the agent's name, its role and a plain line on what it will do. Each row has a tick box, and every row starts ticked.
5. **Technical details** is folded shut. Open it to see each hire's agent program, AI provider, model and instructions. You don't need to open it to decide.

Untick anyone you don't want. Then choose **Hire the 3 ticked**: the number follows your ticks. To hire nobody for now, choose **Not now**. If some hires fail, Boss Man tells you who was hired and who wasn't, and why.

You can change any agent later: open **Agents**, then the ⋯ menu on its row, and choose **Edit**.

## Hiring an agent yourself

1. Open **Agents** and choose **Hire**.
2. Under **Start from**, pick a role. Roles for any kind of work are listed first, under **For any kind of work**, and roles for code after, under **For code**. Or choose **Blank** to write the job yourself.
3. Give it a **Name**. Leave **Agent** on Claude Code unless you use another AI account.
4. Leave **Model** and **Thinking** on **Default** to start with (see below).
5. Under **Paid from**, pick the funding source it runs on. See [What agents cost](/guides/what-agents-cost).
6. Read the **Instructions** and change them to fit your company.
7. Choose **Hire**. The button shows the name you typed, for example **Hire Sam**.

## Model and thinking: cost and quality

Two settings on each agent change how good its work is and how much it uses.

**Model** is the AI that does the work. A more capable model handles harder, longer work with fewer mistakes, but each piece of work costs more, or uses up more of a plan's allowance. A faster model is cheaper and quicker, and is good enough for routine work such as status updates.

Each role suggests a kind of model in the **Start from** list ("Suggested model: …"). Picking a role does not choose a model for you:

- **Most capable**: Senior Developer, Security Reviewer, Adversarial Reviewer, Senior Infrastructure Engineer. The CEO's role suggests this kind too.
- **Balanced**: Engineer, Researcher, Designer, QA, Writer, Product Manager, Data & Analytics.
- **Fast**: Scrum Master, Assistant, Release Manager, Support.

The **Model** list shows what your account offers. **Default** uses the agent program's own default.

**Thinking** is how hard the model thinks before it answers: **Default**, **Low**, **Medium**, **High**, **Extra high** or **Max**. More thinking helps with tricky work but is slower and uses more. Not every model offers every level. A level the model doesn't offer is left at its default.

A good start: leave both on **Default**. If an agent's work keeps coming back from review, try a more capable model or more thinking. If an agent only does simple work, try a faster model to save money or allowance. To see what each agent has used, see [What agents cost](/guides/what-agents-cost). For every model and account option, see [Agents and models](/guides/agents-and-models).
