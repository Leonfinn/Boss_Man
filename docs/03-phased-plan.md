# 03 — Phased plan

Each phase ends with a working build that has tests. The phases deal with the riskiest work first. Sizes are relative guesses (S/M/L), not commitments.

## Status (16 Oct 2026)

| Step | Status |
|---|---|
| Spikes S1–S3 | Answered. Quota windows are visible under a setup-token. There is no Admin API on an individual account, so credit is tracked from Boss Man's own run costs. |
| 1 Foundation | Merged (#2). It reached `main` through #3. |
| 2 Agent execution | Merged (#3). |
| 3 Work management and scheduler | Merged (#4). |
| 4 Decision queue | Merged (#5): ranked queue, stale-blocker sweep and stalled-run rows. The queue UI isn't built. |
| 5 Engagements and deploy targets | Merged (#6, #8): counter, owner approval, deliver, sign-off, credential guard, charge-back cap. Production deploys go to the owner, and target secrets reach only the approved deploy run. |
| 6 Budgets | Mostly built early with credit tracking: funding sources, billing cycles, quota samples, budgets that pause, fail-closed admission. Instance-wide, project and per-ticket caps are in review (#19). Still to do: alert-once hygiene (R34). |
| Runs: steering, recovery, workspaces | Merged: steering messages (#11), resume after a crash (#12, #13), one scheduler pass at a time (#14), a git worktree per ticket (#15). |
| Review, merge, loop guards | In review: diffs and line comments (#17), verify then merge (#18), review-loop, circular-failure and spend caps (#19). |
| Safety | In review: untrusted-content labels (R51), the image canary with promote and rollback (R52), workspace clean-up and disk caps (R54). |
| Web UI | In review: login and first-run setup, the decision queue, the board and funding, built from the canvas designs with the owner's artwork. Browser notifications for new decisions while no tab is visible (R44), polling only so a tab can't hold agents up (R43), and a login lockout and strict content security policy (R45). Still to do: engagement and run screens, a virtualised run transcript, and WebSocket `Origin` checks once the browser uses WebSockets. |
| Production runner image | Merged (#9): Claude Code from npm, a non-root user, volumes for workspaces, the journal and Claude's transcripts, and a healthcheck. CI builds it and runs the canary in it with networking off. |

## Phase 0: spikes (settle the unknowns before building on them)

| Spike | Question | Pass condition | If it fails |
|---|---|---|---|
| **S1** Claude quota (S). **Largely answered by S2:** under a setup-token, ACP `usage_update._meta["_claude/rateLimit"]` carries the 5-hour and 7-day utilisation, reset times and overage state | Is `rate_limit_event` (the 5-hour and 7-day `utilization` figures) sent when Claude Code authenticates with a `claude setup-token` token? | The SDK or ACP stream reports window percentages on a Max plan account | The quota display shows estimates and moves to v1.1. We do not depend on the undocumented `anthropic-ratelimit-unified-*` headers |
| **S2** ACP in a container (M). **Claude passed against the real model and Codex passed with a stub, 2026-10-16** ([results](../spikes/s2-acp/README.md)) | Can a headless runner start several concurrent `claude-agent-acp` and `codex-acp` sessions, list models through `configOptions`, answer `session/request_permission` by policy, and pass Boss Man's MCP server through `mcpServers`? | 3 or more concurrent sessions per agent kind, model lists filled, permissions answered automatically, MCP tools called | Fall back to driving the Claude Agent SDK and `codex app-server` directly behind a common interface |
| **S3** Credit tracking (S). **Answered 2026-10-16: not available on an individual account.** A workspace API key gets `authentication_error: The Admin API requires an Admin API key or an organization-scoped API key`, and the Admin keys page returns 404. v1 uses the fallback | With a Console organisation and admin key, does `cost_report` show the spend made with the API key, and how quickly? | Spend appears within a few minutes, matching runs | Estimate from run `total_cost_usd` and label it as an estimate |

### Follow-ups from S2
- Write a minimal seccomp profile that allows user namespaces, for Codex's sandbox in runner containers. Kandev's syscall list is the starting point (see 02-architecture). Verify it with our own probe.
- Check whether codex-acp 2.2.2's `agent-full-access` mode still sends approvals to the client. If it does, the container could act as the sandbox.
- Confirm whether `usage_update.cost` is cumulative across a session's turns. Spike S2 ran only one turn per session.
- Measure how long Boss Man's HTTP MCP server takes to start on the first turn under Claude Code.
- Propose a `codex-acp` mode upstream with full access but approvals routed to the user. With it, the container could be the sandbox.
- Run S2 for Codex against the real model.
- Confirm how the `_claude/rateLimit` utilisation is scaled (0–1 or %) across a few readings below 100%.

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
   - Scheduled and event-driven agent wake-ups, **with the launch safety in R30 in place before the first event-driven wake-up**.
4. **Decision queue (M)**
   - `raise_decision` with a required recommended answer, and the ranking score.
   - The queue UI with answering in place.
   - Rows for stalled runs (R32).
   - The stale-blocker sweep.
   - Default rules for the decision tiers, including production deploys going to the owner.
5. **Engagements and deploy targets (M)**
   - The engagement lifecycle, the thread, and engagements as blockers.
   - Charging costs back to the requesting project, with a cap.
   - Deploy targets (socket proxy, SSH, git) with granted credentials.
6. **Budgets (M)**
   - Funding sources and budget policies (billing-cycle, monthly and lifetime windows; soft and hard limits).
   - API-credit spend from Boss Man's own run records. The Admin API isn't available on an individual Console account (S3). A cost-report poller only becomes possible if the owner later moves to a Console organisation.
   - Quota windows from `_claude/rateLimit` (S1 passed, so this is v1 rather than v1.1), with the scheduler holding low-priority work while a window is full.
   - Pausing a scope when its hard limit is reached.

**v1 is done when Boss Man can build itself.** At that point:
- A "Boss Man" company with a CEO and engineer agents takes over the remaining backlog.
- A "Homelab" company deploys Boss Man upgrades through an engagement.
- The owner works only from the decision queue.

Until then, development continues in Claude Code, with Paperclip still in use for existing work.

## Added after the Cline kanban review (2026-10-16)
These sit between the budget work and the self-hosting milestone:
1. **Spike S4 (S):** does `session/load` on `claude-agent-acp` and `codex-acp` resume a session that crashed mid-tool-call? If it doesn't, restart with a summary (R42).
2. **Steer and stop (S):** an owner and MCP path to `session/prompt` and `session/cancel`, and a visible "not delivered" state for permission verdicts (R37, R22).
3. **Git workspaces (M):** worktrees on their own branches, from pinned bases, with patch save and restore and an allowlist for provisioning (R38).
4. **Review (M):** a diff against the base, line comments to the agent, and commit and PR prompt templates (R39). Last-turn checkpoints follow in v1.1.
5. **Web UI (L):** built to R43–R45 from the start, using the screens on the design canvas and the artwork in `assets/brand/`.

## Added after the Nimbalyst and Aperant reviews (2026-10-16)
1. **Merge (M):** merge-tree preview, a resolver agent, and merge closing the ticket (R46). Verify commands before done (R47).
2. **Loop guards (S):**
   - review rounds (R49);
   - circular-fix detection (R50);
   - a per-ticket cost ceiling and an instance-wide cap (R53).
3. **Safety (S):**
   - untrusted-content labels (R51);
   - an image canary before a rebuilt runner image is used (R52);
   - workspace clean-up and disk caps (R54).
4. **v1.1:** risk tiers (R48), the notification ladder (R44), CEO chapters, and graded planning.

## v1.1
- Plan-first tickets (R40) and last-turn diffs from checkpoints (R39).
- An owner chat that turns plain language into tickets and links, with board tools only.
- Roadmap view: a milestone timeline grouped by objective and company.
- Plan view: a dependency graph with blocked chains highlighted.
- Configurable CEO decision rules.
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
