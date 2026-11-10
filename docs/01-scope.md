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
  - *Spike S2 found:* both adapters reject unlisted models over ACP. The override is therefore applied when the agent starts:
    - **Claude:** `ANTHROPIC_DEFAULT_{OPUS,SONNET,HAIKU,FABLE}_MODEL`.
    - **Codex:** `CODEX_CONFIG.model`.
  - Both worked in the spike.
- **R9.** Runner images are rebuilt on a schedule (weekly by default) and on demand, to pick up new Claude Code and Codex releases.
- **R10.** Claude credentials, in order of preference:
  1. A `claude setup-token` one-year token. It is stored in the secrets store and injected as `CLAUDE_CODE_OAUTH_TOKEN`.
  2. Anthropic's own login, completed inside the runner through a relayed terminal.
  3. An API key.

  The product never handles a Claude login itself.
- **R11.** Agents reach Boss Man only through its **MCP server**. Tools include `create_ticket`, `raise_decision`, `request_engagement` and `report_key_result`. No agent prompt depends on status names.

### Companies, security and secrets

- **R12.** Each company has its **own runner container**, its own workspace volumes and its own secrets.
- **R13a.** When a token is saved, Boss Man strips whitespace and checks it with a cheap test call. Spike S2's first real run failed with HTTP 401 because a pasted setup-token held a stray whitespace character.
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
- **R22.** ACP permission requests (`session/request_permission`) go through the rules engine. They are answered automatically within policy, and otherwise become decision-queue rows. A verdict that can't reach the runner never fails silently: the queue row shows it wasn't delivered, and the run is flagged.

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
  - **API credit:** $200 a month, reset on the billing date. In v1 it is tracked from **Boss Man's own run records**, the per-run `cost` and `total_cost_usd` figures, which are list-price amounts and API-key usage is billed at list price. The owner's Console account is an individual account, and the Admin API (`cost_report`) is unavailable for those; spike S3 confirmed this on 2026-10-16. Optional later: set up a Console organisation and an admin key so spend made outside Boss Man is included too.
  - **Subscription quota:** the Claude 5-hour and 7-day windows, and the Codex primary and secondary windows.
  - **Pay-as-you-go API key**, optional.
- **R28.** **Budgets.** A budget is set per company, per project or per agent, against a funding source. Its window is the billing cycle, a calendar month, a rolling period or lifetime. Thresholds can be soft or hard. A hard stop pauses the scope.
- **R29.** **Estimated costs.** Each run records an API-equivalent cost estimate (from `total_cost_usd` and token usage), which lets projects be compared even on subscription usage.

### Operational safety (added after the Kandev review, 2026-10-16)

These requirements come from failure modes the Kandev project ran into and wrote down (see [04-research.md](04-research.md#f-kandev-review-2026-10-16)). Our plan had none of them.

- **R30. Launch safety.**
  - Concurrency ceilings per instance, per company and per agent.
  - A limit on how deep a chain of wake-ups can go, so one agent waking another can't loop for ever.
  - A rate limit on an agent waking itself.
  - A kill switch for each company and one for everything.
  - Launches start in priority order.
  - All of this must ship **before** event-driven wake-ups (Phases 3–4).
- **R31. Runner event delivery.**
  - Runner events carry sequence numbers.
  - The runner keeps a journal and replays any events the server hasn't acknowledged after a reconnect.
  - A liveness heartbeat detects a connection that has died silently.
- **R32. Stalled runs.** A running agent that sends no events for a set time (5 minutes by default) creates a decision-queue row. It only advises: it never cancels the run on its own.
- **R33. Provider errors.**
  - Errors are classified as transient or hard.
  - A quota or account block holds the run until the window resets, rather than failing it.
  - Transient errors are retried with backoff.
- **R34. Cost accounting.**
  - `usage_update.cost` may be cumulative for each session. Kandev reports this; we haven't confirmed it yet. Boss Man records the change between updates and copes with a counter that resets.
  - Events with no price are flagged as unpriced, never treated as $0.
  - Budget alerts fire once for each policy, period and level.
  - Unattended runs get a default spending ceiling.
  - Before a run launches, a budget check that can't complete blocks the run.
- **R35. Upgrades.** Boss Man takes a database backup (`pg_dump`) before applying migrations, and records the schema version.
- **R36. A small MCP surface.**
  - Each session gets a small, always-available set of tools.
  - The UI shows how many tokens the tool definitions cost.
  - Writes an agent seldom needs may move to a signed per-run CLI later.
  - Long-running tools never block. They re-wake the agent instead, or, if they must block, send progress at least every 20 seconds (Claude Code aborts a silent HTTP MCP call after 300 seconds, according to Kandev's notes).

### Working with agents' code (added after the Cline kanban review, 2026-10-16)

These come from cline/kanban (Apache-2.0) and its issue tracker; see [04-research.md](04-research.md#g-cline-kanban-review-2026-10-16).

- **R37. Steer and stop a running agent.** The owner can send a message into a running agent's session (ACP `session/prompt`) or stop it (`session/cancel`), from the run view and from a stalled-run row. A CEO can do the same for its own company's runs through MCP.
- **R38. Git workspaces.** Each ticket that touches a repo gets its own git worktree on its own branch, created from a pinned base commit.
  - Creation is serialised per repo.
  - A worktree is never recreated because the base moved.
  - Before a worktree is cleaned up, its uncommitted changes (tracked and untracked) are saved as a patch and re-applied on resume.
  - Provisioning copies an allowlist of files only. It never copies or links ignored files such as `.env`; secrets arrive only through grants.
  - Engagement deliverables that are code are git refs from these branches.
- **R39. Review has something to review.**
  - The `review` state carries a diff against the ticket's base.
  - Each agent turn records a checkpoint commit under a private ref (`refs/bossman/checkpoints/<ticket>/<turn>`), so "what changed in the last turn" is visible. The checkpoint leaves the working branch and index untouched.
  - Line comments go back to the agent as one message, in the form `path:line`, then the code, then the comment.
  - The CEO reviews by default; the owner reviews when the rules say so, for example for production.
  - Commit and PR steps are prompts to the agent, using templates the owner can edit.
- **R40. Plan-first tickets.** A ticket can start in plan mode. The agent's request to leave plan mode (an ACP permission request) becomes a decision-queue row showing the plan. Approving it moves the session to edit mode.
- **R41. A failed run never looks done.** A run that fails leaves its ticket where it was and says so on the card. Only an explicit `set_ticket_state` or an owner action moves a ticket to done, and done always records completed or cancelled.
- **R42. Resume after a crash.** A run interrupted mid-tool-call must resume cleanly, or restart with a summary of what it had done. A saved session can't be left with a tool call that has no result. Spike S4 checks whether the ACP adapters' `session/load` tolerates that.
- **R43. The UI can't slow agents down.**
  - Browser streams are separate from the runner journal, use bounded buffers, and batch their frames.
  - Long run transcripts are virtualised.
  - All autonomy (wake-ups, auto-advance, sweeps) runs on the server, never in the browser.
- **R44. Owner notifications.** When something enters the decision queue, the owner gets a browser or PWA notification, unless a Boss Man tab is already visible.
  - **Levels** (from Nimbalyst): note (feed only), flag (notification), page (notification and phone push) and ask (needs an answer).
  - **Caps:** each agent has a cap on how often it can notify.
  - **Quiet hours** demote a notification to a lower level rather than drop it.
  - **Evidence:** every notification links to its evidence.
  - **Phone push** uses Web Push (Boss Man only sends outbound requests) or a self-hosted ntfy reached over Tailscale. Boss Man is never exposed at the router.
  - **What reaches the phone (BOS-1006):** by default only urgent cards, at ntfy priority 5: a decision that blocks work only the owner can answer, a deploy carrying the fix for a live problem, a page, and the test push. Routine cards stay in the app. Settings → Notifications → "Send to my phone" can switch to "All decisions", which sends routine ones at priority 3. The "Flags" tick is separate. Quiet hours still lower an urgent ask to a flag first.
- **R45. Web hardening.** WebSocket upgrades check `Origin` and `Host`. Login has a rate limit and a lockout after repeated failures.

### From the Nimbalyst and Aperant reviews (2026-10-16)

See [04-research.md](04-research.md#h-nimbalyst-review-2026-10-16) sections H and I.

- **R46. Merging a ticket's branch.**
  - The merge is tried in a throwaway worktree with `git merge-tree`, against a target branch named explicitly.
  - Success is judged by exit codes, never by output text.
  - A conflict goes to a resolver agent working in the ticket's own worktree, and the result has to pass the ticket's checks.
  - The review shows any predicted conflicts beforehand.
  - A merge closes the ticket.
  - Boss Man never runs `git clean` or `reset --hard` outside a ticket's worktree. Aperant #1477 deleted users' untracked files that way.
- **R47. Verification before done.** A ticket can carry a verify command, such as `pnpm test`. It must pass in the worktree before the ticket can move to done. This extends R41 and the key-result `check` method.
- **R48. Risk tiers.** Each ticket is rated trivial, low, medium, high or critical. The rating sets:
  - who reviews it (the CEO, or the owner for high and critical);
  - how deep the checks go;
  - whether it runs in staging first.

  Docs-only tickets skip QA.
- **R49. Bounded review loops.**
  - Review-and-fix rounds are counted.
  - A finding that is rejected three times, or three errors in a row, becomes a decision row instead of another round.
  - The reviewer is a different agent or model from the coder.
- **R50. Looping runs.** A run that keeps hitting the same error (the same error signature three times in two hours) is flagged as a circular fix. Its next attempt must take a different approach. This catches busy-but-stuck runs, which R32's silence check misses.
- **R51. Untrusted content.**
  - Text from another company's engagement thread, from web fetches and from tool output is labelled untrusted in the agent's prompt.
  - It can't change policy or decision tiers.
- **R52. Image canary.** A rebuilt runner image passes the S2 smoke run before it replaces the current image, and the previous image is kept for rollback. Aperant #1864 broke users' tasks when its agent SDK added a new message type. Boss Man's runner already ignores ACP update types it doesn't know.
- **R53. Instance-wide spend cap.** A cap across all companies sits above the per-company, project and agent budgets (R28). Each ticket also has a cumulative cost ceiling across all its runs, because review and retry loops multiply runs.
- **R54. Workspace clean-up.** Worktrees of tickets done more than N days ago are removed, with their branches kept. Each company has a disk cap, and orphaned worktrees are pruned on runner start.

**Additions to existing requirements:**
- **R11:** MCP tools accept common synonyms (done, finished, complete) and return precise validation errors, so an agent can retry.
- **R22:** a permission row offers "approve and make this a rule".
- **R24:** threads never expose one company's internal ticket keys or IDs to the other.
- **R27:** when a subscription's 5-hour window is full, work can fall back to API credit, within budget. This only uses the owner's own accounts.

- **R13b (later). Credential leases.** Git and deploy credentials can be handed out as short-lived, scoped leases that are revoked when the run ends, on top of grants.

## Scope by release

| Release | Contents |
|---|---|
| **v1** | Launch safety (R30), the runner journal (R31), stalled-run rows (R32), provider-error holds (R33) and cost-accounting hygiene (R34). Companies, projects and tickets. The mapped kanban. Claude Code and Codex agents over ACP. CEO onboarding. The decision queue with stale blockers and the default rules. Minimal engagements. Objectives and key results. The API-credit budget. The data model for secrets and grants. Deploy targets. |
| **v1** (added 2026-10-16) | Steering and stopping runs (R37), git workspaces (R38), review with diffs and comments (R39), failed runs never done (R41), resume after a crash (R42), a UI that can't stall agents (R43), owner notifications (R44) and web hardening (R45). |
| **v1** (added 2026-10-16, second batch) | Merging (R46), verification before done (R47), bounded review loops (R49), looping runs (R50), untrusted-content labels (R51), image canary (R52), instance and ticket spend caps (R53) and workspace clean-up (R54). |
| **v1.1** | Risk tiers (R48). A notification ladder with quiet hours (R44). CEO continuity: notes and a journal in files, with chapters that roll at 70% context or after 7 days, each with a handoff summary, and the directive frozen per chapter so prompt caching holds. Planning depth graded by ticket complexity. Roadmap and plan views. Configurable CEO decision rules. The secrets management screen. Plan-first tickets (R40). Last-turn diffs from checkpoints (R39). An owner chat that turns plain language into tickets and links, with board tools only. |
| **Later** | Per-company packs: declarative bundles of skills, commands and MCP tools. They are off by default, run inside the company's runner, and are distributed with mandatory checksums and signatures. Until then, MCP tool names stay namespaced. A lessons store, where lessons the owner approves feed later runs, with a trust gate on anything learned from the web. Ideation into draft tickets. Issue triage. Evidence-checked review. File-overlap-aware scheduling. A Paperclip importer, using Paperclip's company export. More ACP agents. A review before any public release, covering Anthropic policy, Claude Code redistribution and multiple users. |
