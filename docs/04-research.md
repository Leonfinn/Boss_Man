# 04 — Research findings

These findings were checked on 2026-10-16. They come from reading source code and docs, and nothing was run. Anything marked **unconfirmed** could not be verified from a primary source.

## A. Paperclip (paperclipai/paperclip, HEAD `43ffe8c`)

### Architecture

| Area | Details |
|---|---|
| Repo layout | pnpm monorepo: `server`, `ui`, `cli`, `packages/*` (`db`, `shared`, `plugins/sdk`, `adapters/*`) |
| Server | Express 5, better-auth, drizzle-orm, and an embedded Postgres |
| UI | React 19, Vite, Tailwind 4, TanStack Query, dnd-kit |
| Size | About 7,500 TypeScript files and about 2.5 million lines including tests |
| Database | 169 schema files, 346 migrations |
| Pace | About 60 commits a day. The 200 most recent commits covered three days, with roughly 96k lines added and 16k removed |
| Releases | Stable releases weekly |
| Authors | Two people wrote about 85% of recent commits |
| Plugins | Out-of-process workers that can add tables, routes, UI slots, event handlers and agent tools. They **cannot** make approval decisions, override budgets, touch auth, or change the scheduler (`doc/plugins/PLUGIN_SPEC.md`) |
| Contributions | `CONTRIBUTING.md`: "Uncoordinated feature PRs against the core product may be closed". Extensions are directed to plugins |
| Commercial direction | Open core. A Paperclip Cloud waitlist, an "EE permissions extension" in the UI, and "Multi-company policy overlays" in the Pro/Enterprise column of `doc/SPEC-implementation.md` §9.6 |

### What the code shows for each pain point

1. **Isolation.**
   - Enforced only by a `company_id` column, with no Postgres row-level security, and about 300 `assertCompanyAccess` checks.
   - There is no messaging or sharing between companies. Tests explicitly deny blockers across companies.
   - Related issues: #2212, #1083, #1084, #15608.
2. **Kanban.**
   - `ISSUE_STATUSES` in `packages/shared/src/constants.ts:189` defines seven statuses.
   - The columns are hard-coded in `ui/src/components/KanbanBoard.tsx`.
   - Status literals appear in about 200 files and in the agents' own `skills/paperclip/SKILL.md`.
3. **CEO role.**
   - `ui/src/lib/onboarding-agent-role.ts` sets `DEFAULT_AGENT_ROLE = "general"`. The role picker was removed.
   - The `ceo` role grants agent creation, assignment and permission management, plus other permissions.
   - Related: issues #15315 and #13949, and fix PR #15368.
4. **Claude sign-in.**
   - "Connect" stores only the access token and drops the refresh token.
   - A setup-token runner exists, but the connection check needs the `user:profile` scope, and setup-tokens only have `user:inference`.
   - Related: issues #14182, #13805, #16459, and PRs #14698 and #15319.
   - A reported workaround is to store the setup-token as a company secret and reference it from `adapterConfig.env.CLAUDE_CODE_OAUTH_TOKEN`.
5. **Decisions.**
   - Four overlapping systems: approvals, `issue_thread_interactions`, decisions/decision queues, and execution decisions.
   - A ticket waiting on a decision is set to `in_review`.
   - The unified `/decisions` page sits behind the experimental flag `enableDecisions`, which is off by default.
   - Related issues: #3821, #9679, #7784.
6. **Blockers.**
   - Stalled-blocker detection is based on whether agents are alive.
   - A blocker assigned to a human is always treated as "covered", however old it is.
   - Related issues: #14897, #10406, #8109.
7. **Costs.**
   - Budgets cover company, agent or project scope, measured in `billed_cents`, over `calendar_month_utc` or `lifetime`.
   - Subscription usage is booked at **$0**: `run-cost-accounting.ts:86`.
8. **Goals.**
   - PR #9189 (merged 2026-07-07) hid them behind `enableGoalsSidebarLink`, under the heading "These features are going to be removed."
   - The data is still there. No replacement was found.
9. **Views.** There is a dashboard, an activity timeline, an org chart and a costs page. There is no roadmap, milestone or plan view.

## B. Claude authentication and policy

Sources: [authentication](https://code.claude.com/docs/en/authentication), [legal and compliance](https://code.claude.com/docs/en/legal-and-compliance), [Agent SDK overview](https://code.claude.com/docs/en/agent-sdk/overview), and [the support article on running claude -p with a plan](https://support.claude.com/en/articles/17154008).

- **`claude setup-token`:**
  - It produces a **one-year** OAuth token, used as `CLAUDE_CODE_OAUTH_TOKEN`.
  - It requires a Pro, Max, Team or Enterprise plan.
  - The token "can only make model requests".
- **The `/login` credentials** are short-lived and auto-refreshed. When several processes share them, the processes race on the rotating refresh token: anthropics/claude-code#73576 reports failures at about 12 hours with roughly 10 processes, and #88583 and #12447 describe the same problem.
- **What the policy allows:**
  - **Allowed:** running Claude Code or the Agent SDK *yourself* on your own plan. Such runs "use your plan's usage limits".
  - **Not allowed:** products that offer Claude.ai login, route requests through Free, Pro or Max credentials on behalf of their users, or "collect, store, or intermediate" Claude.ai credentials.
  - Advertised limits assume "ordinary, individual usage".
- **Claude Code licence:** "© Anthropic PBC. All rights reserved. Use is subject to Anthropic's Commercial Terms of Service" ([LICENSE.md](https://github.com/anthropics/claude-code/blob/main/LICENSE.md)).
- **How the adapter runs Claude Code:** `claude-agent-acp` launches the Claude Code executable through the Agent SDK's `pathToClaudeCodeExecutable`. That path comes from `CLAUDE_CODE_EXECUTABLE` if it is set (`src/acp-agent.ts` around lines 1974 and 11013). Its login method runs `claude auth login --claudeai`, which is Anthropic's own flow.

## C. Agent Client Protocol (ACP)

Sources: [spec repo](https://github.com/agentclientprotocol/agent-client-protocol), [TypeScript SDK](https://github.com/agentclientprotocol/typescript-sdk), [registry](https://github.com/agentclientprotocol/registry).

- **Versions:** v1 is the stable wire protocol. Schema release 1.12.0 came out on 2026-10-16. **v2 is a draft.** The TypeScript SDK package is `@agentclientprotocol/sdk`.
- **Maintainers:** Zed and JetBrains.
- **Adapters:**
  - `@agentclientprotocol/claude-agent-acp`, built on the Agent SDK.
  - `@agentclientprotocol/codex-acp`, which uses the Codex app-server.
  - **Native support:** Gemini CLI, OpenCode, Copilot CLI, Cursor, Goose and others.
- **Models:** the `configOptions` field in the `session/new` response holds a `select` option with category `model`. The model is changed with `session/set_config_option`. The Claude adapter fills this list from `supportedModels()`.
- **Sessions:** `session/request_permission` carries the options `allow_once`, `allow_always`, `reject_once` and `reject_always`. MCP servers are passed through in the `mcpServers` field of `session/new`. A single connection can run several sessions at once, and the protocol has `session/list`, `session/resume` and `session/close`.
- **Gaps:** ACP has nothing for subscription quota. Per-turn token usage is still in the unstable schema.

## D. Models, quota and credits

- **Models:**
  - The Claude Agent SDK has `supportedModels()`.
  - The Anthropic Models API (`GET /v1/models`, which needs an API key) returns IDs, lifecycle and capabilities.
  - Claude Code aliases such as `opus` and `sonnet` follow the latest version.
- **Claude quota:**
  - **What exists:** the SDK `rate_limit_event` reports `utilization` for the five_hour and seven_day windows. The statusline JSON has `rate_limits.five_hour` and `rate_limits.seven_day`.
  - **With a setup-token:** the usage endpoint needs `user:profile` and returns 403 (anthropics/claude-code#22450, #81015; the latter closed as not planned). Responses still carry the undocumented `anthropic-ratelimit-unified-5h` and `-7d` headers.
  - Whether `rate_limit_event` is sent under a setup-token is **unconfirmed**, which is why spike S1 exists.
- **Codex:**
  - `codex exec --json` gives token usage per turn.
  - The **app-server** provides `model/list` and `account/rateLimits/read`. The latter returns the primary and secondary windows, `usedPercent` and `resetsAt`.
  - `codex login --with-api-key` is available for headless use.
- **API credits for Max subscribers:**
  - Max 20x includes **$200 a month** of API credit. It is claimed by linking a Console organisation, and it expires each billing cycle.
  - It covers the API, the Agent SDK and `claude -p` run with an API key. It does **not** cover interactive Claude Code ([source](https://platform.claude.com/docs/en/about-claude/api-credits-for-subscribers)).
  - There is no documented balance endpoint.
  - The Admin API (`cost_report`, `usage_report/messages`) needs an admin key and is unavailable for individual accounts ([source](https://platform.claude.com/docs/en/manage-claude/usage-cost-api)).

## E. Alternatives considered

| Option | Why it was not chosen |
|---|---|
| AgentTeams (AgentScope) | The closest match to the "company" concept, but it has no budgets |
| Gas Town | Coding only, with no budgets |
| Kandev | A kanban for coding agents. Its "Office mode", which adds budgets and roles, is still in progress |
| OpenAI Symphony | Tied to Linear tickets, and described as a preview |
| Forking Paperclip | Too costly to keep in sync at its pace of change, and its core rules conflict with points 1, 2 and 6 |
| Paperclip plugins | Possible for points 4, 5, 7 and 8, but impossible for budget enforcement and for real workflows |
