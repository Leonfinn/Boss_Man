# 11 — Company import and export

Status: design, not built. Owner asked for a general tool, not a one-off migration (24 Oct 2026).

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
| Company | `company.json`: name, review policy, notification and quiet-hours settings, rules | yes |
| Agents | `agents/<slug>/agent.json` (name, role, title, template, duty, reports-to, agent kind, model) and `agents/<slug>/INSTRUCTIONS.md`, plus `avatar.*` if uploaded | yes |
| Skills | `skills/<name>/…`, the full folder as stored, plus `skills.json` (source, pin, pack, and which agents have each skill) | yes |
| Projects | `projects/<slug>/project.json`: repo URL, default branch, checks, landing, caps, columns, review-policy override | yes |
| Plan | `plan.json`: objectives, key results, milestones, features | yes |
| Tool servers | `tool-servers.json`: URL, transport, and the **name** of the secret holding the token | yes |
| Secrets | `secrets.json`: **names and grants only, never values** | yes |
| Wiki | `wiki/<folder>/<page>.md`: frontmatter carries the slug, title and source ticket | optional |
| Tickets | `tickets.jsonl`: one per line, with parent, dependencies, state, assignee (by agent slug) and conversation | optional: none, open only, or all |

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
   - each secret is an empty placeholder already granted to the right agents;
   - a checklist decision lists what's left: secret values, unpausing, skills flagged in the preview.

The importer treats a package as untrusted. Instructions and skills are shown before anything is applied. Nothing in the package can grant itself a secret value or start work.

## Adapters

### Agent Companies (Paperclip's company export)

The spec at agentcompanies.io is **not yet read**. This mapping comes from a real export: `COMPANY.md`, `agents/*/AGENTS.md`, `projects/*/PROJECT.md`, `skills/**/SKILL.md`, `.paperclip.yaml`.

| Theirs | Boss Man |
|---|---|
| `COMPANY.md` name | company name |
| `AGENTS.md` frontmatter: name, title, `reportsTo`, `skills:` list; body | agent and instructions; skills given by leaf name |
| `.paperclip.yaml` `adapter.type`: `claude_local`, `opencode_local` | agent kind: `claude`, `opencode` |
| `adapter.config.model` | model (checked against the runner) |
| `role`: CEO, engineer, qa, pm, researcher | role, plus the closest template |
| `inputs.env` with `kind: secret` | secret placeholder, granted to that agent |
| `projects.*.workspaces.repo.repoUrl` and `defaultRef` | project repo and branch |
| `heartbeat`, `permissions`, `appearance` | dropped: Boss Man wakes on events, and only the CEO hires |
| skills that call the Paperclip API (`paperclip`, the operations skills, the LLM Wiki plugin skills) | flagged in the preview as "replaced by Boss Man". Unticked by default. |
| a skill with no name, or a name breaking the rule | renamed from its folder, shown in the preview |

### Paperclip tickets and documents

Paperclip's company export carries no issues. Its issues, comments and issue documents live in its database. We document a **read-only** query that produces one JSON file: identifier, title, status, parent, project, description, comments, documents. The adapter maps it as follows:

- issue → ticket (status: `backlog` → backlog, `todo` → ready, `in_progress` → in progress, `in_review` → review, `blocked` → blocked, `done` → done, `cancelled` → cancelled);
- comment → ticket message, author kept as text;
- issue document → wiki page under `Imported/<identifier>/<key>`, linked from the ticket, keeping the latest body only. The repeated `continuation-summary` documents are skipped.

## Export

- In the UI: Settings → company → **Export**, with tick boxes for wiki and tickets (none, open or all).
- Over the API: `GET /api/companies/:id/export?wiki=1&tickets=open`. It's read-only, so a standby server can serve it too.

## Build order (one PR each)

1. Package writer and export endpoint. Test: export a seeded company, then check the file list and that no secret value appears.
2. Package reader, preview and apply for Boss Man packages. Test: export, import into an empty Boss Man, and compare.
3. Export and import in the UI.
4. Agent Companies adapter, tested on a fixture written from the observed layout (no Paperclip files copied).
5. Paperclip tickets-and-documents adapter, plus a docs page with the read-only query.
