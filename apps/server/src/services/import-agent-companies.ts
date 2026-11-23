// Agent Companies adapter (docs/11, step 4): turns a company exported as "agentcompanies/v1"
// (Paperclip's export: COMPANY.md, agents/*/AGENTS.md, projects/*/PROJECT.md, skills/**/SKILL.md
// and .paperclip.yaml) into the files of a Boss Man package. The importer then checks and applies
// it like any other package. Written from an observed export; no code or files are copied.
import { strFromU8, strToU8 } from "fflate";
import { parse as parseYaml } from "yaml";
import { DEFAULT_COLUMNS, findCredential, repoUrlAllowed } from "@boss-man/shared";
import { EXPORT_FORMAT } from "./company-export.js";
import { skillName } from "./skills.js";

/** Skills that drive Paperclip's own API: Boss Man has its own tools for these. */
const REPLACED = [/^paperclipai\/paperclip\//, /^paperclipai\/bundled\/paperclip-operations\//, /^plugin\/paperclipai-plugin-llm-wiki\//];
/** Skills known to need a runner add-on (docs/12). */
const NEEDS_ADDON: Record<string, string[]> = { dogfood: ["agent-browser"], "agent-browser": ["agent-browser"] };
const KIND: Record<string, string> = { claude_local: "claude", opencode_local: "opencode", codex_local: "codex" };
const TEMPLATE: Record<string, string> = { engineer: "engineer", researcher: "researcher", qa: "qa", pm: "product-manager", designer: "designer", writer: "writer" };
/** The import's own rule for a secret name (company-import.ts's Secret). */
const SECRET_NAME = /^[A-Z][A-Z0-9_]{0,63}$/;

/**
 * The import's own length limits (company-import.ts): a field over one is split or moved to a wiki page here, so the zip
 * this adapter makes never fails the importer's check. TEXT is a little under the 100,000 limit to leave room for a
 * "part 1 of 3" line or a note, and for the "Imported from" line the importer adds to a body.
 */
const TEXT = 99_000;
const PAGE = 190_000; // a wiki page holds at most 200,000 characters
const cut = (s: string | null, max: number) => (s && s.length > max ? `${s.slice(0, max - 1)}…` : s);

type Files = Map<string, Uint8Array>;
type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : {});
const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);

/** The frontmatter and body of a markdown file; bad YAML reads as no frontmatter. */
function frontmatter(text: string): { meta: Obj; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text.replace(/^﻿/, ""));
  if (!m) return { meta: {}, body: text };
  try {
    return { meta: obj(parseYaml(m[1]!)), body: m[2]! };
  } catch {
    return { meta: {}, body: m[2]! };
  }
}

/** True when the files look like an Agent Companies export rather than a Boss Man package. */
export function isAgentCompanies(files: Files) {
  return !files.has("manifest.json") && files.has("COMPANY.md");
}

/** The Boss Man package files for an Agent Companies export, and what the owner should know. */
export function fromAgentCompanies(files: Files): { files: Files; notes: string[] } {
  const text = (p: string) => (files.has(p) ? strFromU8(files.get(p)!) : null);
  const out: Files = new Map(); // lost on restart, harmless because it lives only for this one import call.
  const notes: string[] = [];
  const json = (p: string, v: unknown) => out.set(p, strToU8(`${JSON.stringify(v, null, 2)}\n`));
  let config: Obj = {};
  try {
    config = obj(parseYaml(text(".paperclip.yaml") ?? ""));
  } catch {
    notes.push(".paperclip.yaml couldn't be read, so models, roles, secrets and repos were left out.");
  }
  const agentCfg = obj(config.agents);
  const projectCfg = obj(config.projects);

  const company = frontmatter(text("COMPANY.md")!);
  json("manifest.json", { format: EXPORT_FORMAT, from: str(company.meta.schema) ?? "agentcompanies" });
  const missionFull = str(company.body);
  const mission = fitWithPage(out, missionFull, 2000, "imported/company-description", "Company description (imported)", "Imported");
  if (mission !== missionFull) notes.push("The company description was over 2,000 characters; its start is the mission and the full text is on the wiki page imported/company-description.");
  json("company.json", { name: cut(str(company.meta.name), 80) ?? "Imported company", mission });

  // Skills: one per folder holding a SKILL.md, keyed by its path under skills/ (as AGENTS.md refers to them).
  const dirs = [...files.keys()].filter((p) => p.startsWith("skills/") && p.endsWith("/SKILL.md")).map((p) => p.slice("skills/".length, -"/SKILL.md".length));
  const replaced = dirs.filter((d) => REPLACED.some((r) => r.test(`${d}/`)));
  if (replaced.length) notes.push(`Left out ${replaced.length} skills that drive Paperclip itself, since Boss Man has its own tools for that: ${replaced.map((d) => d.split("/").at(-1)).join(", ")}.`);
  const names = new Map<string, string>(); // folder → Boss Man name. lost on restart, harmless: one import call.
  const kept = dirs.filter((d) => !replaced.includes(d)).sort((a, b) => Number(!a.startsWith("company/")) - Number(!b.startsWith("company/")) || a.localeCompare(b));
  for (const d of kept) {
    const parts = d.split("/");
    let name = skillName(parts.at(-1)!);
    // The company's own skill keeps the plain name; a same-named one from elsewhere gets its source in front.
    if ([...names.values()].includes(name)) {
      name = skillName(`${parts.at(-2)}-${parts.at(-1)}`);
      notes.push(`Two skills are called ${parts.at(-1)}; the one from ${parts.slice(0, -1).join("/")} is imported as ${name}.`);
    }
    names.set(d, name);
    for (const [p, bytes] of files) if (p.startsWith(`skills/${d}/`) && !dirs.some((o) => o !== d && o.startsWith(`${d}/`) && p.startsWith(`skills/${o}/`))) out.set(`skills/${name}/${p.slice(`skills/${d}/`.length)}`, bytes);
  }
  /** AGENTS.md names skills as "owner/repo/…/leaf", "company/<id>/leaf" or "local/<id>/leaf"; the folders drop those ids. */
  const skillFor = (ref: string) => {
    const leaf = ref.split("/").at(-1)!;
    const exact = kept.find((d) => d === ref);
    if (exact) return names.get(exact)!;
    const scope = ref.split("/")[0];
    const match = kept.find((d) => d.split("/").at(-1) === leaf && (scope === "company" || scope === "local" ? d.startsWith(`${scope}/`) : true));
    return match ? names.get(match)! : null;
  };

  // Agents.
  const holders = new Map<string, string[]>(); // skill → agent folders. lost on restart, harmless: one import call.
  const skippedSecrets = new Set<string>(); // lowercase secret names, for one note. lost on restart, harmless: one import call.
  const secrets = new Map<string, string[]>(); // env name → agent folders. lost on restart, harmless: one import call.
  const agentDirs = [...new Set([...files.keys()].filter((p) => /^agents\/[^/]+\/AGENTS\.md$/.test(p)).map((p) => p.split("/")[1]!))].sort();
  const paperclipy: string[] = [];
  for (const slug of agentDirs) {
    const md = frontmatter(text(`agents/${slug}/AGENTS.md`)!);
    // Instructions are kept word for word, so ones written for Paperclip's way of working are pointed out rather than changed.
    if (/\bpaperclip\b|\bheartbeats?\b/i.test(md.body)) paperclipy.push(str(md.meta.name) ?? slug);
    const cfg = obj(agentCfg[slug]);
    const adapter = obj(cfg.adapter);
    const role = str(cfg.role) ?? "";
    const kind = KIND[str(adapter.type) ?? ""];
    if (adapter.type && !kind) notes.push(`${slug} ran on "${String(adapter.type)}", which Boss Man doesn't have; it's set to Claude.`);
    json(`agents/${slug}/agent.json`, {
      name: cut(str(md.meta.name) ?? slug, 80),
      role: role === "ceo" ? "ceo" : "worker",
      title: cut(str(md.meta.title), 120),
      template: TEMPLATE[role] ?? null,
      duty: role === "knowledge-maintainer" ? "wiki" : null,
      agentKind: kind ?? "claude",
      model: str(obj(adapter.config).model),
      reportsTo: str(md.meta.reportsTo),
    });
    const instructions = md.body.trim();
    if (instructions) {
      const fitted = fitWithPage(out, instructions, TEXT, `imported/${slug}-instructions`, `${str(md.meta.name) ?? slug} instructions (imported)`, "Imported");
      if (fitted !== instructions) notes.push(`${str(md.meta.name) ?? slug}'s instructions were over 100,000 characters; the agent has the start and the full text is on the wiki page imported/${slug}-instructions.`);
      out.set(`agents/${slug}/INSTRUCTIONS.md`, strToU8(fitted!));
    }
    // A picture saved beside AGENTS.md comes across as the agent's avatar.
    for (const [p, bytes] of files) {
      const pic = p.startsWith(`agents/${slug}/`) ? /^avatar\.(png|jpe?g|webp)$/i.exec(p.slice(`agents/${slug}/`.length)) : null;
      if (pic) out.set(`agents/${slug}/avatar.${pic[1]!.toLowerCase()}`, bytes);
    }
    const missing: string[] = [];
    for (const ref of Array.isArray(md.meta.skills) ? md.meta.skills.filter((s): s is string => typeof s === "string") : []) {
      if (REPLACED.some((r) => r.test(`${ref}/`))) continue;
      const name = skillFor(ref);
      if (name) holders.set(name, [...(holders.get(name) ?? []), slug]);
      else missing.push(ref.split("/").at(-1)!);
    }
    if (missing.length) notes.push(`${str(md.meta.name) ?? slug} had skills that aren't in the export: ${missing.join(", ")}.`);
    for (const [env, v] of Object.entries(obj(obj(cfg.inputs).env))) {
      if (obj(v).kind !== "secret") continue;
      if (SECRET_NAME.test(env)) secrets.set(env, [...(secrets.get(env) ?? []), slug]);
      else skippedSecrets.add(env);
    }
  }
  if (skippedSecrets.size)
    notes.push(
      `Secret names must be upper case, so these weren't imported: ${[...skippedSecrets]
        .map((n) => {
          const upper = n.toUpperCase();
          if (secrets.has(upper)) return `${n} (already imported as ${upper}: change scripts to read ${upper})`;
          // The upper-case name may still break the rule (a dash, a leading digit); suggest one that doesn't, X before a leading digit.
          const suggested = upper.replace(/[^A-Z0-9_]/g, "_").replace(/^[0-9]/, "X$&").slice(0, 64);
          return SECRET_NAME.test(suggested) ? `${n} (add it as ${suggested})` : `${n} (can't be made valid; rename it before importing)`;
        })
        .join(", ")}. Scripts that read the old name will get an empty value; change them to read the upper-case name.`,
    );
  if (paperclipy.length)
    notes.push(
      `${paperclipy.length === 1 ? "1 agent's instructions describe" : `${paperclipy.length} agents' instructions describe`} working in Paperclip (the paperclip skill, heartbeats, its API or /paperclip paths), which Boss Man doesn't have: ${paperclipy.join(", ")}. After importing, ask your CEO to revise them (it can read and update every agent's instructions), or edit them under Agents.`,
    );
  json(
    "skills.json",
    kept.map((d) => {
      const name = names.get(d)!;
      return { name, source: "upload", requiresAddons: NEEDS_ADDON[name] ?? null, agents: holders.get(name) ?? [] };
    }),
  );
  json(
    "secrets.json",
    [...secrets].map(([envName, agents]) => ({ name: envName, kind: "generic", envName, agents })),
  );

  // Projects: the repo from the primary workspace; the description becomes a wiki page.
  const projectDirs = [...new Set([...files.keys()].filter((p) => /^projects\/[^/]+\/PROJECT\.md$/.test(p)).map((p) => p.split("/")[1]!))].sort();
  for (const slug of projectDirs) {
    const md = frontmatter(text(`projects/${slug}/PROJECT.md`)!);
    const name = str(md.meta.name) ?? slug;
    const spaces = Object.values(obj(obj(projectCfg[slug]).workspaces)).map(obj);
    const repo = spaces.find((w) => w.isPrimary === true) ?? spaces[0];
    let repoUrl = str(repo?.repoUrl);
    if (repoUrl && (!repoUrlAllowed(repoUrl) || findCredential(repoUrl))) {
      notes.push(`${name}'s repo address (${findCredential(repoUrl) ? "it holds a credential" : "Boss Man doesn't accept it"}) was left out; add it on the Projects page.`);
      repoUrl = null;
    }
    json(`projects/${slug}/project.json`, { name: cut(name, 80), repoUrl, defaultBranch: str(repo?.defaultRef) ?? "main", columns: DEFAULT_COLUMNS });
    const about = md.body.trim() || str(md.meta.description);
    if (about) {
      if (about.length <= PAGE) out.set(`wiki/imported/${slug}.md`, strToU8(`---\n${JSON.stringify({ slug: `imported/${slug}`, title: `${name} (imported)`.slice(0, 300), folder: "Imported" })}\n---\n${about}\n`));
      else savePages(out, `imported/${slug}`, `${name} (imported)`, "Imported", about);
    }
  }
  issues(files, out, notes, Object.fromEntries(projectDirs.map((slug) => [str(frontmatter(text(`projects/${slug}/PROJECT.md`)!).meta.name) ?? slug, slug])), agentDirs.map((slug) => [str(frontmatter(text(`agents/${slug}/AGENTS.md`)!).meta.name) ?? slug, slug]));
  return { files: out, notes };
}

/** Paperclip issue states → Boss Man ticket states; "cancelled" has none, so it lands as done with an outcome. */
const STATE: Record<string, string> = { backlog: "backlog", todo: "ready", in_progress: "in_progress", in_review: "review", blocked: "blocked", done: "done", cancelled: "done" };

/** Saves a long text as wiki pages (split at the page limit, so nothing is cut); returns the slugs. */
function savePages(out: Files, slug: string, title: string, folder: string, body: string, ticket?: string): string[] {
  const slugs: string[] = [];
  for (let i = 0; i * PAGE < body.length; i++) {
    const s = i ? `${slug}-${i + 1}` : slug;
    const meta = { slug: s, title: `${title}${i ? ` (part ${i + 1})` : ""}`.slice(0, 300), folder, ...(ticket ? { ticket } : {}) };
    out.set(`wiki/${s}.md`, strToU8(`---\n${JSON.stringify(meta)}\n---\n${body.slice(i * PAGE, (i + 1) * PAGE)}`));
    slugs.push(s);
  }
  return slugs;
}

/** A text over the limit stays whole: its start is kept and the rest is on a wiki page the note points to. */
function fitWithPage(out: Files, text: string | null, max: number, slug: string, title: string, folder: string, ticket?: string): string | null {
  if (!text || text.length <= max) return text;
  const slugs = savePages(out, slug, title, folder, text, ticket);
  return `${text.slice(0, max - 400)}\n\n… (cut here: the full text is on the wiki page${slugs.length > 1 ? "s" : ""} ${slugs.join(", ")})`;
}

/**
 * paperclip-issues.json, made by the read-only query in docs/14-paperclip-migration.md, beside COMPANY.md:
 * issues become tickets, comments their conversation, and each issue document a wiki page linked to its
 * ticket. The repeated continuation summaries are working notes, so they are skipped.
 */
function issues(files: Files, out: Files, notes: string[], projectSlug: Record<string, string>, agentNames: Array<[string, string]>) {
  const raw = files.get("paperclip-issues.json");
  if (!raw) return;
  let list: unknown;
  try {
    list = JSON.parse(strFromU8(raw));
  } catch {
    notes.push("paperclip-issues.json isn't valid JSON, so no tickets were imported.");
    return;
  }
  if (!Array.isArray(list)) return void notes.push("paperclip-issues.json isn't a list of issues, so no tickets were imported.");
  const agentSlug = new Map(agentNames); // lost on restart, harmless: one import call.
  let homeless = 0;
  let skipped = 0;
  const lines: string[] = [];
  for (const it of list.map(obj)) {
    const ref = str(it.identifier);
    if (!ref) continue;
    const projectName = str(it.project);
    const project = projectName ? projectSlug[projectName] : undefined;
    if (!project) homeless++;
    const status = str(it.status) ?? "backlog";
    const conversation = (Array.isArray(it.comments) ? it.comments : []).map(obj).flatMap((c) => {
      const body = str(c.body);
      if (!body) return [];
      const by = str(c.by) ?? "";
      const agent = agentSlug.get(by);
      // A comment with no agent is the owner's, unless Paperclip wrote it itself.
      const author = agent ? "agent" : by === "system" || by === "Summarizer" ? "system" : "owner";
      // A long comment (often a pasted log) becomes consecutive entries, so no text is lost.
      const parts = Math.ceil(body.length / TEXT);
      return Array.from({ length: parts }, (_, i) => ({
        author,
        agent: agent ?? null,
        text: parts > 1 ? `(part ${i + 1} of ${parts})\n\n${body.slice(i * TEXT, (i + 1) * TEXT)}` : body,
        at: str(c.at) ?? undefined,
        ...(author === "system" ? { from: "Paperclip" } : {}),
      }));
    });
    if (conversation.length > 5000) notes.push(`${ref} has ${conversation.length} comments (after splitting long ones); Boss Man keeps 5,000 per ticket, so the import will refuse it.`);
    // A title over 500 characters is shortened and the whole of it goes at the top of the description.
    const fullTitle = str(it.title) ?? ref;
    const title = cut(fullTitle, 500)!;
    const described = fullTitle === title ? str(it.description) : `Full title: ${fullTitle}\n\n${str(it.description) ?? ""}`.trim();
    const body = fitWithPage(out, described, TEXT, `imported/${ref.toLowerCase()}/ticket-description`, `${ref} description`, `Imported/${ref}`, ref);
    if (body !== described) notes.push(`${ref}'s description was over 100,000 characters; the ticket has the start and the full text is on the wiki page imported/${ref.toLowerCase()}/ticket-description.`);
    const longComments = (Array.isArray(it.comments) ? it.comments : []).filter((c) => (str(obj(c).body)?.length ?? 0) > TEXT).length;
    if (longComments) notes.push(`${ref} had ${longComments} comment${longComments > 1 ? "s" : ""} over 100,000 characters; each is split into consecutive entries marked "part 1 of N".`);
    lines.push(
      JSON.stringify({
        ref,
        number: Number(/-(\d{1,9})$/.exec(ref)?.[1]) || null,
        project: project ?? "imported-tickets",
        title,
        body,
        state: STATE[status] ?? "backlog",
        outcome: status === "cancelled" ? "Cancelled in Paperclip." : null,
        parent: str(it.parent),
        createdAt: str(it.created_at) ?? undefined,
        conversation,
      }),
    );
    for (const d of (Array.isArray(it.documents) ? it.documents : []).map(obj)) {
      const key = str(d.key);
      const body = str(d.body);
      if (!key || !body) continue;
      if (key === "continuation-summary") {
        skipped++;
        continue;
      }
      // A page holds at most 200,000 characters, so a longer document is split rather than cut.
      savePages(out, `imported/${ref.toLowerCase()}/${key}`, `${ref} ${str(d.title) ?? key}`, `Imported/${ref}`, body, ref);
    }
  }
  out.set("tickets.jsonl", strToU8(lines.join("\n") + (lines.length ? "\n" : "")));
  // Paperclip's prefix (HOL in HOL-12) carries on, so its references keep pointing at the same tickets.
  const prefixes = list.map((it) => /^([A-Z][A-Z0-9]{0,9})-\d+$/.exec(str(obj(it).identifier) ?? "")?.[1]).filter((p): p is string => !!p);
  const prefix = [...new Set(prefixes)].sort((a, b) => prefixes.filter((p) => p === b).length - prefixes.filter((p) => p === a).length)[0];
  if (prefix) out.set("company.json", strToU8(`${JSON.stringify({ ...JSON.parse(strFromU8(out.get("company.json")!)), ticketPrefix: prefix }, null, 2)}\n`));
  if (homeless) {
    out.set("projects/imported-tickets/project.json", strToU8(JSON.stringify({ name: "Imported tickets", columns: DEFAULT_COLUMNS })));
    notes.push(`${homeless} tickets had no project in Paperclip; they're in a new project, "Imported tickets".`);
  }
  if (skipped) notes.push(`Skipped ${skipped} "continuation-summary" documents: they were Paperclip's working notes between runs.`);
}
