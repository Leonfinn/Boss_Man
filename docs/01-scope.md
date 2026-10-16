# 01 — Scope

## Problem

The owner runs several AI-agent "companies" in Paperclip. One builds apps and another runs the homelab. Paperclip handles much of this well. Its friction points, all confirmed in its code (see [04-research.md](04-research.md)), are:

1. **Companies are fully isolated.** One team cannot ask another for work. For example, the app team cannot get the homelab team to deploy, unless the owner copies and pastes instructions between them.
2. **The kanban is fixed.** It has seven hard-coded statuses and no custom columns or fields.
3. **Setup glitches:**
   - Onboarding creates the CEO with the `general` role. That role lacks the CEO's hiring, assignment and permission grants.
   - Claude subscription sign-in keeps only a short-lived access token, so it expires after roughly 8–12 hours. A one-year token cannot be supplied easily.
   - Model pickers lag behind new releases. For example, Opus 5.5 was not selectable.
4. **Decisions get buried.** There are four overlapping approval and decision systems. Tickets waiting on a decision sit in `in_review` among all the other tickets. The unified decisions page is an experiment that is switched off by default.
5. **Forgotten blockers.** Stale-blocker detection looks only at whether an agent is alive. A blocker assigned to a human is never flagged, however old it is.
6. **Budgets are inflexible.** Windows are lifetime or calendar month only. Subscription usage is recorded as $0, so budgets never fire for it.
7. **No objectives.** Goals are hidden behind a "to be removed" experimental toggle.
8. **No progress views.** There is no roadmap, milestone or plan view.

Sending these as pull requests upstream is impractical. Paperclip's CONTRIBUTING.md says uncoordinated core feature PRs may be closed. Cross-company features also appear in its Pro/Enterprise column.

## Goals

- **G1. Companies working together:** formal engagements between companies.
- **G2. A board that fits the work:** configurable boards that agents still understand.
- **G3. Setup that just works:** a real CEO from onboarding, sign-in that lasts, and model lists that are always current.
- **G4. Decisions surface:** one ranked queue that shows what each decision blocks and when it is due.
- **G5. Nothing is forgotten:** stale blockers escalate on their own.
- **G6. Real money and quota tracking:** funding sources, per-period budgets, and quota windows.
- **G7. Work anchored to outcomes:** objectives with measurable key results.
- **G8. Progress you can see:** roadmap and plan views.

## Non-goals (v1)

- Multiple human users, teams of humans, or a hosted or SaaS version.
- A "Sign in with Claude" flow. The owner always supplies Claude credentials.
- A fork of Paperclip, or compatibility with its API, plugins or database.
- Its own agent runtime. Agents are Claude Code, Codex and other tools, reached over ACP.

## Requirements

### Platform

- **R1.** It runs as one Docker Compose stack on **any standard Docker host**. The first deployment is TrueNAS SCALE (Debian 12 based).
- **R2.** It is written in TypeScript throughout: a Node server, a React UI and Postgres.
- **R3.** It has a single owner account in v1. It is reached over the LAN or Tailscale and is never exposed at the router.
- **R4.** It is licensed under Apache-2.0.

### Agents and models

- **R5.** Every agent connects through **ACP v1**. ACP v2 stays behind a feature flag until it is stable.
- **R6.** Claude runs as the **official, unmodified Claude Code** shipped in the runner image. The `claude-agent-acp` adapter drives it, pointed at that binary through `CLAUDE_CODE_EXECUTABLE`.
- **R7.** Codex runs through `codex-acp`. Other ACP agents (Gemini CLI, OpenCode and so on) can be added through configuration.
- **R8.** Model lists come from each agent's ACP `configOptions` (category `model`). A **free-text model override** is always available. Nothing is hard-coded.
- **R9.** Runner images are rebuilt on a schedule (weekly by default) and on demand, to pick up new Claude Code and Codex releases.
- **R10.** Claude credentials, in order of preference:
  1. A `claude setup-token` one-year token. It is stored in the secrets store and injected as `CLAUDE_CODE_OAUTH_TOKEN`.
  2. Anthropic's own login, completed inside the runner through a relayed terminal.
  3. An API key.

  The product never handles a Claude login itself.
- **R11.** Agents reach Boss Man only through its **MCP server**. Tools include `create_ticket`, `raise_decision`, `request_engagement` and `report_key_result`. No agent prompt depends on status names.

### Companies, security and secrets

- **R12.** Each company has its **own runner container**, its own workspace volumes and its own secrets.
- **R13.** A **master secrets store** is owned by the owner. Companies receive **grants**, which are references to a secret rather than copies. Every use is logged. Rotating a secret updates every grant.
- **R14.** **Deploy targets** are named connections: an SSH host, a Docker endpoint or a git repo. Each has granted credentials and rules. The docs recommend a Docker socket proxy, GitOps or a restricted SSH user, never the raw `docker.sock`.
- **R15.** Any action that touches production goes through the decision tiers. Production deploys go to the owner by default.

### Work structure

- **R16.** The hierarchy is **Objective → Key results → Milestones → Tickets.**
  - Each key result has a target, a current value and a measurement method: manual, reported by an agent, or an automated check.
  - Milestones have target dates.
  - Tickets inherit due dates from their milestone.
  - Tickets that link to nothing are flagged as possible drift.
- **R17.** Board columns are configurable per project. Each column maps to one of six **system states**: backlog, ready, in progress, blocked, review and done. Done carries an outcome of either completed or cancelled. Projects can also have custom fields, swimlanes (by agent, objective or engagement) and column card limits.
- **R18.** Onboarding creates a CEO agent with the `ceo` role and the CEO's grants.

### Decisions and blockers

- **R19.** **Decision tiers.**
  - CEO agents decide within rules the owner sets, and escalate everything else. Examples of things that escalate are cost over a threshold, anything touching production, spending money, and irreversible or legal actions.
  - v1 ships with sensible default rules. The rules become configurable in v1.1.
- **R20.** **One decision queue** across all companies.
  - **Ranking:** items are ranked by an explainable score made of three parts:
    - how much the item blocks (direct and further down the chain, weighted by objective priority);
    - urgency (the nearest due date among the items it blocks);
    - age.
  - **What each row shows:**
    - the question;
    - which company and agent raised it;
    - the agent's **required recommended answer**;
    - what it blocks, which can be expanded into the chain;
    - the due date;
    - controls to answer it in place.
- **R21.** **Stale blockers** appear in the same queue. A stale blocker is one with no activity for longer than a threshold, which defaults to 24 hours. This includes blockers assigned to the owner. The queue offers three actions: chase it, reassign it, or drop the dependency.
- **R22.** ACP permission requests (`session/request_permission`) go through the rules engine. They are answered automatically within policy, and otherwise become decision-queue rows.

### Engagements (between companies)

- **R23.** An engagement goes through these stages:
  1. **Request.** Company A sets the scope, deliverables, acceptance criteria and an optional budget cap.
  2. **Response.** Company B's CEO accepts, rejects or counter-proposes. The owner may approve this step.
  3. **Work.** Company B creates its own internal tickets. Company A sees only the status and the thread.
  4. **Delivery.** Company B delivers.
  5. **Sign-off.** Company A signs off, or requests a revision.
- **R24.** The engagement thread is the only channel between companies. Deliverables are git refs, artifacts or instructions, never credentials.
- **R25.** Company A's tickets can be blocked by an engagement. This is how a blocker works across companies without a raw link between their tickets.
- **R26.** Costs are recorded against Company B's runs and **charged back to Company A's project**, up to the engagement cap.

### Cost and quota

- **R27.** **Funding sources.** Agents and projects are assigned to a funding source.
  - **API credit:** $200 a month, reset on the billing date. It is tracked through the Anthropic Admin API `cost_report`. This needs a Console organisation and an admin key.
  - **Subscription quota:** the Claude 5-hour and 7-day windows, and the Codex primary and secondary windows.
  - **Pay-as-you-go API key**, optional.
- **R28.** **Budgets.** A budget is set per company, per project or per agent, against a funding source. Its window is the billing cycle, a calendar month, a rolling period or lifetime. Thresholds can be soft or hard. A hard stop pauses the scope.
- **R29.** **Estimated costs.** Each run records an API-equivalent cost estimate (from `total_cost_usd` and token usage), which lets projects be compared even on subscription usage.

## Scope by release

| Release | Contents |
|---|---|
| **v1** | Companies, projects and tickets. The mapped kanban. Claude Code and Codex agents over ACP. CEO onboarding. The decision queue with stale blockers and the default rules. Minimal engagements. Objectives and key results. The API-credit budget. The data model for secrets and grants. Deploy targets. |
| **v1.1** | Roadmap and plan views. Configurable CEO decision rules. The quota display, if spike S1 succeeds. The secrets management screen. |
| **Later** | A Paperclip importer, using Paperclip's company export. More ACP agents. A review before any public release, covering Anthropic policy, Claude Code redistribution and multiple users. |
