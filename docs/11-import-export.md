# 11 — Company import and export

Status: built, all five steps (export, import of Boss Man packages, Settings → Import and export, the Agent Companies adapter, and the Paperclip tickets and documents adapter). Owner asked for a general tool, not a one-off migration (24 Oct 2026).

## Goal

Move a company in or out of Boss Man as one file. That covers:

- a backup of the company's set-up;
- a copy to another Boss Man;
- a company template;
- arriving from another tool, starting with Paperclip's "Agent Companies" export.

Other tools are read through **adapters** that turn their format into Boss Man's package. The importer itself knows only Boss Man's package. Other tools' formats are ideas only: we read their files, but we copy none of their code.

## What a package holds

A zip, `<company-slug>.bossman.zip`, with a `manifest.json` (`format: "bossman-company/1"`, the Boss Man version, export time, and which optional parts are included).

| Part | Files | Always? |
|---|---|---|
| Company | `company.json`: name, mission, review policy, goal-check interval, whether the owner approves engagements, ticket prefix, standing rules, and whether the watchdog is on | yes |
| Agents | `agents/<slug>/agent.json` (name, role, title, template, duty, reports-to, agent kind, model) and `agents/<slug>/INSTRUCTIONS.md`, plus `avatar.*` if uploaded | yes |
| Skills | `skills/<name>/…`, the full folder as stored, plus `skills.json` (source, pin, pack, and which agents have each skill) | yes |
| Projects | `projects/<slug>/project.json`: repo URL, default branch, checks, landing, caps, columns, review-policy override | yes |
| Plan | `plan.json`: objectives, key results, milestones, features | yes |
| Tool servers | `tool-servers.json`: URL, transport, and the **name** of the secret holding the token | yes |
| Secrets | `secrets.json`: **names and grants only, never values** | yes |
| Deploy targets | `deploy-targets.json`: name, kind, endpoint, production flag, "needs approval", and the **names** of the secrets granted to each target (BOS-2169). Never the deploy history. The host's own staging target is left out (the host makes it) | yes |
| Permission rules | `permission-rules.json`: the company's **own** rules only (never the ones for every company), in order, with agents named by name (BOS-2169) | yes |
| Wiki | `wiki/<folder>/<page>.md`: frontmatter carries the slug, title and source ticket | optional |
| Tickets | `tickets.jsonl`: one per line, with parent, dependencies, state, assignee (by agent slug) and conversation | optional: none, open only, or all |

On import (BOS-2169), deploy targets and rules are created in the new company, and the checklist lists what changed:

- A rule that was **Allow** or **Ask the CEO** comes in as **Ask me**: "Rule X was Allow in the export; it asks you now. Change it back in Settings → Rules if you trust it." A package can't hand out permissions, and an imported CEO rule would take destructive requests and pushes away from you. Deny and Ask me rules keep their outcome, and the order is kept. A rule's condition must be one the rule form can set (tool kinds, command or title pattern, safe-only, scratch-only, agents); a rule with other conditions or wrong values is skipped and listed.
- A rule that names agents is pointed at the new company's agents by name. A name that isn't there is dropped from the rule and listed; a rule left with no agent is not imported (it is never widened to every agent).
- A deploy target's endpoint goes through the same check as the deploy target form (`endpointProblem`); one that fails is skipped and listed. A target's live tag is not carried (saving one needs a runner); the checklist says to set it again.
- Secrets granted to a target are listed like company-wide ones ("Add the secret X and grant it as ENV to deploy target T"): no secret is created, and values are entered again.
- A package made before this change has neither file and imports as before.

Never exported: secret values, owner login and sessions, runs and transcripts, costs and quota samples, funding-source credentials, run tokens, and the activity log.

## Import

1. **Read and check (no writes).** Size caps and safe paths inside the zip. Every skill passes the existing skill checks (name rule, file and byte limits).
2. **Preview.** Lists what will be created, and flags the following:
   - name clashes with existing agents, skills or projects;
   - skills that ship scripts (listed per file);
   - secrets the owner must fill in;
   - models the runner doesn't offer;
   - agents with no funding source.
3. **Mapping.** The owner picks a runner, a funding source and a model per agent where needed, and chooses how to handle each clash (rename, skip, or replace).
4. **Apply** in one transaction. IDs are new. Ticket IDs from the source are kept in each ticket's body as `Imported from <ID>`, so references like "HOL-228" still resolve by search.
5. **Afterwards:**
   - every imported agent starts **paused**;
   - no secret is created or granted: the secret store has no empty values, and the package must not be able to point an agent at an existing secret. The checklist names each secret, its variable and the agents to grant it to;
   - a checklist decision lists what's left: secrets, funding, unpausing, skills that ship scripts.

As built (step 2): an import always creates a **new** company, so the only clash is the company name (the preview flags it and the owner picks another). Merging into an existing company is not supported. One funding source can be given to every agent at import; models are checked after import, once the new company's runner has started. Review policies that name an agent are pointed at the imported copy of that agent; an agent the package doesn't hold becomes the CEO, and is dropped from a list of reviewers (the CEO when none is left). An older package's "marked" reviewer cells name the package's agents marked for that kind (BOS-198); exports no longer carry the mark.

API: `POST /api/companies/import/preview` and `POST /api/companies/import`, body `{ zip: <base64>, name?, fundingSourceId?, allowStackServices? }`. The preview lists each tool server and each project git address the runner's network guard would open, flagging any that reach a private address or Boss Man's own services; the import refuses those unless `allowStackServices` is set (the owner ticking the box), and the tick is kept per server and per project so the guard doesn't drop it later (BOS-708).

The importer treats a package as untrusted. Instructions and skills are shown before anything is applied. Nothing in the package can grant itself a secret value or start work.

## Adapters

### Agent Companies (Paperclip's company export)

The spec at agentcompanies.io is **not yet read**. This mapping comes from a real export: `COMPANY.md`, `agents/*/AGENTS.md`, `projects/*/PROJECT.md`, `skills/**/SKILL.md`, `.paperclip.yaml`.

| Theirs | Boss Man |
|---|---|
| `COMPANY.md` name | company name |
| `AGENTS.md` frontmatter: name, title, `reportsTo`, `skills:` list; body | agent and instructions; skills given by leaf name |
| `.paperclip.yaml` `adapter.type`: `claude_local`, `opencode_local`, `codex_local` | agent kind: `claude`, `opencode`, `codex` (any other type becomes `claude`, noted in the preview) |
| `adapter.config.model` | model (checked against the runner) |
| `role`: ceo, engineer, qa, pm, researcher, designer, writer | role, plus the closest template |
| `role`: knowledge-maintainer | a worker with the wiki duty |
| `inputs.env` with `kind: secret` | secret placeholder, granted to that agent |
| `projects.*.workspaces.repo.repoUrl` and `defaultRef` | project repo and branch |
| `heartbeat`, `permissions`, `appearance` | dropped: Boss Man wakes on events, and only the CEO hires |
| skills that call the Paperclip API (`paperclip`, the operations skills, the LLM Wiki plugin skills) | left out, and listed in the preview's notes ("Boss Man has its own tools for that"). |
| a skill with no name, or a name breaking the rule | renamed from its folder, shown in the preview |
| two skills with the same folder name (e.g. the company's own `seo-audit` and a pack's) | the company's own keeps the name; the other gets its source in front (`claude-seo-seo-audit`), noted in the preview |
| `PROJECT.md` description | a wiki page, `Imported/<project>` (Boss Man projects have no description field) |
| `dogfood`, `agent-browser` skills | `requires_addons: ["agent-browser"]` (docs/12) |

As built (step 4): the adapter (`apps/server/src/services/import-agent-companies.ts`) writes the files of a Boss Man package, so the importer's own checks and preview apply unchanged. A zip whose files sit under one top folder is accepted, and a Mac's `__MACOSX/` and `.DS_Store` files are ignored. YAML is read with the `yaml` package (2.9.1, ISC, no dependencies). Tested on a fixture written for the test; tried once on the owner's own export outside the repo.

### Paperclip tickets and documents

Paperclip's company export carries no issues. Its issues, comments and issue documents live in its database. We document a **read-only** query that produces one JSON file: identifier, title, status, parent, project, description, comments, documents. The adapter maps it as follows:

- issue → ticket (status: `backlog` → backlog, `todo` → ready, `in_progress` → in progress, `in_review` → review, `blocked` → blocked, `done` → done, `cancelled` → cancelled);
- comment → ticket message, author kept as text;
- issue document → wiki page under `Imported/<identifier>/<key>`, linked from the ticket, keeping the latest body only. The repeated `continuation-summary` documents are skipped.

As built (step 5): `paperclip-issues.json` goes next to `COMPANY.md` in the Agent Companies export, and the adapter turns it into `tickets.jsonl` and wiki pages. `cancelled` arrives as done with an outcome, issues with no project go to an "Imported tickets" project, and a document over the page limit is split into parts. The query and the steps are in docs/14-paperclip-migration.md.

## Export

- In the UI: Settings → **Import and export**, with a tick box for the wiki and a choice of tickets (none, open or all). Import is on the same tab.
- Over the API: `GET /api/companies/:id/export?wiki=1&tickets=open`. It's read-only, so a standby server can serve it too.

## Build order (one PR each)

1. Package writer and export endpoint. Test: export a seeded company, then check the file list and that no secret value appears.
2. Package reader, preview and apply for Boss Man packages. Test: export, import into an empty Boss Man, and compare.
3. Export and import in the UI.
4. Agent Companies adapter, tested on a fixture written from the observed layout (no Paperclip files copied).
5. Paperclip tickets-and-documents adapter, plus a docs page with the read-only query.
