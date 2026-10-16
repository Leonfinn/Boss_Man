# 03 — Phased plan

Each phase ends with a working build that has tests. The phases deal with the riskiest work first. Sizes are relative guesses (S/M/L), not commitments.

## Phase 0: spikes (settle the unknowns before building on them)

| Spike | Question | Pass condition | If it fails |
|---|---|---|---|
| **S1** Claude quota (S) | Is `rate_limit_event` (the 5-hour and 7-day `utilization` figures) sent when Claude Code authenticates with a `claude setup-token` token? | The SDK or ACP stream reports window percentages on a Max plan account | The quota display shows estimates and moves to v1.1. We do not depend on the undocumented `anthropic-ratelimit-unified-*` headers |
| **S2** ACP in a container (M). **Stub run passed 2026-10-16; real-model run outstanding** ([results](../spikes/s2-acp/README.md)) | Can a headless runner start several concurrent `claude-agent-acp` and `codex-acp` sessions, list models through `configOptions`, answer `session/request_permission` by policy, and pass Boss Man's MCP server through `mcpServers`? | 3 or more concurrent sessions per agent kind, model lists filled, permissions answered automatically, MCP tools called | Fall back to driving the Claude Agent SDK and `codex app-server` directly behind a common interface |
| **S3** Credit tracking (S) | With a Console organisation and admin key, does `cost_report` show the spend made with the API key, and how quickly? | Spend appears within a few minutes, matching runs | Estimate from run `total_cost_usd` and label it as an estimate |

### Follow-ups from S2
- Write a minimal seccomp profile that allows user namespaces, for Codex's sandbox in runner containers.
- Propose a `codex-acp` mode upstream with full access but approvals routed to the user. With it, the container could be the sandbox.
- Run S2 against real models with the owner's credentials.

## v1 build phases

1. **Foundation (M)**
   - Monorepo, CI with lint, typecheck and tests, and a Compose stack.
   - Postgres schema and migrations.
   - Owner authentication.
   - **Secrets store with grants (data model and API).**
   - The runner image (Claude Code, the ACP adapters, the runner daemon) and the protocol between runner and server.
2. **Agent execution (L)**
   - ACP session lifecycle, event streaming and run logs.
   - Model lists from `configOptions`, plus the free-text override.
   - Permission requests routed to the policy engine.
   - Boss Man's MCP server and tools.
   - Run cost estimates.
   - Claude credentials: setup-token injection and the in-runner terminal login.
3. **Work management (L)**
   - Companies, plus onboarding that creates a **real CEO**.
   - Projects and tickets, with system states and mapped columns: the kanban with custom fields and swimlanes.
   - Objectives, key results and milestones.
   - Ticket dependencies.
   - Scheduled and event-driven agent wake-ups.
4. **Decision queue (M)**
   - `raise_decision` with a required recommended answer, and the ranking score.
   - The queue UI with answering in place.
   - The stale-blocker sweep.
   - Default rules for the decision tiers, including production deploys going to the owner.
5. **Engagements and deploy targets (M)**
   - The engagement lifecycle, the thread, and engagements as blockers.
   - Charging costs back to the requesting project, with a cap.
   - Deploy targets (socket proxy, SSH, git) with granted credentials.
6. **Budgets (M)**
   - Funding sources and budget policies (billing-cycle, monthly and lifetime windows; soft and hard limits).
   - The Admin API cost-report poller.
   - Pausing a scope when its hard limit is reached.

**v1 is done when Boss Man can build itself.** At that point:
- A "Boss Man" company with a CEO and engineer agents takes over the remaining backlog.
- A "Homelab" company deploys Boss Man upgrades through an engagement.
- The owner works only from the decision queue.

Until then, development continues in Claude Code, with Paperclip still in use for existing work.

## v1.1
- Roadmap view: a milestone timeline grouped by objective and company.
- Plan view: a dependency graph with blocked chains highlighted.
- Configurable CEO decision rules.
- Quota display, if S1 passes.
- Secrets management screen: rotation, grants, and the access log.

## Later
- **Paperclip importer**, via Paperclip's company export (`server/src/services/company-portability.ts` upstream).
- **More ACP agents:** Gemini CLI, OpenCode, Copilot CLI and others.
- **Review before any public release:**
  - Anthropic policy on subscription credentials.
  - The Claude Code licence. Claude Code is "© Anthropic PBC. All rights reserved. Use is subject to Anthropic's Commercial Terms", so publish the Dockerfile and **not** images that contain it.
  - Multiple users.
  - Security hardening.

## Risks

| Risk | Mitigation |
|---|---|
| ACP v2 redesign and churn; adapters lag | Use stable v1 only. Keep adapter versions pinned in the image and upgrade on rebuild. Keep the S2 fallback interface |
| Anthropic changes its policy on subscription use, or limits automation | Keep the API-key path a first-class option. Keep Claude Code unmodified and the owner's own credentials. Re-check before any release |
| Quota data unavailable or undocumented | Spike S1 first. Label estimates as estimates. Never block work on quota data |
| Agents with production access make mistakes | Production deploys go to the owner. Use a socket proxy or GitOps. Audit every use of a secret |
| Scope creep and solo maintenance | v1 is kept deliberately small. Boss Man takes over its own backlog after v1 |
| Claude Code redistribution | Publish the Dockerfile only. Users build the image, which installs Claude Code with Anthropic's own installer |
