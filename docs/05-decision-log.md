# 05 — Decision log

This is the record of the scoping decisions, made in a grilling session on 2026-10-16. Each entry gives the question and the decision. Notes in *italics* are the owner's own additions.

| # | Question | Decision |
|---|---|---|
| Q1 | Who is it for? | The owner first, built cleanly enough to open-source later. No multi-user or hosted features in v1. |
| Q2 | Keep up with Paperclip? | **No.** It is a different product. Paperclip is the inspiration only. Keeping up with new models and agent tools is a core requirement. *Paperclip's model picker lagged: Opus 5.5 was not selectable.* |
| Q3 | Contracts between companies | A formal engagement: request → accept, reject or counter → work → deliver → sign-off. The thread is the only channel between companies. |
| Q4 | Who pays for engagement work? | Costs are recorded against the provider's runs and charged back to the requester's project, with an optional cap. |
| Q5 | Who decides? | Tiers. CEO agents decide within policy. Escalations go to *a prioritised list showing what each item blocks and its due date. Not a Paperclip-style inbox.* |
| Q6 | "$200 a month" | *The Max plan includes $200 a month of API credit on top of quota.* Both are modelled as funding sources. Tracking quota is wanted if it proves feasible. |
| Q7 | Objectives | OKR-style: an objective, measurable key results, and tickets linked to key results. Unlinked tickets are flagged. |
| Q8 | Customisable kanban | Custom columns that map to fixed system states, plus custom fields, swimlanes and column card limits. |
| Q9 | Where it runs | The Aoostar is the server. It is not exposed at the router. |
| Q10 | How to build it | From scratch. MIT-licensed Paperclip code may be copied, keeping its notice. |
| Q11 | Model lists | Never hard-coded. They come from each agent, with a free-text override. |
| Q12 | Decision queue design | One ranked list, scored on what an item blocks, how urgent it is, and its age. Agents must give a recommended answer. Stale blockers appear in the same list. |
| Q13 | Planning structure | Objective → Milestones (with target dates) → Tickets, and derived due dates. Roadmap and plan views. |
| Q14 | Stack | TypeScript, Node, React, Postgres, and one Docker Compose stack. |
| Q15 | Agent isolation | A runner and secrets for each company. Engagements pass deliverables, never credentials. Production deploys go to the owner. *Wanted: a master secrets store that can be granted to companies.* |
| Q16 | Agent interface | One MCP server for every vendor. No prompts that depend on status names. *Owner's note: run Claude Code inside the container and connect to it.* |
| Q17 | v1 scope | Engagements, the decision queue, objectives and the API-credit budget are in v1. Roadmap and plan views, configurable CEO rules and the quota display are in v1.1. |
| Q18 | Paperclip data | Start fresh. *An importer goes on the roadmap if feasible.* |
| Q19 | Server OS | TrueNAS SCALE (Debian 12, kernel 6.12.15). *The homelab team deploys Docker containers directly onto TrueNAS datasets. **The product must run on any suitable Docker setup.*** |
| Q20 | Agent connection | ACP v1 for every agent, with model lists from `configOptions`. Permissions go through the policy engine. v2 waits until it is stable. |
| Q21 | Quota tracking | Spike S1 first. Codex quota comes from its app-server. API credit is tracked through the Admin API. If S1 fails, quota moves to v1.1. |
| Q22 | Admin API | ~~The owner sets up a Console organisation and a read-only admin key.~~ **Revised 2026-10-16:** the owner's Console account is an individual account, and the Admin API is unavailable for those. v1 tracks API-credit spend from Boss Man's own run records. Setting up an organisation is optional later; whether that affects the Max-linked credit is unconfirmed. |
| Q23 (revised) | Claude in the runner | *The container ships the official Claude Code, and Boss Man connects to it.* The `claude-agent-acp` adapter drives that binary through `CLAUDE_CODE_EXECUTABLE`. The default sign-in is a setup-token. Anthropic's own login inside the runner is the alternative. Boss Man never runs its own Claude login. |
| Q24 | Separate "plain Claude Code" mode | Not needed. The revised Q23 covers it. |
| Q25 | Secrets store | Secrets are owned by the owner and granted to companies by reference. Use is audited and rotation happens once. The data model is in v1; the management screen is in v1.1. |
| Q26 | Deploy targets | Named SSH, Docker or git targets with granted credentials and rules. The docs recommend a socket proxy, GitOps or a restricted SSH user. Never the raw `docker.sock`. |
| Q27 | Licence | Apache-2.0. |
| Q28 | Where the work lives | A new private repo plus a readable page. *Name: **Boss Man**, for now.* |
| Q29 | How it is built | In phases with Claude Code, starting with the spikes. Keep Paperclip until v1 can build itself. |
| Q30 | Ideas from cline/kanban | Adopt its git-worktree, diff-review, steering, notification and web-hardening ideas as R37–R45. Plan-first tickets and the owner chat go to v1.1. Its code is Apache-2.0, but its PTY-based design doesn't fit ACP, so we take ideas rather than code. |
| Q31 | Ideas from Nimbalyst | Adopt the notification ladder, "approve and make this a rule", the spawn-reservation lesson (which found and fixed a scheduler race), private ticket keys in engagements and an instance-wide cap. CEO chapters go to v1.1; packs come later, sandboxed in the runner and signed. Its licence is MIT but its stack differs, so we take ideas only. |
| Q32 | Ideas from Aperant | Adopt a real merge step (R46), verify before done (R47), risk tiers (R48), bounded review loops (R49), circular-fix detection (R50), untrusted-content labels (R51), an image canary (R52), spend ceilings (R53) and workspace clean-up (R54). It is AGPL-3.0, so ideas only, with no code or prompt text copied. |

